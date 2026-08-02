import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadPerFile, savePerFile, writeHandoff, clearHandoff } from "../src/cache.js";
import { extractAll } from "../src/facts.js";
import { jcs } from "../src/jcs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (t, prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const D1 = "a".repeat(64), D2 = "b".repeat(64), GONE = "c".repeat(64);

test("the handoff carries only parses for files the provider is about to see", (t) => {
  const root = tmp(t, "kd-pf-");
  const parsed = { [`${D1}|ts`]: { decls: [1] }, [`${D2}|ts`]: { decls: [2] }, [`${GONE}|ts`]: { decls: [3] } };
  const p = writeHandoff(root, "acme", { "a.ts": D1, "b.ts": D2 }, parsed);
  const h = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(Object.keys(h.parsed).sort(), [`${D1}|ts`, `${D2}|ts`].sort());
  assert.ok(!(`${GONE}|ts` in h.parsed), "a parse for a file that is gone is dead weight, not context");
  assert.deepEqual(h.digests, { "a.ts": D1, "b.ts": D2 });
});

test("a provider may discriminate beyond the digest, and the engine still prunes correctly", (t) => {
  const root = tmp(t, "kd-pf-");
  // ts-imports appends the grammar because a .tsx and a .ts file with identical
  // bytes do not parse the same. The engine reads only the part before the pipe.
  const parsed = { [`${D1}|ts`]: 1, [`${D1}|tsx`]: 2, [`${GONE}|ts`]: 3 };
  savePerFile(root, "acme", { "a.ts": D1 }, parsed, {});
  const kept = loadPerFile(root, "acme");
  assert.deepEqual(Object.keys(kept).sort(), [`${D1}|ts`, `${D1}|tsx`],
    "both discriminated entries for a live digest survive");
  assert.ok(!(`${GONE}|ts` in kept), "the dead digest is pruned, or the cache grows with history forever");
});

test("fresh parses merge over the old ones and the cache stays bounded by the repo", (t) => {
  const root = tmp(t, "kd-pf-");
  savePerFile(root, "acme", { "a.ts": D1 }, { [`${D1}|ts`]: "old" }, { [`${D1}|ts`]: "new" });
  assert.equal(loadPerFile(root, "acme")[`${D1}|ts`], "new");
  savePerFile(root, "acme", { "b.ts": D2 }, loadPerFile(root, "acme"), { [`${D2}|ts`]: "b" });
  assert.deepEqual(Object.keys(loadPerFile(root, "acme")), [`${D2}|ts`],
    "the file that left the repo took its parse with it");
});

test("an absent or corrupt cache is a full parse, never a failure", (t) => {
  const root = tmp(t, "kd-pf-");
  assert.deepEqual(loadPerFile(root, "never-written"), {});
  savePerFile(root, "acme", { "a.ts": D1 }, { [`${D1}|ts`]: "x" }, {});
  const p = writeHandoff(root, "acme", { "a.ts": D1 }, loadPerFile(root, "acme"));
  writeFileSync(p.replace("handoff-acme.json", "acme.") + "", "not gzip", { flag: "w" });
  // whatever we corrupt, the worst outcome is that nothing is reused
  assert.doesNotThrow(() => loadPerFile(root, "acme"));
  clearHandoff(root, "acme");
});

// ---------------------------------------------------------------------------
// The claim that matters: the handoff is a PERFORMANCE input. Output must not
// depend on whether it was warm, cold, or half-full.

const dump = (r) => jcs([...r.factsById.values()]
  .map((f) => ({ id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance }))
  .sort((a, b) => a.id.localeCompare(b.id)));

function scenario(t) {
  const root = tmp(t, "kd-pf-e2e-");
  cpSync(join(ROOT, "fixtures", "polyglot-scenario"), root, { recursive: true });
  rmSync(join(root, "golden"), { recursive: true, force: true });
  rmSync(join(root, ".keeldocs"), { recursive: true, force: true });
  return root;
}

