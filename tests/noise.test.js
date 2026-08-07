import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { noiseStats, loadJournal } from "../src/journal.js";
import { classifySelfCaused } from "../src/drift.js";
import { factHash } from "../src/hash.js";

const NOW = "2026-07-31T12:00:00.000Z";
const at = (daysAgo) => new Date(new Date(NOW).getTime() - daysAgo * 86400_000).toISOString();
const J = (entries) => ({ entries, malformed: [] });

test("noiseStats: 30-day window, events counted raw (not latest-wins)", () => {
  const s = noiseStats(J([
    { type: "applied", target: "a", at: at(1) },
    { type: "applied", target: "a", at: at(2) },   // same target, still two events
    { type: "rejection", target: "b", at: at(29) },
    { type: "rejection", target: "c", at: at(31) }, // aged out
    { type: "snooze", target: "d", at: at(1) },     // not an accept-rate event
  ]), NOW);
  assert.deepEqual(s, { applies30d: 2, rejections30d: 1, nudgeLevel: "normal" });
});

test("noiseStats quiet rule: rejections >= 3 AND rejections > 2x applies", () => {
  const rej = (n) => Array.from({ length: n }, (_, i) => ({ type: "rejection", target: `r${i}`, at: at(i + 1) }));
  const app = (n) => Array.from({ length: n }, (_, i) => ({ type: "applied", target: `a${i}`, at: at(i + 1) }));
  assert.equal(noiseStats(J(rej(2)), NOW).nudgeLevel, "normal");           // below floor
  assert.equal(noiseStats(J(rej(3)), NOW).nudgeLevel, "quiet");            // 3 > 0
  assert.equal(noiseStats(J([...rej(3), ...app(1)]), NOW).nudgeLevel, "quiet");  // 3 > 2
  assert.equal(noiseStats(J([...rej(4), ...app(2)]), NOW).nudgeLevel, "normal"); // 4 > 4 is false
});

function fact(id, file) {
  const payload = { schema_version: 1, type: "endpoint", attrs: { id } };
  return { id, payload, hash: factHash(payload), provenance: { source: [{ file }] } };
}

test("classifySelfCaused: fact-level attribution, doc edits, dead precision", () => {
  const facts = new Map([
    ["fact:http-endpoints/GET /a", fact("fact:http-endpoints/GET /a", "src/a.js")],
    ["fact:http-endpoints/GET /b", fact("fact:http-endpoints/GET /b", "src/b.js")],
  ]);
  const anchors = [{ id: "x", doc: "docs/x.md", line: 1,
    binds: [{ raw: "fact:http-endpoints/*", wildcard: true, prefix: "fact:http-endpoints/" }] }];
  const regions = [
    { kind: "gen", id: "x.t", doc: "docs/x.md", line: 5, binds: undefined },
    { kind: "gen", id: "y.t", doc: "docs/y.md", line: 3,
      binds: [{ raw: "fact:db-schema/Item", wildcard: false, prefix: null }] },
  ];
  const findings = [
    { id: "x.t", kind: "gen", state: "stale", doc: "docs/x.md", line: 5 },   // bound fact's HASH moved
    { id: "y.t", kind: "gen", state: "tampered", doc: "docs/y.md", line: 3 }, // its DOC changed
    { id: "x", kind: "anchor", state: "dead", doc: "docs/x.md", line: 1,
      missing: ["fact:http-endpoints/DELETE /gone"] },                        // deleted fact IS in the delta
    { id: "z", kind: "slot", state: "clean", doc: "docs/x.md", line: 9 },     // untouched by classifier
  ];
  classifySelfCaused({ findings, anchors, regions, factsById: facts,
    changed: new Set(["src/a.js", "docs/y.md"]),
    changedFactIds: new Set(["fact:http-endpoints/GET /a", "fact:http-endpoints/DELETE /gone"]) });
  assert.equal(findings[0].selfCaused, true, "stale via changed bound fact");
  assert.equal(findings[1].selfCaused, true, "tampered via doc change");
  assert.equal(findings[2].selfCaused, true, "dead via the deleted fact itself");
  assert.equal(findings[3].selfCaused, undefined, "clean findings are not classified");

  // a fact merely LIVING in a changed file is NOT self-caused - fact granularity
  const findings2 = [{ id: "x.t", kind: "gen", state: "stale", doc: "docs/x.md", line: 5 }];
  classifySelfCaused({ findings: findings2, anchors, regions, factsById: facts,
    changed: new Set(["src/a.js"]), changedFactIds: new Set(["fact:config-surface/OTHER"]) });
  assert.equal(findings2[0].selfCaused, false, "no bound fact in the delta = not self-caused");
});

// ---------------------------------------------------------------------------
// The decisions journal is the one file in the repository where a human REVOKES
// a decision, and `loadJournal` has always collected the lines it could not
// parse into `malformed`. Until now the only consumer of that list was
// `keeldocs noise` - an opt-in report nothing in CI invokes - so to `check` an
// unparseable line was a line that had never been written.
//
// The asymmetry is what makes it dangerous. Dropping a line does not lose a
// decision; it silently reinstates the decision that line countermanded. All
// four states below run the real CLI in a real tree and are read from the
// process exit code, because that is the number CI acts on.
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL("../bin/keeldocs.js", import.meta.url));
const TOMB = JSON.stringify({ at: "2026-07-30T09:00:00Z", actor: "alice",
  evidence: "removed in v2 API cleanup", target: "fact:http-endpoints/DELETE /orders", type: "tombstone" });
