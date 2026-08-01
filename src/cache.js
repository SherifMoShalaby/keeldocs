// D1 — incremental extraction (risk R10, measured by E8).
//
// Before this existed there was no cache of any kind, so "warm" and "cold" were
// the same operation: a one-character edit re-ran all 34 providers, and E8
// measured 5.7s / 10.0s / 31.8s for exactly that at 10k / 100k / 1M LOC. The
// dominant cost is not the engine - it is subprocesses. On a 100k-LOC synthetic
// monorepo one provider (sql-replay, which boots WASM Postgres and replays the
// migration chain) is 12.1s of a 19.7s extraction, and it depends on nothing
// but the migration files.
//
// So the cache boundary is the SUBPROCESS: a provider's raw stdout, keyed on
// everything that can change it. Normalized facts are deliberately NOT cached,
// because normalization reads facts other providers produced earlier in the
// same run (module-graph needs packages, sql-replay needs the declared tables).
// Caching upstream of that would make one provider's cache hit silently change
// another provider's input. Raw output has no such coupling.
//
// ---------------------------------------------------------------------------
// Why this is allowed to exist at all
//
// A cache is a claim that a computation need not be repeated. For a tool whose
// entire value is "the documentation is not lying to you", a wrong cache hit is
// the worst bug available - worse than being slow, worse than crashing. Three
// existing properties are what make it safe, and it would be unsafe without any
// one of them:
//
//   1. Providers are deterministic. E5 proves byte-identical output across
//      3 OSes x 2 runs on every CI push. A cache is only ever correct for a
//      pure function; E5 is the standing proof that these are pure.
//   2. `inputs` is an enforced contract, not documentation. Since the per-glob
//      scoping tier, a provider physically cannot read a file its manifest did
//      not declare - undeclared files do not exist inside its namespace. The
//      cache keys on THE SAME resolved list the sandbox grants, so "what could
//      have changed the answer" and "what the provider could read" are the same
//      set by construction, not by agreement.
//   3. Providers write nothing. The contract says JSON on stdout and no side
//      effects, and the read-only bind mount makes the kernel agree.
//
// The dependency runs the other way too, and is worth stating: on a host where
// scoping cannot be enforced (macOS, Windows, restricted Linux), property 2
// holds because CI enforces it on Linux, not because the local kernel does.
// That is the same weaker guarantee ADR-002 already documents for those hosts -
// the cache inherits it, it does not introduce it.
//
// ---------------------------------------------------------------------------
// Why content hashes and not git blob hashes
//
// R10's mitigation column says "shard cache on git blob hashes". Reading blob
// hashes out of git's index is cheap, but the index reflects the INDEX - to use
// it for the working tree you must additionally trust git's stat-based
// dirty-file detection. Its failure mode is a stale hash for a file that really
// changed, which is a silently wrong answer: precisely the class of bug this
// project exists to argue against.
//
// So this hashes content directly. The cost was measured before choosing:
// hashing every file in the 1M-LOC synthetic (5,603 files, 23.3 MB) takes
// 155 ms, against a 32-second extraction. Buying certainty for half a percent
// is not a trade-off worth agonising over.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { jcs } from "./jcs.js";

const CACHE_V = 1;

// The bypass. Env rather than a threaded option because extractAll has nine
// call sites and a cache you cannot turn off at any of them is not a cache, it
// is a liability.
export const cacheEnabled = () => process.env.KEELDOCS_NO_CACHE !== "1";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const shaHex = (s) => sha(Buffer.from(s, "utf8"));

// A file that vanished between the walk and the hash is a real state, and
// "absent" is a real key component. It cannot collide with any content: a
// sha-256 digest is 64 hex characters and this is 6.
export function fileDigest(abs) {
  try { return sha(readFileSync(abs)); } catch { return "absent"; }
}
const hashFile = fileDigest;

// The provider's own code. Semver alone is not enough: during development a
// provider changes without a version bump, and a cache that survived that would
// serve output the current code would never produce.
const codeCache = new Map();
export function providerCodeHash(dir) {
  if (codeCache.has(dir)) return codeCache.get(dir);
  const parts = [];
  const walk = (d, rel) => {
    let names;
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (name === "__pycache__" || name === "fixtures") continue;
      const abs = join(d, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) parts.push(`${r}:${hashFile(abs)}`);
    }
  };
  walk(dir, "");
  const h = shaHex(parts.join("\n")).slice(0, 32);
  codeCache.set(dir, h);
  return h;
}

