import test from "node:test";
import assert from "node:assert/strict";
import { patchRegion, patchBind } from "../src/patch.js";
import { buildProposals } from "../src/proposals.js";
import { evaluate } from "../src/drift.js";
import { factHash, contentHash, display } from "../src/hash.js";

const DOC = [
  "# t",
  "before text stays",
  "<!-- keeldocs:gen id=db.item.columns hash=h1:aaaaaaaaaaaaaaaa content=h1:bbbbbbbbbbbbbbbb -->",
  "old body",
  "<!-- /keeldocs:gen -->",
  "after text stays",
  "<!-- keeldocs: id=api.x binds=fact:http-endpoints/GET /old hash-kind=fact -->",
  "",
].join("\n");

test("patchRegion is byte-surgical: body + attrs change, everything else preserved", () => {
  const out = patchRegion(DOC, "db.item.columns", "new body", "h1:1111111111111111", "h1:2222222222222222");
  assert.ok(out.includes("before text stays") && out.includes("after text stays"));
  assert.ok(out.includes("hash=h1:1111111111111111 content=h1:2222222222222222"));
  assert.ok(out.includes("\nnew body\n") && !out.includes("old body"));
  assert.ok(out.includes("binds=fact:http-endpoints/GET /old"), "unrelated anchor untouched");
  // exact byte accounting: only marker attrs + body changed
  assert.equal(out.split("\n").length, DOC.split("\n").length);
});

test("patchRegion throws on unknown and ambiguous regions", () => {
  assert.throws(() => patchRegion(DOC, "nope", "b", "h1:1111111111111111", "h1:2222222222222222"), /not found/);
  const dup = DOC + "\n<!-- keeldocs:gen id=db.item.columns hash=h1:aaaaaaaaaaaaaaaa -->\nx\n<!-- /keeldocs:gen -->";
  assert.throws(() => patchRegion(dup, "db.item.columns", "b", "h1:1111111111111111", "h1:2222222222222222"), /more than once/);
});

test("patchBind rewrites one bind inside one marker only", () => {
  const out = patchBind(DOC, "api.x", "fact:http-endpoints/GET /old", "fact:http-endpoints/GET /new");
  assert.ok(out.includes("binds=fact:http-endpoints/GET /new"));
  assert.ok(out.includes("old body"), "region body untouched");
  assert.throws(() => patchBind(DOC, "api.x", "fact:http-endpoints/GET /missing", "x"), /not present/);
});

function mkFacts(defs) {
  const m = new Map();
  for (const [id, attrs] of defs) {
    const payload = { schema_version: 1, type: "t", attrs };
    m.set(id, { id, payload, hash: factHash(payload) });
  }
  return m;
}
const CAPS = { "http-endpoints": { status: "ok" } };
const J0 = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };

test("rejection holds an identical proposal: tampered -> held when content matches recorded rejection", () => {
  const facts = mkFacts([["fact:http-endpoints/GET /a", { p: "/a" }]]);
  const bind = [{ raw: "fact:http-endpoints/GET /a", wildcard: false }];
  const region = { kind: "gen", id: "g", binds: bind, doc: "d", line: 1,
    hash: display(facts.get("fact:http-endpoints/GET /a").hash),
    content: display(contentHash("pristine")), body: "edited" };
  const tampered = evaluate({ anchors: [], regions: [region], factsById: facts, capabilities: CAPS, journal: J0 });
  assert.equal(tampered.findings[0].state, "tampered");
  const journal = { ...J0, rejection: new Map([["g", display(contentHash("edited"))]]) };
  const held = evaluate({ anchors: [], regions: [region], factsById: facts, capabilities: CAPS, journal });
  assert.equal(held.findings[0].state, "held");
  // a DIFFERENT edit is a new proposal - not held
  const journal2 = { ...J0, rejection: new Map([["g", display(contentHash("some other edit"))]]) };
  const re = evaluate({ anchors: [], regions: [{ ...region, body: "edited differently" }], factsById: facts, capabilities: CAPS, journal: journal2 });
  assert.equal(re.findings[0].state, "tampered");
});

test("buildProposals maps finding states to the right kinds", () => {
  const facts = mkFacts([
    ["fact:http-endpoints/POST /orders", { method: "POST", path: "/orders" }],
  ]);
  const regions = [
    { kind: "gen", id: "api.inventory.table", binds: [{ raw: "fact:http-endpoints/*", wildcard: true, prefix: "fact:http-endpoints/" }],
      hash: "h1:0000000000000000", body: "x", doc: "d", line: 1 },
    { kind: "gen", id: "custom.handwritten", binds: [{ raw: "fact:http-endpoints/POST /orders", wildcard: false }],
      hash: "h1:0000000000000000", body: "y", doc: "d", line: 5 },
  ];
  const findings = [
    { id: "api.inventory.table", state: "stale", doc: "d", line: 1 },
    { id: "custom.handwritten", state: "stale", doc: "d", line: 5 },
    { id: "a.dead", state: "dead", doc: "d", line: 9, missing: ["fact:http-endpoints/POST /orders/{id}"],
      candidates: ["fact:http-endpoints/POST /orders"] },
    { id: "a.gone", state: "dead", doc: "d", line: 12, missing: ["fact:http-endpoints/GET /nothing-alike"], candidates: [] },
  ];
  const props = buildProposals({ findings, regions, anchors: [], factsById: facts });
  const byId = Object.fromEntries(props.map((p) => [p.id, p.kind]));
  assert.equal(byId["api.inventory.table"], "regenerate");
  assert.equal(byId["custom.handwritten"], "unrenderable");
  assert.equal(byId["a.dead"], "rebind");
  assert.equal(byId["a.gone"], "tombstone");
  const rebind = props.find((p) => p.id === "a.dead");
  assert.equal(rebind.candidate, "fact:http-endpoints/POST /orders");
  assert.ok(props.every((p) => p.evidence.length > 20), "every proposal carries evidence");
});
