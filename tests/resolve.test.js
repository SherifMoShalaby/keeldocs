import test from "node:test";
import assert from "node:assert/strict";
import { resolveClaims, claimCmp, LATTICE, PRECEDENCE_VERSION } from "../src/resolve.js";

const claim = (provider, confidence, hash) => ({
  id: "fact:db-schema/Item", hash,
  payload: { schema_version: 1, type: "table", attrs: {} },
  provenance: { provider, confidence },
});

test("lattice beats: higher tier wins regardless of arrival order", () => {
  const live = claim("tbls-live@0.2.0", "INTROSPECTED", "h1:aaa");
  const parsed = claim("prisma@0.1.0", "PARSED", "h1:bbb");
  for (const claims of [[live, parsed], [parsed, live]]) {
    const { winner, conflict } = resolveClaims("fact:db-schema/Item", claims, "db-schema");
    assert.equal(winner.provenance.provider, "tbls-live@0.2.0");
    assert.equal(conflict.rule, "lattice");
    assert.equal(conflict.winner, "tbls-live@0.2.0");
    assert.equal(conflict.precedenceVersion, PRECEDENCE_VERSION);
    // claims listed winner-first, deterministically
    assert.deepEqual(conflict.claims.map((c) => c.provider),
      ["tbls-live@0.2.0", "prisma@0.1.0"]);
  }
});

test("same tier falls to the lexicographic provider-id backstop", () => {
  const a = claim("drizzle@0.1.0", "PARSED", "h1:aaa");
  const b = claim("prisma@0.1.0", "PARSED", "h1:bbb");
  for (const claims of [[a, b], [b, a]]) {
    const { winner, conflict } = resolveClaims("fact:db-schema/Item", claims, "db-schema");
    assert.equal(winner.provenance.provider, "drizzle@0.1.0", "drizzle < prisma lexicographically");
    assert.equal(conflict.rule, "provider-id");
  }
});

test("precedence table (stage 2) overrides the lexicographic backstop", () => {
  const a = claim("drizzle@0.1.0", "PARSED", "h1:aaa");
  const b = claim("prisma@0.1.0", "PARSED", "h1:bbb");
  const table = { "db-schema": ["prisma"] }; // listed beats unlisted
  const { winner, conflict } = resolveClaims("fact:db-schema/Item", [a, b], "db-schema", table);
  assert.equal(winner.provenance.provider, "prisma@0.1.0");
  assert.equal(conflict.rule, "precedence");
  // the table is capability-scoped: other capabilities are untouched by it
  const other = resolveClaims("fact:http-endpoints/GET /x", [a, b], "http-endpoints", table);
  assert.equal(other.winner.provenance.provider, "drizzle@0.1.0");
});

test("corroboration: identical hashes are NOT a conflict; winner still total-ordered", () => {
  const a = claim("express@0.1.0", "PARSED", "h1:same");
  const b = claim("fastapi@0.2.0", "PARSED", "h1:same");
  for (const claims of [[a, b], [b, a]]) {
    const { winner, conflict } = resolveClaims("fact:http-endpoints/GET /health", claims, "http-endpoints");
    assert.equal(conflict, null, "agreement must not manufacture a conflict record");
    assert.equal(winner.provenance.provider, "express@0.1.0");
  }
});

test("three claims: all listed winner-first; unknown tier sorts below every known one", () => {
  const a = claim("alpha@1.0.0", "PATTERN", "h1:aaa");
  const b = claim("beta@1.0.0", "PARSED", "h1:bbb");
  const c = claim("gamma@1.0.0", "WEIRD-TIER", "h1:ccc");
  const { winner, conflict } = resolveClaims("fact:db-schema/Item", [c, a, b], "db-schema");
  assert.equal(winner.provenance.provider, "beta@1.0.0");
  assert.deepEqual(conflict.claims.map((x) => x.provider),
    ["beta@1.0.0", "alpha@1.0.0", "gamma@1.0.0"]);
  assert.deepEqual(conflict.claims.map((x) => x.hash), ["h1:bbb", "h1:aaa", "h1:ccc"]);
});

test("single claim resolves to itself with no conflict; comparator is a strict total order", () => {
  const only = claim("prisma@0.1.0", "PARSED", "h1:x");
  const r = resolveClaims("fact:db-schema/Item", [only], "db-schema");
  assert.equal(r.winner, only);
  assert.equal(r.conflict, null);
  assert.equal(claimCmp(only, only, "db-schema"), 0, "reflexive ties are exact zero");
  assert.ok(LATTICE[0] === "INTROSPECTED" && LATTICE.at(-1) === "INFERRED", "ADR-003 lattice order");
});