// ---------------------------------------------------------------------------
// Cacheability
//
// Two provider shapes are refused outright, and both refusals are the honest
// answer rather than a limitation to apologise for.
export function uncacheableReason(reg, resolved) {
  // A live provider reads a database. Its inputs are not in the repository at
  // all, so no repository-derived key can describe them.
  if (reg.live) return "live provider: input is a database, not the repository";
  // A directory grant (git-log's `.git/`) is a whole tree the engine hands over
  // wholesale. Hashing it is neither cheap nor meaningful - `.git` changes on
  // every commit, fetch and gc - so this provider re-runs every time and says
  // so, rather than being keyed on something that only looks like its input.
  if (resolved.dirs.length) return `directory grant (${resolved.dirs.join(", ")}): tree is not content-hashable`;
  // A provider whose globs match nothing HERE could be cached on its empty
  // input set - under scoping its view is empty, so empty output is provably
  // correct. It is refused anyway, and deliberately: an empty resolved set is
  // also what an under-declaring manifest looks like, and on a host that cannot
  // enforce scoping the two are indistinguishable. Re-running costs ~40-80ms
  // per such provider; a permanently cached empty answer would cost the truth.
  if (!resolved.files.length) return "declares no matching files in this repo - re-runs rather than caching an empty answer";
  return null;
}

// ---------------------------------------------------------------------------
// The key
//
// Everything that can change a provider's stdout, and nothing that cannot. A
// component missing from here is a stale-hit bug; a volatile component added
// here is a cache that never hits. Both are failures, so each entry below earns
// its place:
export function extractKey({ reg, engine, repoRoot, args, tier, detect, files, factFiles, env }) {
  return shaHex(jcs({
    v: CACHE_V,
    engine,                              // arg shape and contract can change between engines
    provider: `${reg.id}@${reg.semver}`,
    code: providerCodeHash(reg.dir),     // the code as it is on disk right now
    args,                                // argv is part of the call, not of the repo
    root: repoRoot,                      // providers receive an absolute root
    tier,                                // a scoped view is a different readable tree
    detect,                              // which file detection picked (argMode: schemaFile)
    env,                                 // names of the env vars the contract sets
    files,                               // [rel, contentHash][] - EXACTLY the sandbox's grant list
    factFiles,                           // upstream capability facts, by content
  })).slice(0, 40);
}

// One hash per file per RUN, not per provider. Thirty-four providers with
// overlapping globs would otherwise hash popular files a dozen times each;
// providers write nothing, so a file cannot change mid-run and one pass is
// both correct and the 155 ms measured above.
export function hashAll(repoRoot, rels) {
  const m = new Map();
  for (const rel of rels) m.set(rel, fileDigest(join(repoRoot, rel)));
  return m;
}

// [rel, hash][] for one provider's resolved input set, sorted. `memo` is the
// per-run pass; a path outside it (resolveInputs walks skipped directories on
// demand) is hashed here instead of being silently keyed as absent.
export function hashInputs(repoRoot, rels, memo = null) {
  return rels.map((rel) => [rel, memo?.get(rel) ?? fileDigest(join(repoRoot, rel))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Time-of-check to time-of-use. The key is computed BEFORE the provider runs;
// if a file changes in between (an editor saving, a build writing, a rebase),
// the provider reads the new bytes and the answer would be filed under the old
// key. Nothing is wrong until that exact old state recurs - a `git checkout`
// away - and then the cache serves an answer computed from different input.
// Re-hashing after the run costs one extra pass on a MISS only, which is
// already the path measured in seconds.
export function inputsUnmoved(repoRoot, before, rels) {
  return jcs(before) === jcs(hashInputs(repoRoot, rels));
}

// ---------------------------------------------------------------------------
// The store
//
// One entry per provider, gzipped. One entry rather than N because the workflow
// this exists for is forward progress - edit, check, edit, check - and an LRU
// of raw extractor output would put tens of megabytes in every repository to
// serve branch-flipping, which `check --since` already handles by extracting in
// its own worktree. Flipping branches misses; that is a stated limit, not a
// silent one.
const dirFor = (repoRoot) => join(repoRoot, ".keeldocs", "cache", "extract");
const fileFor = (repoRoot, id) =>
  join(dirFor(repoRoot), `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${shaHex(id).slice(0, 8)}.json.gz`);

export function readEntry(repoRoot, id, key) {
  const p = fileFor(repoRoot, id);
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
    // A corrupt or foreign entry is a miss, never a throw: a cache must degrade
    // to "do the work" and never to "fail the run".
    if (e?.v !== CACHE_V || e.key !== key) return null;
    return e.raw;
  } catch { return null; }
}

export function writeEntry(repoRoot, id, key, raw) {
  try {
    mkdirSync(dirFor(repoRoot), { recursive: true });
    // write-then-rename: two checks running in the same repository must not be
    // able to leave a half-written entry behind. A torn file would be caught by
    // readEntry's catch and treated as a miss, so this is belt to that brace -
    // but the brace costs a full re-extraction every run until someone notices.
    const final = fileFor(repoRoot, id);
    const tmp = `${final}.${process.pid}.tmp`;
    writeFileSync(tmp, gzipSync(Buffer.from(jcs({ v: CACHE_V, key, raw }), "utf8")));
    renameSync(tmp, final);
  } catch { /* an unwritable cache dir slows the tool; it must never break it */ }
}
