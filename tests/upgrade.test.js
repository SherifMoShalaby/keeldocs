import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { renderAll } from "../src/render.js";
import { planUpgrade, applyInsertion, sectionsOf } from "../src/upgrade.js";
import { factHash } from "../src/hash.js";

const DOC = "docs/architecture/data-model.md";

function mkFacts(defs) {
  const m = new Map();
  for (const [id, type, attrs] of defs) {
    const payload = { schema_version: 1, type, attrs };
    m.set(id, { id, payload, hash: factHash(payload),
      provenance: { provider: "p@1", source: [{ kind: "migration-replay" }] } });
  }
  return m;
}

const table = (name, cols) => [`fact:db-schema/${name}`, "table",
  { name, relations: [], columns: cols.map((c) => ({ name: c, type: "text", optional: false, list: false, attrs: "" })) }];
const fn = (name, sig) => [`fact:db-schema/fn.${name}(${sig})`, "function",
  { name, signature: sig, arguments: sig, returns: "boolean", kind: "function",
    set_returning: false, volatility: "volatile", language: "sql",
    security_definer: false, body_digest: "aaaabbbbcccc" }];

const FACTS = mkFacts([
  table("public.orders", ["id", "total"]),
  table("public.users", ["id", "email"]),
  ["fact:db-schema/enum.public.order_status", "enum", { name: "public.order_status", values: ["new", "paid"] }],
  fn("public.claim_order", "p_id bigint"),
  fn("public.touch", ""),
]);

// The doc as the CURRENT recipe renders it, plus the two kinds of human byte
// that a delete-and-regenerate would destroy: prose inside a slot and prose
// below the human-notes marker.
function currentDoc() {
  const doc = renderAll(FACTS).find((d) => d.path === DOC);
  return doc.content
    .replace("<!-- /keeldocs:slot -->", "HUMAN SLOT PROSE.\n<!-- /keeldocs:slot -->")
    .replace("<!-- Human notes below this line are never touched by keeldocs. -->",
      "<!-- Human notes below this line are never touched by keeldocs. -->\n\n## Field notes\n\nHUMAN TAIL PROSE.");
}

// Remove whole sections by their marker id, exactly along section boundaries,
// so a correct insertion restores the file byte-for-byte.
function withoutSections(text, ids) {
  let out = text;
  for (const id of ids) {
    const { lines, sections } = sectionsOf(out, DOC);
    const s = sections.find((x) => x.ids.includes(id));
    assert.ok(s, `fixture section ${id} not found`);
    out = [...lines.slice(0, s.start), ...lines.slice(s.end)].join("\n");
  }
  return out;
}

function repoWith(text, t) {
  const root = mkdtempSync(join(tmpdir(), "kd-upg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, dirname(DOC)), { recursive: true });
  writeFileSync(join(root, DOC), text);
  return root;
}

const plan = (root) => planUpgrade({ root, factsById: FACTS, journal: null });

test("a grown section is restored byte-for-byte, human prose untouched", (t) => {
  const want = currentDoc();
  const root = repoWith(withoutSections(want, ["db.functions"]), t);

  const { proposals } = plan(root);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, "db.functions");
  assert.equal(proposals[0].anchor, "after");
  assert.equal(proposals[0].anchorId, "db.enums", "recipe order puts routines after the enum section");

  const got = applyInsertion(readFileSync(join(root, DOC), "utf8"), DOC, proposals[0]);
  assert.equal(got, want, "insertion is a pure addition - every other byte identical");
  assert.match(got, /HUMAN SLOT PROSE/);
  assert.match(got, /HUMAN TAIL PROSE/);
});

test("consecutive new sections chain onto each other in recipe order", (t) => {
  const want = currentDoc();
  const root = repoWith(withoutSections(want, ["db.enums", "db.functions"]), t);

  const { proposals } = plan(root);
  assert.deepEqual(proposals.map((p) => p.id), ["db.enums", "db.functions"]);
  // the second anchors onto the first, which does not exist on disk YET - that
  // is the point of applying in recipe order
  assert.equal(proposals[1].anchorId, "db.enums");

  let text = readFileSync(join(root, DOC), "utf8");
  for (const p of proposals) text = applyInsertion(text, DOC, p);
  assert.equal(text, want, "both land, in recipe order");
});

test("applying a chained section out of order refuses instead of guessing", (t) => {
  const root = repoWith(withoutSections(currentDoc(), ["db.enums", "db.functions"]), t);
  const { proposals } = plan(root);
  const text = readFileSync(join(root, DOC), "utf8");
  assert.throws(() => applyInsertion(text, DOC, proposals[1]),
    /anchor section for `db\.enums` is not in .* yet - apply that section first/);
});

test("a missing FIRST section anchors before its successor", (t) => {
  const want = currentDoc();
  const root = repoWith(withoutSections(want, ["db.root.diagram"]), t);
  const { proposals } = plan(root);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].anchor, "before", "nothing precedes it, so it anchors forwards");
  assert.equal(applyInsertion(readFileSync(join(root, DOC), "utf8"), DOC, proposals[0]), want);
});

test("a document keeldocs did not generate is refused, not repaired", (t) => {
  const hand = "# Data model\n\nHand-written. No markers.\n\n## Tables\n\nProse.\n";
  const root = repoWith(hand, t);
  const { proposals, skipped } = plan(root);
  assert.equal(proposals.length, 0, "never write into a file we cannot prove we generated");
  assert.equal(skipped[0].id, "db.root");
  assert.match(skipped[0].reason, /not generated by keeldocs/);
  assert.equal(readFileSync(join(root, DOC), "utf8"), hand);
});

test("idempotent, and a recorded rejection holds the section", (t) => {
  const root = repoWith(withoutSections(currentDoc(), ["db.functions"]), t);
  const { proposals } = plan(root);
  const text = applyInsertion(readFileSync(join(root, DOC), "utf8"), DOC, proposals[0]);
  writeFileSync(join(root, DOC), text);
  assert.equal(plan(root).proposals.length, 0, "a section already present is never re-proposed");

  const root2 = repoWith(withoutSections(currentDoc(), ["db.functions"]), t);
  const rejected = planUpgrade({ root: root2, factsById: FACTS,
    journal: { rejection: new Map([["db.functions", null]]), snooze: new Set() } });
  assert.equal(rejected.proposals.length, 0, "a decision not to have the section is respected");
  assert.match(rejected.skipped[0].reason, /rejected earlier/);
});

test("a hand-renamed heading does not resurrect a duplicate section", (t) => {
  const doc = currentDoc().replace("## Database functions", "## RPCs and triggers");
  const root = repoWith(doc, t);
  assert.equal(plan(root).proposals.length, 0,
    "sections are identified by their marker ids, never by heading text");
});
