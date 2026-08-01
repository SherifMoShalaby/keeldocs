import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  cacheEnabled, extractKey, fileDigest, hashAll, hashInputs, inputsUnmoved, providerCodeHash,
  readEntry, uncacheableReason, writeEntry,
} from "../src/cache.js";
import { resolveInputs, repoFiles } from "../src/scope.js";
import { extractAll } from "../src/facts.js";
import { jcs } from "../src/jcs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "kd-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const REG = { id: "acme", semver: "1.0.0", dir: join(ROOT, "src"), inputs: ["src/**/*.ts"] };

// The key under test, built the way extractAll builds it: from the SAME
// resolved input list the sandbox uses to decide what the provider may read.
function keyFor(root, reg = REG, extra = {}) {
  const resolved = resolveInputs(root, reg.inputs, repoFiles(root));
  return extractKey({
    reg, engine: "0.0.0-test", repoRoot: root, args: [root], tier: "rofs/minroot/scoped",
    detect: { via: "always", file: null }, env: [],
    files: hashInputs(root, resolved.files), factFiles: [], ...extra,
  });
}

// ---------------------------------------------------------------------------
// Invalidation. Every test here describes a way a cache could lie.

test("a changed byte in a declared input changes the key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "export const a = 1;", "src/b.ts": "x" });
  const before = keyFor(root);
  writeFileSync(join(root, "src/a.ts"), "export const a = 2;");
  assert.notEqual(keyFor(root), before, "same length, different content - a stat-based key would miss this");
});

test("a file that keeps its content but changes name changes the key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "same", "src/b.ts": "x" });
  const before = keyFor(root);
  rmSync(join(root, "src/a.ts"));
  writeFileSync(join(root, "src/c.ts"), "same");
  assert.notEqual(keyFor(root), before, "the path is part of the input, not just the bytes");
});

test("deleting a declared input changes the key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a", "src/b.ts": "b" });
  const before = keyFor(root);
  rmSync(join(root, "src/b.ts"));
  assert.notEqual(keyFor(root), before);
});

test("a NEW file matching the glob changes the key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a" });
  const before = keyFor(root);
  writeFileSync(join(root, "src/new.ts"), "brand new");
  assert.notEqual(keyFor(root), before,
    "a cache keyed only on files it already knew about would never see an addition");
});

test("a file the provider never declared does NOT change the key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a", "docs/readme.md": "hi", "src/style.css": "b{}" });
  const before = keyFor(root);
  writeFileSync(join(root, "docs/readme.md"), "completely different");
  writeFileSync(join(root, "src/style.css"), "b{color:red}");
  assert.equal(keyFor(root), before, "this is the entire point - editing prose must not re-run a TS parser");
});

test("the provider's own code is part of the key, semver or not", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a" });
  const code = tmpRepo(t, { "extract.py": "print('{}')", "provider.yaml": "id: acme" });
  const reg = { ...REG, dir: code };
  const before = keyFor(root, reg);
  writeFileSync(join(code, "extract.py"), "print('{\"vars\":[]}')");
  // providerCodeHash memoises per directory within a process, exactly as the
  // engine does across one run; a fresh path is how a real edit is observed
  const moved = tmpRepo(t, { "extract.py": "print('{\"vars\":[]}')", "provider.yaml": "id: acme" });
  assert.notEqual(keyFor(root, { ...reg, dir: moved }), before,
    "a provider edited without a version bump must not serve output the new code would never produce");
});

test("upstream facts are part of the key - a cross-capability read is an input", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a" });
  const before = keyFor(root, REG, { factFiles: [["db-schema", "hash-of-v1"]] });
  const after = keyFor(root, REG, { factFiles: [["db-schema", "hash-of-v2"]] });
  assert.notEqual(after, before);
});

test("the sandbox tier is part of the key - a different view is a different read", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a" });
  assert.notEqual(keyFor(root, REG, { tier: "none/host/wide" }),
                  keyFor(root, REG, { tier: "rofs/minroot/scoped" }));
});

test("an absent file is keyed as absent, and cannot collide with any content", () => {
  assert.equal(fileDigest("/nonexistent/nowhere.ts"), "absent");
  assert.equal(fileDigest(join(ROOT, "package.json")).length, 64, "sha-256 hex; 'absent' is 6 chars");
});

// ---------------------------------------------------------------------------
// Refusals. A provider the cache cannot key honestly must re-run, by name.

test("a live provider is never cached - its input is a database", () => {
  const why = uncacheableReason({ id: "tbls-live", live: true }, { files: ["a.ts"], dirs: [] });
  assert.match(why, /database, not the repository/);
});

test("a directory grant is never cached - a tree is not content-hashable", () => {
  const why = uncacheableReason({ id: "git-log" }, { files: [], dirs: [".git"] });
  assert.match(why, /directory grant \(\.git\)/);
});

test("a provider matching no files re-runs rather than caching an empty answer", () => {
  const why = uncacheableReason({ id: "fastapi" }, { files: [], dirs: [] });
  assert.match(why, /re-runs rather than caching an empty answer/);
  assert.equal(uncacheableReason({ id: "express" }, { files: ["a.ts"], dirs: [] }), null);
});