test("an edit through the per-file cache lands exactly where a from-scratch run does", (t) => {
  const root = scenario(t);
  const first = extractAll(root, {});
  assert.ok(Object.keys(first.cache.reparsed).length > 0, "the fixture must exercise an incremental provider");

  const target = join(root, "app.js");
  writeFileSync(target, readFileSync(target, "utf8") + "\nexport function d4Probe(n) { return n; }\n");
  const incremental = extractAll(root, {});

  process.env.KEELDOCS_NO_CACHE = "1";
  const scratch = extractAll(root, {});
  delete process.env.KEELDOCS_NO_CACHE;

  assert.equal(dump(incremental), dump(scratch),
    "a run that reused parses must be indistinguishable from one that did not");
});

test("a HALF-full cache is as correct as a full one or an empty one", (t) => {
  const root = scenario(t);
  extractAll(root, {});                                   // populate
  // knock a hole in it: half the entries vanish, which is what a partially
  // pruned or partially written cache looks like
  const before = loadPerFile(root, "ts-imports");
  const keys = Object.keys(before);
  if (keys.length > 1) {
    const half = Object.fromEntries(keys.slice(0, Math.floor(keys.length / 2)).map((k) => [k, before[k]]));
    savePerFile(root, "ts-imports", Object.fromEntries(keys.map((k) => [k, k.split("|")[0]])), half, {});
  }
  const partial = extractAll(root, {});

  process.env.KEELDOCS_NO_CACHE = "1";
  const scratch = extractAll(root, {});
  delete process.env.KEELDOCS_NO_CACHE;
  assert.equal(dump(partial), dump(scratch));
});

test("`_parsed` is engine plumbing and never reaches a fact", (t) => {
  const root = scenario(t);
  const r = extractAll(root, {});
  for (const f of r.factsById.values()) {
    assert.ok(!JSON.stringify(f.payload).includes("_parsed"),
      `${f.id} carries cache plumbing into the document`);
  }
  assert.ok(!dump(r).includes("_parsed"));
});


// ---------------------------------------------------------------------------
// D8: `nameless` moved from the provider's wire format into the engine. It is
// re-anchoring evidence (ADR-007 S2), so getting the rule wrong would not
// change a single fact hash - it would quietly degrade rename detection, which
// is worse, because nothing would fail.

test("a provider that omits `nameless` still yields it, derived, in the facts", () => {
  // ts-imports stopped emitting the field in D8. This runs the real provider
  // through the real engine and asserts the evidence survived the diet.
  const r = extractAll(join(ROOT, "fixtures", "symbols-scenario"), {});
  const syms = [...r.factsById.values()].filter((f) => f.payload.type === "symbol");
  assert.ok(syms.length > 0, "the fixture must produce symbols or this asserts nothing");
  for (const f of syms) {
    const n = f.provenance.nameless;
    assert.ok(Array.isArray(n) && n.length === f.payload.attrs.sigs.length,
      `${f.id} lost its re-anchoring evidence`);
  }
  const login = syms.find((f) => f.payload.attrs.name === "login");
  assert.ok(login, "expected the fixture's `login` symbol");
  assert.ok(login.provenance.nameless.every((x) => !x.includes(" login ")),
    "the declaration position must be anonymised, or S2 cannot match across a rename");
  assert.ok(login.provenance.nameless.some((x) => x.includes(" § ")));
});

test("the derivation replaces the FIRST occurrence only, and leaves a signature that never names the symbol alone", () => {
  // ported verbatim from the provider it replaced; these are the two cases that
  // rule actually has
  const derive = (name, sigs) =>
    sigs.map((sig) => sig.includes(` ${name} `) ? sig.replace(` ${name} `, " § ") : sig);
  assert.deepEqual(derive("login", ["function login ( string ) : login"]),
                   ["function § ( string ) : login"],
    "only the declaration position is anonymised; a return type that happens to share the name is not");
  assert.deepEqual(derive("Session", ["interface Session { user : string }"]),
                   ["interface § { user : string }"]);
  assert.deepEqual(derive("x", ["const y = <number>"]), ["const y = <number>"],
    "a signature that does not contain the delimited name is passed through untouched");
});
