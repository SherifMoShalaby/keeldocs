import test from "node:test";
import assert from "node:assert/strict";
import { toSarif } from "../scripts/sarif.js";
import { CHANNELS, disclosuresOf, RUN_ANCHOR } from "../src/disclosure.js";

const REPORT = {
  meta: { engine: "keeldocs@0.1.0-rc.1" },
  findings: [
    { id: "a.x", kind: "gen", state: "clean", doc: "docs/a.md", line: 3 },
    { id: "a.y", kind: "gen", state: "stale", doc: "docs/a.md", line: 9 },
    { id: "a.z", kind: "anchor", state: "dead", doc: "docs/a.md", line: 12,
      missing: ["fact:http-endpoints/GET /old"], candidates: ["fact:http-endpoints/GET /new"] },
    { id: "a.t", kind: "gen", state: "tampered", doc: "docs/b.md", line: 2, detail: "edited by hand" },
    { id: "a.u", kind: "anchor", state: "unresolvable", doc: "docs/b.md", line: 8 },
    { id: "a.s", kind: "slot", state: "snoozed", doc: "docs/b.md", line: 20 },
  ],
};

test("sarif: drift states map to results, clean/snoozed do not, tampered is error", () => {
  const s = toSarif(REPORT);
  assert.equal(s.version, "2.1.0");
  const run = s.runs[0];
  assert.equal(run.tool.driver.name, "keeldocs");
  assert.equal(run.tool.driver.version, "0.1.0-rc.1");
  const byRule = Object.fromEntries(run.results.map((r) => [r.ruleId, r]));
  assert.deepEqual(Object.keys(byRule).sort(),
    ["keeldocs/dead", "keeldocs/stale", "keeldocs/tampered", "keeldocs/unresolvable"]);
  assert.equal(byRule["keeldocs/tampered"].level, "error");
  assert.equal(byRule["keeldocs/unresolvable"].level, "note");
  assert.match(byRule["keeldocs/dead"].message.text, /did you mean: fact:http-endpoints\/GET \/new/);
  const loc = byRule["keeldocs/stale"].locations[0].physicalLocation;
  assert.equal(loc.artifactLocation.uri, "docs/a.md");
  assert.equal(loc.region.startLine, 9);
  // every emitted rule id is declared in the driver rules
  const declared = new Set(run.tool.driver.rules.map((r) => r.id));
  assert.ok(run.results.every((r) => declared.has(r.ruleId)));
});

// A count-only channel disclosed nothing at all: `toSarif` iterated the items of
// each ledger entry, and `scopedOut` has a count and no items, so a live channel
// produced zero results while the gate that was meant to notice compared
// `results == items.length` and read 0 == 0.
test("sarif: a channel that discloses a count with no items still reaches the Security tab", () => {
  const units = disclosuresOf({ v: 1, meta: { scopedOut: 4 }, counts: {}, findings: [] });
  assert.equal(units.length, 1);
  assert.equal(units[0].channel, "scopedOut");
  assert.match(units[0].detail, /4 fact/);
  const res = toSarif({ v: 1, meta: { scopedOut: 4 }, counts: {}, findings: [] }).runs[0].results;
  assert.equal(res.length, 1);
  assert.equal(res[0].ruleId, "keeldocs/scopedOut");
  // Zero is not a unit: it belongs beside the scope in a terminal, not in a list
  // of problems.
  assert.equal(disclosuresOf({ v: 1, meta: { scopedOut: 0 }, counts: {}, findings: [] }).length, 0);
});

// GitHub: "At least one location is required for code scanning to display a
// result." `extractionGaps` items carry `file: null` for `not-a-git-root` - the
// gap every shipped fixture produces - and used to emit `locations: []`, which
// is a result that exists in the file and in no UI.
test("sarif: every disclosure names a place, including the ones whose items do not", () => {
  const report = { v: 1, meta: {}, counts: {}, findings: [],
                   extractionGaps: [{ kind: "not-a-git-root", file: null }],
                   skipped: ["node_modules"],
                   journalMalformed: [{ line: 7, reason: "bad-json" }] };
  for (const u of disclosuresOf(report)) assert.ok(u.path, `${u.channel} names no place`);
  const res = toSarif(report).runs[0].results;
  assert.equal(res.length, 3);
  for (const r of res) {
    const uri = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
    assert.ok(uri, `${r.ruleId} emitted an empty locations array`);
  }
  const by = Object.fromEntries(res.map((r) => [r.ruleId, r]));
  // Item's own place, then the channel's file, then the file that configures the
  // run - in that order, and never nothing.
  assert.equal(by["keeldocs/journalMalformed"].locations[0].physicalLocation
    .artifactLocation.uri, ".keeldocs/decisions.jsonl");
  assert.equal(by["keeldocs/journalMalformed"].locations[0].physicalLocation.region.startLine, 7);
  assert.equal(by["keeldocs/skipped"].locations[0].physicalLocation.artifactLocation.uri, RUN_ANCHOR);
  assert.equal(by["keeldocs/extractionGaps"].locations[0].physicalLocation.artifactLocation.uri, RUN_ANCHOR);
  // A subject that is not a path still has to be legible in the text, since
  // nothing can be annotated against it.
  assert.match(by["keeldocs/skipped"].message.text, /node_modules/);
});

// The subject of an extraction gap is a table, an extension or a procedure as
// often as it is a file. It may be offered as a location, but it must never be
// the only place it appears.
test("sarif: a gap whose subject is not a path keeps the subject in the message", () => {
  const res = toSarif({ v: 1, meta: {}, counts: {}, findings: [],
    extractionGaps: [{ kind: "extension-stubbed", file: "moddatetime" }] }).runs[0].results;
  assert.equal(res.length, 1);
  assert.match(res[0].message.text, /extension-stubbed/);
  assert.match(res[0].message.text, /moddatetime/);
});

// Levels are the honest part: a disclosure is not drift, and must not read as
// drift or gate like a defect. `verdict` warns because the run produced no drift
// verdict; `named` notes because the user asked for the blind spot.
test("sarif: disclosures are levelled apart from drift and every channel has a rule", () => {
  const report = { v: 1, meta: {}, counts: {}, findings: [],
                   unscanned: [{ doc: "handbook/a.md", anchors: 1, regions: 0 }],
                   skipped: ["node_modules"] };
  const run = toSarif(report).runs[0];
  const by = Object.fromEntries(run.results.map((r) => [r.ruleId, r]));
  assert.equal(by["keeldocs/unscanned"].level, "warning");   // verdict
  assert.equal(by["keeldocs/skipped"].level, "note");        // named
  // Never `error`: that is reserved for a defect proved to be in the tree.
  assert.ok(run.results.every((r) => r.level !== "error"));
  // The claim must not blur into drift's: a disclosure says what the ENGINE did.
  assert.match(by["keeldocs/unscanned"].message.text, /outside every scan root|never read/);
  const declared = new Set(run.tool.driver.rules.map((r) => r.id));
  for (const c of CHANNELS) {
    assert.ok(declared.has(`keeldocs/${c.channel}`), `no rule declared for ${c.channel}`);
  }
});