test("an input that moves WHILE a provider runs is not filed under the old key", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "before", "src/b.ts": "b" });
  const files = resolveInputs(root, REG.inputs, repoFiles(root)).files;
  const taken = hashInputs(root, files);            // key computed...
  assert.ok(inputsUnmoved(root, taken, files), "nothing moved");
  writeFileSync(join(root, "src/a.ts"), "after");   // ...provider runs, editor saves
  assert.equal(inputsUnmoved(root, taken, files), false,
    "the answer came from bytes the key never saw; storing it would serve it again when 'before' returns");
});

test("the per-run memo agrees with hashing each file directly", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a", "src/deep/b.ts": "b", "other.md": "m" });
  const all = repoFiles(root);
  const files = resolveInputs(root, REG.inputs, all).files;
  assert.deepEqual(hashInputs(root, files, hashAll(root, all)), hashInputs(root, files),
    "one pass per run must be indistinguishable from one pass per provider");
});

// ---------------------------------------------------------------------------
// The store.

test("an entry round-trips exactly; a different key misses; corruption misses", (t) => {
  const root = tmpRepo(t, { "x.txt": "" });
  const raw = { endpoints: [{ method: "GET", path: "/x" }], nested: { deep: [1, 2, null] } };
  writeEntry(root, "express", "key-one", raw);
  assert.deepEqual(readEntry(root, "express", "key-one"), raw);
  assert.equal(readEntry(root, "express", "key-two"), null, "a stale key is a miss, not a wrong hit");
  assert.equal(readEntry(root, "never-written", "key-one"), null);
  // a truncated/garbage entry must degrade to "do the work", never to a throw
  const dir = join(root, ".keeldocs", "cache", "extract");
  writeFileSync(join(dir, readdirSync(dir)[0]), Buffer.from("not gzip at all"));
  assert.equal(readEntry(root, "express", "key-one"), null);
});

test("a provider id that is not a safe filename still gets its own entry", (t) => {
  const root = tmpRepo(t, { "x.txt": "" });
  writeEntry(root, "acme/../evil provider", "k", { a: 1 });
  writeEntry(root, "acme/../other provider", "k", { a: 2 });
  assert.deepEqual(readEntry(root, "acme/../evil provider", "k"), { a: 1 },
    "sanitised names must not collide, or one provider serves another's output");
  assert.deepEqual(readEntry(root, "acme/../other provider", "k"), { a: 2 });
  assert.deepEqual(readdirSync(join(root, ".keeldocs", "cache", "extract")).length, 2);
});

test("the bypass really bypasses", () => {
  const prior = process.env.KEELDOCS_NO_CACHE;
  process.env.KEELDOCS_NO_CACHE = "1";
  assert.equal(cacheEnabled(), false);
  delete process.env.KEELDOCS_NO_CACHE;
  assert.equal(cacheEnabled(), true);
  if (prior !== undefined) process.env.KEELDOCS_NO_CACHE = prior;
});

// ---------------------------------------------------------------------------
// End to end. The only test that actually matters: a cached run and an
// uncached run of the same tree must be indistinguishable in their output.

const dump = (r) => jcs([...r.factsById.values()]
  .map((f) => ({ id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance }))
  .sort((a, b) => a.id.localeCompare(b.id)));

function scenarioRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "kd-cache-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, "fixtures", "init-scenario"), root, { recursive: true });
  rmSync(join(root, "golden"), { recursive: true, force: true });
  rmSync(join(root, ".keeldocs"), { recursive: true, force: true });
  return root;
}

test("warm equals cold, byte for byte", (t) => {
  const root = scenarioRepo(t);
  const cold = extractAll(root, {});
  assert.equal(cold.cache.hits, 0, "an empty cache cannot hit");
  const warm = extractAll(root, {});
  assert.ok(warm.cache.hits > 0, "nothing changed - something must have been reused");
  assert.equal(warm.cache.misses, 0);
  assert.equal(dump(warm), dump(cold), "a cached run that differs from an uncached one is the worst bug available");
});

test("an edit invalidates exactly what read it, and the result matches a from-scratch run", (t) => {
  const root = scenarioRepo(t);
  extractAll(root, {}); // populate
  const schema = join(root, "prisma", "schema.prisma");
  writeFileSync(join(root, "prisma", "schema.prisma"),
    readFileSync(schema, "utf8") + "\nmodel Widget {\n  id Int @id @default(autoincrement())\n  label String\n}\n");
  const cached = extractAll(root, {});
  assert.ok(cached.cache.misses > 0, "the schema changed - its provider must have re-run");
  assert.ok(cached.cache.hits > 0, "providers that never read the schema must NOT have re-run");

  process.env.KEELDOCS_NO_CACHE = "1";
  const truth = extractAll(root, {});
  delete process.env.KEELDOCS_NO_CACHE;
  assert.equal(truth.cache.hits, 0);
  assert.equal(dump(cached), dump(truth), "the new model must appear through the cache exactly as without it");
  assert.ok(dump(cached).includes("Widget"), "and it must actually be the edited schema, not a stale one");
});

test("a deleted file propagates through the cache", (t) => {
  const root = scenarioRepo(t);
  extractAll(root, {});
  rmSync(join(root, ".env.example"), { force: true });
  const cached = extractAll(root, {});
  process.env.KEELDOCS_NO_CACHE = "1";
  const truth = extractAll(root, {});
  delete process.env.KEELDOCS_NO_CACHE;
  assert.equal(dump(cached), dump(truth), "a removal is a change; a cache that only watches edits would miss it");
});
