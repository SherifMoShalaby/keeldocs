import test from "node:test";
import assert from "node:assert/strict";
import { toSarif } from "../scripts/sarif.js";

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