const REVOKE = JSON.stringify({ at: "2026-08-01T09:00:00Z", actor: "alice", of: "tombstone",
  target: "fact:http-endpoints/DELETE /orders", type: "revoke" });

// A repo whose one anchored section binds a fact that does not exist: dead
// without a journal, intentionally_removed with a tombstone standing.
function journalRepo(t, journalText) {
  const dir = mkdtempSync(join(tmpdir(), "keeldocs-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, ".keeldocs"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "journal-repro", version: "1.0.0" }));
  writeFileSync(join(dir, "docs", "api.md"),
    "# API\n\n<!-- keeldocs:id=api binds=fact:http-endpoints/DELETE /orders -->\n\nThe delete endpoint.\n");
  if (journalText !== null) writeFileSync(join(dir, ".keeldocs", "decisions.jsonl"), journalText);
  return dir;
}

const checkJson = (dir) => {
  const r = spawnSync(process.execPath, [BIN, "check", "--json"],
    { cwd: dir, encoding: "utf8", timeout: 180_000 });
  assert.ok(r.stdout, `check wrote no stdout (status ${r.status}): ${r.stderr?.slice(-400)}`);
  return { status: r.status, stdout: r.stdout, env: JSON.parse(r.stdout.trim().split("\n").pop()) };
};

test("a journal line the reader cannot parse is UNREADABLE, never a silent drop", (t) => {
  // CONTROL (2): the tombstone alone. Suppression must still work, or a fix that
  // simply refuses every journal would pass the gate below on a broken engine.
  const tombOnly = checkJson(journalRepo(t, TOMB + "\n"));
  assert.equal(tombOnly.status, 0, `tombstone alone must stay CLEAN: ${tombOnly.env.summary}`);
  assert.equal(tombOnly.env.code, "CLEAN");
  assert.equal(tombOnly.env.data.counts.driftTotal, 0);
  assert.equal(tombOnly.env.data.counts.intentionally_removed, 1, "the tombstone is honoured");

  // CONTROL (1): the revocation INTACT. The human said "report this again", and
  // that must still be obeyed - a fix that turns every journal red fails here.
  const intact = checkJson(journalRepo(t, `${TOMB}\n${REVOKE}\n`));
  assert.equal(intact.status, 1, `a revoked tombstone must report: ${intact.env.summary}`);
  assert.equal(intact.env.code, "DRIFT_FOUND", intact.env.summary);
  assert.equal(intact.env.data.counts.dead, 1, "revocation restores the dead finding");
  assert.equal(intact.env.data.journalMalformed, undefined, "a clean journal names no lines");

  // THE GATE: the same revoke, truncated. Measured before this fix, this run was
  // BYTE-IDENTICAL to `tombOnly` - exit 0, CLEAN, [stale 0, dead 0, tampered 0].
  const truncated = checkJson(journalRepo(t, `${TOMB}\n${REVOKE.slice(0, 60)}\n`));
  assert.equal(truncated.status, 1, `a truncated revoke must not read as CLEAN: ${truncated.env.summary}`);
  assert.equal(truncated.env.code, "UNREADABLE", truncated.env.summary);
  assert.deepEqual(truncated.env.data.journalMalformed, [{ line: 2, reason: "bad-json" }],
    "the line and the reason are named, never counted");
  assert.match(truncated.env.summary, /decisions\.jsonl line 2: bad-json/);
  assert.notEqual(truncated.stdout, tombOnly.stdout,
    "the corrupted-revoke run must no longer be byte-identical to the tombstone-still-standing run");

  // THE GATE, second shape: what a plain `git merge` of two branches leaves in an
  // append-only file. Three lines, none of them JSON, at 2, 4 and 6.
  const conflicted = checkJson(journalRepo(t, [
    TOMB, "<<<<<<< HEAD", REVOKE, "=======",
    JSON.stringify({ at: "2026-08-02T00:00:00Z", target: "other", type: "tombstone" }),
    ">>>>>>> bob", ""].join("\n")));
  assert.equal(conflicted.status, 1, `conflict markers must not read as CLEAN: ${conflicted.env.summary}`);
  assert.equal(conflicted.env.code, "UNREADABLE", conflicted.env.summary);
  assert.deepEqual(conflicted.env.data.journalMalformed.map((m) => m.line), [2, 4, 6],
    "every unreadable line is named, not just the first");
  assert.ok(conflicted.env.summary.length <= 300, "the 300-char summary cap holds with three lines named");

  // A missing-fields line is the OTHER reason loadJournal already records, and it
  // must reach the same verdict - `bad-json` is not the whole of the defect.
  const missingFields = checkJson(journalRepo(t, `${TOMB}\n{"at":"2026-08-01T09:00:00Z","type":"revoke"}\n`));
  assert.equal(missingFields.status, 1, missingFields.env.summary);
  assert.deepEqual(missingFields.env.data.journalMalformed, [{ line: 2, reason: "missing-fields" }]);
});

test("loadJournal still reports both malformed reasons by line", (t) => {
  const dir = journalRepo(t, `${TOMB}\nnot json at all\n{"type":"revoke"}\n`);
  const { entries, malformed } = loadJournal(dir);
  assert.equal(entries.length, 1, "the parseable line is still read");
  assert.deepEqual(malformed, [{ line: 2, reason: "bad-json" }, { line: 3, reason: "missing-fields" }]);
});
