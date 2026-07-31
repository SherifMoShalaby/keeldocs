import test from "node:test";
import assert from "node:assert/strict";
import { renameMapFromStatus, sigMatch, rankSymbolCandidates } from "../src/reanchor.js";

const sym = (id, nameless) => [id, { id, hash: "h", payload: { type: "symbol" },
  provenance: { nameless } }];

const LOGIN_SIG = ["def § ( str , str =? ) -> bool"];
const OTHER_SIG = ["def § ( int ) -> int"];

test("rename map parses R-status lines only", () => {
  const m = renameMapFromStatus("M\tsrc/a.ts\nR087\tsrc/auth.ts\tsrc/identity.ts\nA\tsrc/new.ts");
  assert.deepEqual([...m.entries()], [["src/auth.ts", "src/identity.ts"]]);
});

test("sigMatch: exact on identical sets, near on same-arity token overlap, null otherwise", () => {
  assert.equal(sigMatch(LOGIN_SIG, [...LOGIN_SIG]), "exact");
  assert.equal(sigMatch(LOGIN_SIG, ["def § ( str , str =? ) -> boolean"]), "near"); // one token moved
  assert.equal(sigMatch(LOGIN_SIG, OTHER_SIG), null);                                // arity differs
  assert.equal(sigMatch(["a ( x )", "b ( y )"], ["a ( x )"]), null);                  // overload count differs from exact; near needs all-covered
});

test("AUTO gate: exactly one candidate with S1 + S2-exact (the file move)", () => {
  const factsNow = new Map([
    sym("ds p . src/identity.ts/login().", LOGIN_SIG),
    sym("ds p . src/util.ts/hash().", OTHER_SIG),
  ]);
  const baseFacts = new Map([sym("ds p . src/auth.ts/login().", LOGIN_SIG)]);
  const renames = renameMapFromStatus("R090\tsrc/auth.ts\tsrc/identity.ts");
  const ranked = rankSymbolCandidates({
    missingId: "ds p . src/auth.ts/login().", factsNow, baseFacts, renames });
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].signals, { s1: true, s2: "exact", s1b: true });
  assert.equal(ranked[0].auto, true, "file move with identical shape auto-qualifies");
});

test("in-place rename: S2-exact different-name candidate is proposal-grade, never auto", () => {
  const factsNow = new Map([
    sym("ds p . src/auth.ts/signIn().", LOGIN_SIG),   // renamed in place
    sym("ds p . src/util.ts/hash().", OTHER_SIG),
  ]);
  const baseFacts = new Map([sym("ds p . src/auth.ts/login().", LOGIN_SIG)]);
  const ranked = rankSymbolCandidates({
    missingId: "ds p . src/auth.ts/login().", factsNow, baseFacts, renames: new Map() });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "ds p . src/auth.ts/signIn().");
  assert.deepEqual(ranked[0].signals, { s2: "exact" });
  assert.ok(!ranked[0].auto, "one signal is not two");
});

test("ambiguity kills auto: two same-name candidates, even after a rename", () => {
  const factsNow = new Map([
    sym("ds p . src/identity.ts/login().", LOGIN_SIG),
    sym("ds p . src/legacy.ts/login().", LOGIN_SIG),
  ]);
  const baseFacts = new Map([sym("ds p . src/auth.ts/login().", LOGIN_SIG)]);
  const renames = renameMapFromStatus("R090\tsrc/auth.ts\tsrc/identity.ts");
  const ranked = rankSymbolCandidates({
    missingId: "ds p . src/auth.ts/login().", factsNow, baseFacts, renames });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((c) => !c.auto), "two candidates can never auto-rebind");
  assert.equal(ranked[0].id, "ds p . src/identity.ts/login().", "the S1 hit ranks first");
  assert.ok(!ranked.some((c) => c.signals.s1b), "same-name uniqueness fails at two");
});

test("no base shapes: S1b-style ranking still works without S2", () => {
  const factsNow = new Map([sym("ds p . src/util.ts/login().", LOGIN_SIG)]);
  const ranked = rankSymbolCandidates({
    missingId: "ds p . src/auth.ts/login().", factsNow, baseFacts: null, renames: new Map() });
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].signals, { s1b: true });
  assert.ok(!ranked[0].auto);
});
