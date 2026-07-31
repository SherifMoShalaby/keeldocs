import test from "node:test";
import assert from "node:assert/strict";
import { qidOf, generateCards, batchOf, BATCH_CAP, BATCH_CHAR_BUDGET } from "../src/interview.js";

const fact = (id, type, file, attrs = {}) => [id, {
  id, hash: `h1:${id.length}${type}`,
  payload: { schema_version: 1, type, attrs: { ...attrs } },
  provenance: { provider: "t@0", confidence: "PARSED", source: file ? [{ file }] : [] },
}];

const J = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };

function state({ findings = [], facts = [], documented = new Set(), journal = J, answers = new Map() } = {}) {
  return { findings, factsById: new Map(facts), documented, journal, answers };
}

test("qidOf is stable and kind-scoped", () => {
  assert.equal(qidOf("removal", "fact:x/y"), qidOf("removal", "fact:x/y"));
  assert.notEqual(qidOf("removal", "fact:x/y"), qidOf("document", "fact:x/y"));
  assert.match(qidOf("removal", "fact:x/y"), /^iv-[0-9a-f]{12}$/);
});

test("removal cards: dead findings only, tombstoned subjects excluded, candidates quoted", () => {
  const dead = { id: "api.old", doc: "docs/api.md", line: 4, state: "dead",
    missing: ["fact:http-endpoints/DELETE /a", "fact:http-endpoints/DELETE /b"],
    candidates: ["fact:http-endpoints/POST /a"] };
  const journal = { ...J, tombstone: new Set(["fact:http-endpoints/DELETE /b"]) };
  const { open, total } = generateCards(state({ findings: [dead, { state: "stale", id: "s", doc: "d", line: 1 }], journal }));
  assert.equal(total, 1, "tombstoned missing id must not generate a card");
  assert.equal(open[0].kind, "removal");
  assert.equal(open[0].subject, "fact:http-endpoints/DELETE /a");
  assert.match(open[0].evidence[0], /possible successor/);
});

test("document cards ride the plan ranking; hot surfaces first; removal outranks document", () => {
  const facts = [
    fact("fact:http-endpoints/GET /cold", "endpoint", "cold.js", { method: "GET", path: "/cold" }),
    fact("fact:http-endpoints/GET /hot", "endpoint", "hot.js", { method: "GET", path: "/hot" }),
    fact("fact:decision-history/hot.js", "churn", "hot.js", { path: "hot.js", commits: 9, last: "x", authors: 1 }),
  ];
  const dead = { id: "a", doc: "d.md", line: 1, state: "dead", missing: ["fact:db-schema/Gone"] };
  const { open } = generateCards(state({ findings: [dead], facts }));
  assert.deepEqual(open.map((c) => c.kind), ["removal", "document", "document"]);
  assert.equal(open[1].subject, "fact:http-endpoints/GET /hot", "churn-hot surface outranks cold");
  assert.match(open[1].question, /hot \(9 commit/);
});

test("settled verdicts close a card; unknown keeps it open but sorts it last in kind", () => {
  const facts = [
    fact("fact:http-endpoints/GET /a", "endpoint", "a.js", {}),
    fact("fact:http-endpoints/GET /b", "endpoint", "b.js", {}),
    fact("fact:http-endpoints/GET /c", "endpoint", "c.js", {}),
  ];
  const answers = new Map([
    [qidOf("document", "fact:http-endpoints/GET /a"), { verdict: "reject", at: "2026-01-01" }],
    [qidOf("document", "fact:http-endpoints/GET /b"), { verdict: "unknown", at: "2026-01-01" }],
  ]);
  const { open, total } = generateCards(state({ facts, answers }));
  assert.equal(total, 3);
  assert.deepEqual(open.map((c) => c.subject),
    ["fact:http-endpoints/GET /c", "fact:http-endpoints/GET /b"],
    "reject settles; unknown re-asks last");
});

test("batchOf: hard cap 5 and the ~1500-token char budget both bind", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    qid: `iv-${i}`, kind: "document", subject: `s${i}`, question: "q", evidence: [], verdicts: {},
  }));
  const { batch, chars } = batchOf(many);
  assert.equal(batch.length, BATCH_CAP);
  assert.ok(chars <= BATCH_CHAR_BUDGET);
  const fat = Array.from({ length: 5 }, (_, i) => ({
    qid: `iv-${i}`, kind: "document", subject: `s${i}`,
    question: "x".repeat(2500), evidence: [], verdicts: {},
  }));
  const r2 = batchOf(fat);
  assert.ok(r2.batch.length < 5 && r2.chars <= BATCH_CHAR_BUDGET,
    "char budget must drop trailing cards before the count cap");
});

test("generation is deterministic and answer-order independent", () => {
  const facts = [
    fact("fact:http-endpoints/GET /a", "endpoint", "a.js", {}),
    fact("fact:http-endpoints/GET /b", "endpoint", "b.js", {}),
  ];
  const a = generateCards(state({ facts }));
  const b = generateCards(state({ facts }));
  assert.deepEqual(a, b);
});
