import test from "node:test";
import assert from "node:assert/strict";
import { noiseStats } from "../src/journal.js";
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
