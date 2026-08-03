import test from "node:test";
import assert from "node:assert/strict";
import { validateProse } from "../src/slots.js";
import { patchSlot } from "../src/patch.js";
import { factHash } from "../src/hash.js";

function mkFacts(defs) {
  const m = new Map();
  for (const [id, type, attrs] of defs) {
    const payload = { schema_version: 1, type, attrs };
    m.set(id, { id, payload, hash: factHash(payload) });
  }
  return m;
}
const FACTS = mkFacts([
  ["fact:http-endpoints/GET /items", "endpoint", { method: "GET", path: "/items" }],
  ["fact:db-schema/Item", "table", { name: "Item",
    columns: [{ name: "status", type: "Status" }], relations: [] }],
  ["fact:db-schema/enum.Status", "enum", { name: "Status", values: ["ACTIVE"] }],
]);
const SLOT = { id: "s", maxWords: 20 };

test("slot-write gates: each fires by name", () => {
  const run = (prose) => validateProse({ prose, slot: SLOT, factsById: FACTS });
  assert.ok(run("").some((e) => e.startsWith("empty")));
  assert.ok(run("nice `/ items` <!-- keeldocs:gen id=x -->").some((e) => e.startsWith("marker-injection")));
  assert.ok(run("`Item` " + "word ".repeat(25)).some((e) => e.startsWith("word-cap")));
  assert.ok(run("Uses `GhostService` heavily.").some((e) => e.startsWith("unresolved-citations")),
    "hallucinated identifiers are rejected, not softened");
  assert.ok(run("Plain prose with no citations at all.").some((e) => e.startsWith("zero-citations")));
  assert.ok(run("`Item` count is 3 today.").some((e) => e.startsWith("numbers-in-prose")));
});

test("slot-write gates: valid prose passes; digits inside backticks are fine", () => {
  assert.deepEqual(validateProse({
    prose: "Listing lives at `GET /items`; each `Item` carries a `Status` such as `ACTIVE`.",
    slot: SLOT, factsById: FACTS }), []);
  assert.deepEqual(validateProse({
    prose: "The `Item` table backs `/items`.", slot: SLOT, factsById: FACTS }), []);
});

test("patchSlot: replaces body, records hash, preserves surroundings; throws on unknown", () => {
  const doc = [
    "before",
    "<!-- keeldocs:slot id=s binds=fact:db-schema/* max-words=120 -->",
    "old",
    "<!-- /keeldocs:slot -->",
    "after",
  ].join("\n");
  const out = patchSlot(doc, "s", "> label\n\nnew prose", "h1:1234567812345678");
  assert.ok(out.includes("hash=h1:1234567812345678") && out.includes("new prose") && !out.includes("\nold\n"));
  assert.ok(out.startsWith("before") && out.endsWith("after"));
  assert.ok(out.includes("max-words=120"), "existing attrs preserved");
  assert.throws(() => patchSlot(doc, "nope", "x", "h1:1234567812345678"), /not found/);
});

// ---------- anchors inside fenced code blocks are examples ----------
// Found by the dogfood gate the first time it was not vacuous: the rewritten
// README showed a real anchor as an illustration, keeldocs parsed it as
// structure, bound it to this repo's endpoint facts and reported README.md:114
// stale. Every user who documents their own anchors would hit the same thing.
test("parseDoc ignores anchors inside fenced code blocks", async () => {
  const { parseDoc } = await import("../src/anchors.js");
  const doc = [
    "# Guide",
    "",
    "```markdown",
    "<!-- keeldocs: id=example.anchor binds=fact:http-endpoints/* hash-kind=fact -->",
    "<!-- keeldocs:gen id=example.anchor.table hash=h1:deadbeefdeadbeef -->",
    "| a | b |",
    "<!-- /keeldocs:gen -->",
    "```",
    "",
    "<!-- keeldocs: id=real.anchor binds=fact:http-endpoints/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:gen id=real.anchor.table hash=h1:0123456789abcdef -->",
    "| c | d |",
    "<!-- /keeldocs:gen -->",
  ].join("\n");
  const r = parseDoc(doc, "GUIDE.md");
  assert.deepEqual(r.anchors.map((a) => a.id), ["real.anchor"]);
  assert.deepEqual(r.regions.map((x) => x.id), ["real.anchor.table"]);
  assert.equal(r.quarantined.length, 0, "a fenced close must not read as unbalanced");
});

test("parseDoc: a tilde fence hides anchors too, and line numbers survive masking", async () => {
  const { parseDoc } = await import("../src/anchors.js");
  const doc = [
    "~~~",
    "<!-- keeldocs: id=hidden.one binds=fact:x/* hash-kind=fact -->",
    "~~~",
    "<!-- keeldocs: id=visible.one binds=fact:x/* hash-kind=fact -->",
  ].join("\n");
  const r = parseDoc(doc, "D.md");
  assert.deepEqual(r.anchors.map((a) => a.id), ["visible.one"]);
  assert.equal(r.anchors[0].line, 4, "masking must preserve byte offsets so lines stay right");
});
