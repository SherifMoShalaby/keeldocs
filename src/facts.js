// Fact extraction: detect providers, run them as subprocesses (the provider
// contract - JSON on stdout, engine writes all artifacts), normalize raw
// extractor output into the fact schema, write canonical JSONL fact files.
//
// ADR-008 discipline: the HASHED payload is {schema_version, type, attrs} only.
// Provider identity, source files/lines, engine version = provenance, OUTSIDE
// the hash - provider swaps and upgrades must never manufacture drift.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "./jcs.js";
import { factHash } from "./hash.js";
import { toPosix } from "./paths.js";
import { resolveClaims, parsePins } from "./resolve.js";
import { loadExternalProviders, orderEntries } from "./providers.js";
import { refusalOf, loadLock, parseTrustedKeys } from "./trust.js";
import { REGISTRY, REGISTRY_ERROR, ENGINE_VERSION } from "./registry.js";
import { repoFiles, resolveInputs, buildView, pathScope } from "./scope.js";
import { minimalRootPlan, STAGE } from "./minroot.js";
import { cacheEnabled, clearHandoff, extractKey, fileDigest, hashAll, hashInputs, inputsUnmoved, loadPerFile,
         readEntry, savePerFile, uncacheableReason, writeEntry, writeHandoff } from "./cache.js";

// fileURLToPath, never URL.pathname (Windows: "/D:/..." breaks join - item 10)
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".keeldocs", "golden", "coverage"]);

function walk(root, pred, out = [], dir = root) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(root, pred, out, p);
    else if (pred(name)) out.push(p);
  }
  return out;
}

// `allFiles` is the ONE repo walk (src/scope.js), reused here instead of
// re-walking per provider. Detection ran its own recursive walk for every
// provider that names files - 20-odd full traversals of the tree, ~50ms each at
// 1M LOC, for a list already in memory. The walk orders are identical (same
// skip set, same sorted depth-first order), so "first match" is unchanged.
const firstNamed = (repoRoot, allFiles, names) => {
  for (const rel of allFiles) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (names.includes(base)) return join(repoRoot, rel);
  }
  return null;
};

function detect(reg, repoRoot, allFiles) {
  if (reg.detect.always) return { applicable: true, via: "always" };
  const pkgPath = join(repoRoot, "package.json");
  if (reg.detect.deps && existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (reg.detect.deps.some((d) => d in all)) return { applicable: true, via: "dependency" };
    } catch { /* unreadable manifest -> fall through to file detection */ }
  }
  if (reg.detect.files) {
    const found = firstNamed(repoRoot, allFiles, reg.detect.files);
    if (found) return { applicable: true, via: "file", file: found };
  }
  if (reg.detect.dirs) { // fixed repo-relative dirs (e.g. migration chains)
    for (const d of reg.detect.dirs) {
      if (existsSync(join(repoRoot, d))) return { applicable: true, via: "dir" };
    }
  }
  return { applicable: false };
}

// timeout classes from the provider contract - C is the heavy code tier
const TIMEOUTS = { A: 10_000, B: 30_000, C: 120_000, D: 60_000 };

// D2 (risk R10). ADR-002's output cap was the constant 5MB, and E8 found the
// 1M-LOC monorepo dying on it: `ts-imports` emitted 46.9MB and the run exited 2
// with no documents written.
//
// The measurement is what decided the fix. 46.9MB is not bloat - it is
// **2.02x the provider's own declared input**, which for a symbol extractor
// emitting a signature per declaration is exactly proportional. Across every
// provider at 1M LOC the largest ratio on a non-trivial input is that same
// 2.02x. So the provider was behaving correctly and the CONSTANT was the
// defect: a fixed byte count cannot express "do not let a provider run away",
// because what counts as runaway depends entirely on how much it was given.
//
// The roadmap's named remedy - shard the provider's input - was measured and
// REJECTED as unsound rather than merely awkward. ts-imports resolves import
// specifiers against the walked file set (1,000 of 1,400 modules in the 100k
// tree carry a resolved cross-file edge), so a shard boundary silently
// reclassifies an internal edge as external. A module graph that quietly loses
// a thousand edges is the exact failure this project exists to refuse, and it
// would pass every test that only checks the run completed.
//
// So the bound becomes a function of the input:
//   * FLOOR is the old constant, so nothing that passes today can fail
//     tomorrow, and a provider whose input the engine cannot size (a directory
//     grant like git-log's `.git/`) keeps precisely today's behaviour.
//   * RATIO 6 is three times the largest ratio measured at scale.
//   * CEIL comes from the memory this actually costs: capturing 46.9MB moved
//     RSS by 94MB and parsing it by a further 50MB, so ~3x the output. Against
//     R10's 2GB budget with ~900MB already in use, 256MB of output is ~2x
//     inside the headroom.
// The kill MECHANISM is unchanged - maxBuffer still terminates the child - so
// runaway protection is not weakened, only expressed against the right scale.
const OUTPUT_CAP_FLOOR = 5 * 1024 * 1024;
const OUTPUT_CAP_RATIO = 6;
const OUTPUT_CAP_CEIL = 256 * 1024 * 1024;
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

export const outputCapFor = (inputBytes) =>
  Math.min(OUTPUT_CAP_CEIL, Math.max(OUTPUT_CAP_FLOOR, OUTPUT_CAP_RATIO * inputBytes));

// WHICH of the three rules bound, in words. A message that says only "cap
// exceeded (5MB)" leaves a user on a large monorepo with nothing to act on,
// and - worse - naming the ratio when the FLOOR is what actually bound would
// be an explanation that is not true.
export function capRule(inputBytes) {
  const proportional = OUTPUT_CAP_RATIO * inputBytes;
  if (proportional <= OUTPUT_CAP_FLOOR) {
    return `the ${mb(OUTPUT_CAP_FLOOR)} floor - ${mb(inputBytes)} of declared input would allow less`;
  }
  if (proportional >= OUTPUT_CAP_CEIL) {
    return `the ${mb(OUTPUT_CAP_CEIL)} absolute ceiling (memory), reached at ${mb(OUTPUT_CAP_CEIL / OUTPUT_CAP_RATIO)} of input`;
  }
  return `${OUTPUT_CAP_RATIO}x its ${mb(inputBytes)} of declared input`;
}

// ADR-002 sandbox (R2 + its FS slice), best-effort in three honest tiers:
//   "rofs"  linux + user/mount namespaces: NETWORK deny-all AND the repo
//           bind-mounted READ-ONLY - which also makes the purity rule
//           mechanical (the contract says providers emit JSON and write
//           nothing; now the kernel agrees)
//   "net"   linux with netns but no usable mount namespace: network only
//   "none"  macOS/Windows/restricted hosts: subprocess+timeout, the
//           ADR-013 documented weaker guarantee
// `live` providers keep their declared network:db exception in every tier.
// Probed ONCE per process against the real primitives, never assumed.
// Note: inside a wrapper a missing interpreter surfaces as the wrapper's exit
// code, not ENOENT; the python3->python fallback still covers the platforms
// that need it (their probe lands on "none" anyway).
const RO_SCRIPT = 'mount --bind "$1" "$1" && mount -o remount,ro,bind "$1" && shift && exec "$@"';

// Per-glob read scoping (ADR-002's last sandbox debt, src/scope.js). Argument
// shape: <view> <root> <pairCount> [<src> <dst>]... -- <cmd>...
// Directory grants are bound INTO the view first, while paths still resolve
// against the real tree; `--rbind` then carries those child mounts along when
// the view lands on the repo path. `cd` is not optional: a process keeps the
// cwd INODE across a mount, so without it every relative read would still land
// in the unscoped repository.
const SCOPE_SCRIPT = [
  'view=$1; root=$2; n=$3; shift 3',
  'while [ "$n" -gt 0 ]; do',
  '  mount --bind "$1" "$2" || exit 91',
  '  mount -o remount,ro,bind "$2" || exit 92',
  '  shift 2; n=$((n-1))',
  'done',
  'mount --rbind "$view" "$root" || exit 93',
  'mount -o remount,ro,bind "$root" || exit 94',
  'cd "$root" || exit 95',
  'exec "$@"',
].join("\n");

// MINIMAL ROOT (ADR-002's last residual, src/minroot.js). Argument shape:
//   <view> <root> <nGrants> [<src> <dst>]... <nKeeps> [<path>]... <nMasks> [<path>]... <cmd>...
// Order is the whole design. Everything that must survive is bound into a
// staging tmpfs while real paths still resolve; only then is the host masked;
// only then are the survivors re-exposed at their ORIGINAL paths, so no runtime
// has to be told it moved. The staging area is masked again at the end.
export const MINROOT_SCRIPT = [
  `stage=${STAGE}/keeldocs`,
  `mount -t tmpfs none ${STAGE} || exit 90`,
  'mkdir -p "$stage" || exit 90',
  ': > "$stage/keeps" || exit 90',
  'view=$1; root=$2; shift 2',
  'n=$1; shift',                        // directory grants, bound into the view
  'while [ "$n" -gt 0 ]; do',
  '  mount --bind "$1" "$2" || exit 91',
  '  mount -o remount,ro,bind "$2" || exit 92',
  '  shift 2; n=$((n-1))',
  'done',
  'mkdir -p "$stage/view" || exit 93',  // rbind so the grants ride along
  'mount --rbind "$view" "$stage/view" || exit 93',
  'k=$1; shift; i=0',
  'while [ "$k" -gt 0 ]; do',
  '  i=$((i+1)); mkdir -p "$stage/k$i" || exit 97',
  '  mount --rbind "$1" "$stage/k$i" || exit 97',
  '  printf "%s\\n" "$1" >> "$stage/keeps" || exit 97',
  '  shift; k=$((k-1))',
  'done',
  'm=$1; shift',                        // the host disappears here
  'while [ "$m" -gt 0 ]; do',
  '  mount -t tmpfs -o mode=0755 none "$1" || exit 96',
  '  shift; m=$((m-1))',
  'done',
  'i=0',                                // survivors return to their real paths
  'while IFS= read -r d; do',
  '  i=$((i+1))',
  '  mkdir -p "$d" || exit 98',
  '  mount --rbind "$stage/k$i" "$d" || exit 98',
  '  mount -o remount,ro,bind "$d" || exit 98',
  'done < "$stage/keeps"',
  'mkdir -p "$root" || exit 94',
  'mount --rbind "$stage/view" "$root" || exit 94',
  'mount -o remount,ro,bind "$root" || exit 94',
  `mount -t tmpfs none ${STAGE} || exit 90`,   // hide the staging area itself
  'cd "$root" || exit 95',
  'exec "$@"',
].join("\n");

const SANDBOX = (() => {
  if (process.platform !== "linux") return "none";
  const ok = (args) => {
    try { return spawnSync("unshare", args, { encoding: "utf8" }).status === 0; }
    catch { return false; }
  };
  if (ok(["-rnm", "--", "/bin/sh", "-c", RO_SCRIPT, "sh", "/tmp", "/bin/true"])) return "rofs";
  if (ok(["-rn", "true"])) return "net";
  return "none";
})();
// The child's environment. NODE_EXTRA_CA_CERTS is dropped deliberately: it
// points at a host path the minimal root masks, and the sandbox denies network
// anyway, so keeping it only produces a warning on the stderr the engine
// captures into failure reports.
function childEnv(extra = {}) {
  const e = { ...process.env, ...extra };
  delete e.NODE_EXTRA_CA_CERTS;
  return e;
}

// MINIMAL-ROOT PROBE. Same discipline as every other sandbox tier here: run the
// real primitive and see, never assume. A wrapper the interpreters cannot start
// inside is worse than no wrapper, so this falls back to the repo-scoped tier
// with a NAMED reason rather than failing every provider.
const MINROOT = (() => {
  if (SANDBOX !== "rofs") return { ok: false, reason: "needs the rofs tier" };
  let plan;
  try { plan = minimalRootPlan([ENGINE_ROOT]); }
  catch (err) { return { ok: false, reason: `plan failed: ${String(err.message)}` }; }
  let probe;
  try {
    probe = mkdtempSync(join(tmpdir(), "keeldocs-minroot-"));
    mkdirSync(join(probe, "view"), { recursive: true });
    mkdirSync(join(probe, "root"), { recursive: true });
    const wrap = (bin, args) => ["-rnm", "--", "/bin/sh", "-c", MINROOT_SCRIPT, "sh",
      join(probe, "view"), join(probe, "root"), "0",
      String(plan.keeps.length), ...plan.keeps,
      String(plan.masks.length), ...plan.masks, bin, ...args];
    const run = (bin, args) => spawnSync("unshare", wrap(bin, args), { encoding: "utf8", env: childEnv() });
    if (run(process.execPath, ["-e", "process.exit(0)"]).status !== 0) {
      return { ok: false, reason: "node cannot start inside the minimal root" };
    }
    // tree-sitter is what the whole declarative tier imports. If it works on the
    // host but not inside, the mask took something a provider needs - degrade
    // rather than break every .scm provider on this machine.
    const py = (code) => ["python3", "python"].map((b) => run(b, ["-c", code]))
      .some((r) => r.status === 0);
    if (!py("import sys")) return { ok: false, reason: "python cannot start inside the minimal root" };
    if (!py("import tree_sitter")) {
      const outside = ["python3", "python"].some((b) =>
        spawnSync(b, ["-c", "import tree_sitter"], { encoding: "utf8" }).status === 0);
      if (outside) return { ok: false, reason: "tree_sitter is importable on this host but not inside the minimal root" };
    }
    return { ok: true, plan };
  } catch (err) {
    return { ok: false, reason: String(err.message) };
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
})();

export const sandboxState = () => ({ tier: SANDBOX, netns: SANDBOX !== "none",
  scoping: SANDBOX === "rofs" ? "per-glob" : "none",
  root: MINROOT.ok ? "minimal" : "host",
  ...(MINROOT.ok ? {} : { rootReason: MINROOT.reason }) });

// The provider's view of the repository: its declared globs, minus the
// security exclusion set, plus the fact files the engine hands it and - when
// keeldocs is installed INSIDE the repo it is reading - the engine's own tree,
// without which the provider's entry file would not exist to run.
function viewFor(reg, repoRoot, scope, resolved) {
  const dir = join(scope.dir, reg.id);
  rmSync(dir, { recursive: true, force: true });
  // the SAME resolved list the cache keys on - one computation, so the readable
  // set and the invalidation set cannot drift apart
  const files = [...resolved.files], dirs = resolved.dirs;
  for (const p of Object.values(scope.factEnv ?? {})) {
    const rel = toPosix(relative(repoRoot, p));
    if (rel && !rel.startsWith("..")) files.push(rel);
  }
  // A T2 provider installed under `.keeldocs/providers/` lives inside the very
  // repository it reads, so its OWN code has to be in the view or it has no
  // entry file to execute. That directory is hash-pinned and PR-reviewed by
  // construction (ADR-002 R2), so granting a provider its own source grants it
  // nothing it did not already ship.
  const links = [...scope.engineRel];
  if (reg.external) {
    const rel = toPosix(relative(repoRoot, reg.dir));
    if (rel && !rel.startsWith("..")) links.push(rel);
  }
  const { mounts } = buildView(repoRoot, dir, { files, dirs, links });
  return { dir: toPosix(dir), mounts };
}

// The exact argv a provider receives. Split out of runProvider because the
// cache key must contain it: same repo, different args, different answer.
// Every match, not just the first. `argMode: schemaFile` makes DETECTION double
// as file SELECTION, and `firstNamed` picks one entry out of a sorted
// depth-first walk. Measured on `main` before this existed: a monorepo with
// `apps/api/prisma/schema.prisma` and `apps/billing/prisma/schema.prisma`
// documented `User` and nothing else - `Invoice` and `LineItem` were absent
// with NO gap, and `check` reported CLEAN at "3/3 surfaces documented (100%)".
// A coverage ratio whose denominator silently dropped a whole service is wrong
// in both terms. `drizzle` and `sql-replay` both already name what they skipped
// (`chain-ignored`); the one provider that could not was the most used one.
const allNamed = (allFiles, names) =>
  allFiles.filter((rel) => names.includes(rel.slice(rel.lastIndexOf("/") + 1)));

function argsFor(reg, repoRoot, detectInfo, allFiles) {
  if (reg.argMode === "schemaFile") {
    // `detect.files` when the manifest has it: the hardcoded "schema.prisma"
    // below was a second copy of one provider's manifest, living in the engine.
    const names = reg.detect?.files?.length ? reg.detect.files : ["schema.prisma"];
    const found = allNamed(allFiles, names);
    // detect via `deps` carries no file, so the fallback is what usually runs -
    // a prisma repo names prisma in package.json, which wins before `files` is
    // ever consulted. Both paths take found[0]: same walk, same order, same set.
    const schema = detectInfo.file ?? (found.length ? join(repoRoot, found[0]) : null);
    if (!schema) return { args: null, ignored: [], ignoredKind: null };
    const chosen = toPosix(relative(repoRoot, schema));
    return { args: [schema], ignored: found.filter((rel) => rel !== chosen), ignoredKind: "schema-ignored" };
  }
  if (reg.argMode === "providerDir") return { args: [reg.dir, repoRoot], ignored: [], ignoredKind: null }; // .scm runtime: which provider + which repo
  // `argMode: detectedFile` is the same double duty one step out. These
  // providers are handed the repository root and then re-derive, at the root,
  // the very path detection had already proved somewhere else in the tree:
  // rails re-joined `config/routes.rb`, next-routes re-tested `app` and
  // `src/app`, compose re-walked its four filenames. Measured on `main` before
  // this existed, on a tree with `apps/api/config/routes.rb`,
  // `apps/web/app/**`, `deploy/docker-compose.yml` and
  // `packages/db/migrations/*.sql`: http-endpoints, client-routes,
  // services-topology and db-policies each reported `status: ok` with an empty
  // fact set, no gap of any kind, and `check` exited 0. Detection proving a
  // file and the extractor never being told which one is the same defect
  // `schemaFile` carried, and it is louder here because the answer is not a
  // smaller one - it is nothing at all.
  //
  // It is opt-in per manifest rather than the default for `root`, because most
  // root-mode providers walk the whole tree and their unchosen `detect.files`
  // matches are read, not skipped: naming `aspnet`'s second `Program.cs` or
  // `django`'s second `manage.py` as ignored would be a manufactured gap.
  if (reg.argMode === "detectedFile") {
    const found = allNamed(allFiles, reg.detect?.files ?? []);
    // `deps` detection carries no file; fall back to the same walk order the
    // `schemaFile` branch uses so the two modes cannot disagree about which
    // match wins.
    const picked = detectInfo.file ?? (found.length ? join(repoRoot, found[0]) : null);
    if (!picked) return { args: [repoRoot], ignored: [], ignoredKind: null };
    const chosen = toPosix(relative(repoRoot, picked));
    // Root first, so an extractor that ignores argv[2] keeps its old behaviour
    // and every committed golden is byte-stable.
    return { args: [repoRoot, picked], ignored: found.filter((rel) => rel !== chosen),
             ignoredKind: "candidate-ignored" };
  }
  return { args: [repoRoot], ignored: [], ignoredKind: null };
}

function runProvider(reg, repoRoot, args, factEnv = {}, scope = null, resolved = null, inputBytes = 0) {
  const cap = outputCapFor(inputBytes);
  // externals resolve from their installed dir (absEntry); first-party from the engine tree
  const entryPath = reg.absEntry ?? join(ENGINE_ROOT, reg.entry);
  const tier = reg.live ? "none" : SANDBOX; // live keeps its declared network:db
  // Per-glob scoping rides the rofs tier: the view REPLACES the repository the
  // provider sees, so the read-only guarantee is unchanged and the READABLE
  // set shrinks to exactly what the manifest declared.
  const view = tier === "rofs" && scope ? viewFor(reg, repoRoot, { ...scope, factEnv }, resolved) : null;
  const wrap = (bin) => view && MINROOT.ok
    // minimal root: the host is masked and only the runtime, the engine and
    // this provider's own view survive
    ? ["unshare", ["-rnm", "--", "/bin/sh", "-c", MINROOT_SCRIPT, "sh", view.dir, repoRoot,
        String(view.mounts.length), ...view.mounts.flat(),
        String(MINROOT.plan.keeps.length), ...MINROOT.plan.keeps,
        String(MINROOT.plan.masks.length), ...MINROOT.plan.masks, bin, entryPath, ...args]]
    : view
    ? ["unshare", ["-rnm", "--", "/bin/sh", "-c", SCOPE_SCRIPT, "sh", view.dir, repoRoot,
        String(view.mounts.length), ...view.mounts.flat(), bin, entryPath, ...args]]
    : tier === "rofs"
    ? ["unshare", ["-rnm", "--", "/bin/sh", "-c", RO_SCRIPT, "sh", repoRoot, bin, entryPath, ...args]]
    : tier === "net"
    ? ["unshare", ["-rn", "--", bin, entryPath, ...args]]
    : [bin, [entryPath, ...args]];
  const spawnWith = (bin) => spawnSync(...wrap(bin), {
    cwd: repoRoot, timeout: TIMEOUTS[reg.timeoutClass] ?? TIMEOUTS.D,
    maxBuffer: cap, encoding: "utf8",
    env: childEnv(factEnv),
  });
  try {
    let r;
    if (reg.exec === "node") {
      r = spawnWith(process.execPath); // the running node - no PATH guessing
    } else {
      r = spawnWith("python3");
      if (r.error?.code === "ENOENT") r = spawnWith("python"); // Windows installs often lack a python3 shim
    }
    if (r.status !== 0 || r.error) {
      // Name the bound AND where it came from. "output cap exceeded (5MB)" told
      // a user on a large monorepo nothing they could act on; this says how big
      // the allowance was and what set it, so an over-cap provider is either
      // obviously runaway or obviously worth a manifest conversation.
      const reason = r.error?.code === "ENOBUFS"
        ? `output cap exceeded (${mb(cap)}, ADR-002: ${capRule(inputBytes)})`
        : r.error ? String(r.error.message) : `rc=${r.status}`;
      return { status: "failed", reason, stderr: (r.stderr || "").slice(-400) };
    }
    try {
      return { status: "ok", raw: JSON.parse(r.stdout) };
    } catch {
      return { status: "failed", reason: "bad-json-output" };
    }
  } finally {
    // The view is torn down on EVERY path out, including a crashing provider.
    // It lives inside the repository (hardlinks need one filesystem), so a
    // leaked view is not merely litter: any tool that walks without skipping
    // `.keeldocs` would read the engine's own scratch space as repository
    // source. Teardown is the guarantee; extractors skipping `.keeldocs` is
    // the belt to its braces.
    if (view) rmSync(view.dir, { recursive: true, force: true });
  }
}

function envFacts(raw, provenanceBase) {
  const facts = [];
  for (const v of raw.vars ?? []) {
    facts.push({
      id: `fact:config-surface/${v.name}`,
      // Low-noise drift semantics: the hashed payload carries the var's STATUS
      // (read anywhere? declared anywhere?), not every read site - adding a
      // second read of DATABASE_URL is not documentation drift. Sites live in
      // provenance. Values do not exist in this schema, structurally (ADR-013).
      payload: { schema_version: 1, type: "env-var",
        attrs: { name: v.name, read_in_code: !!v.read_in_code, declared_in_example: !!v.declared_in_example } },
      provenance: { ...provenanceBase,
        source: (v.sources ?? []).slice(0, 20).map((s) => ({ file: s.file, line: s.line, kind: s.kind })) },
    });
  }
  // `gaps: []` was hardcoded here - the third and last survivor of the class
  // that made `drizzle` declare `extraction-gap` while being structurally
  // unable to produce one, and that made `workspace-layout` collapse a
  // three-member workspace to one package in silence. A config-surface provider
  // that cannot say "I could not read this .env.example" has no way to report a
  // blind spot at all, and the engine would drop the sentence even if it did.
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

// The re-anchoring matcher (ADR-007 S2) compares NAMELESS signature sets, so a
// rename does not look like a deletion. It was a provider-emitted field until
// D8 measured it as the single largest thing on the wire (10.71 MB of a 36.7 MB
// payload at 1M LOC) and provably a pure function of what was already there -
// exact on all 190,400 symbols. Providers may still send it; when they do not,
// it is derived here with the identical rule, so the two spellings cannot drift.
const namelessOf = (name, sigs) =>
  (sigs ?? []).map((sig) => sig.includes(` ${name} `) ? sig.replace(` ${name} `, " § ") : sig);

function moduleGraphFacts(raw, provenanceBase, packages) {
  // Longest-prefix package owner; "." (single-package root) matches everything.
  const pkgFor = (path) => {
    let best = null;
    for (const p of packages) {
      if (p.path === "." || path === p.path || path.startsWith(p.path + "/")) {
        if (!best || p.path.length > best.path.length) best = p;
      }
    }
    return best?.name ?? ".";
  };
  const facts = [];
  for (const m of raw.modules ?? []) {
    facts.push({
      id: `fact:module-graph/${m.path}`,
      payload: { schema_version: 1, type: "module",
        // provider-emitted package (declared ${facts:workspace-layout} read,
        // contract 9) wins; engine injection is the standalone-run fallback
        attrs: { path: m.path, package: m.package ?? pkgFor(m.path),
                 imports: (m.imports ?? []).map((i) => i.resolved ?? i.specifier).sort() } },
      provenance: { ...provenanceBase, source: [{ file: m.path }] },
    });
  }
  // D11: two accepted shapes, one loop. `symbols` is the flat form every
  // module-graph provider has always emitted; `symbolFiles` groups them under
  // their file so `path` and `package` are written once instead of once per
  // symbol. At 1M LOC that is 8.78 MB of a 25.81 MB payload - 5,200 paths
  // repeated 190,400 times - and `package` verified constant within a file on
  // all 5,200. `kind` deliberately does NOT hoist: it is uniform per file in
  // the synthetic corpus and varies per file in real code (the fixture has
  // const + interface + function in one module), which is exactly the
  // generalisation a synthetic benchmark would have talked you into.
  // Additive, like `nameless`: providers still emitting the flat form are
  // untouched, and only ts-imports moved.
  const flatSymbols = raw.symbols ?? (raw.symbolFiles ?? []).flatMap((f) =>
    (f.symbols ?? []).map((s) => ({ ...s, path: f.path, package: s.package ?? f.package ?? null })));
  for (const s of flatSymbols) {
    // ADR-007 symbol identity: `ds <pkg> <version|.> <module-path>/<descriptor>`.
    // Suffix per SCIP shape: callables `().`, types `#`, terms `.`.
    const suffix = s.kind.includes("function") ? "()."
      : ["class", "interface", "type", "enum", "namespace"].some((k) => s.kind.includes(k)) ? "#" : ".";
    const pkg = s.package ?? pkgFor(s.path);
    facts.push({
      id: `ds ${pkg} . ${s.path}/${s.name}${suffix}`,
      // sigs are the hashed declaration shape (E2-validated); the nameless
      // variants are provenance-only matching aids for re-anchoring, and the
      // module path lives in the ID + attrs so a move IS an identity change (S1).
      payload: { schema_version: 1, type: "symbol",
        attrs: { name: s.name, module: s.path, package: pkg, kind: s.kind, sigs: s.sigs } },
      provenance: { ...provenanceBase, source: [{ file: s.path }],
                    nameless: s.nameless ?? namelessOf(s.name, s.sigs) },
    });
  }
  // `kind ?? "unknown"` threw away the receipt. The Django endpoints provider
  // reports its refusals as {file, reason} - a non-literal route, a regex route
  // it will not compose, a urlconf outside the repository - and every one reached
  // the report as the single word "unknown". A gap whose reason has been discarded
  // is indistinguishable from one nobody bothered to explain, in the channel this
  // project asks users to trust. Providers spell it `kind` or `reason`; both are
  // read, and a warning carrying neither says so rather than claiming ignorance.
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function liveTableFacts(raw, provenanceBase, declaredTables) {
  // Declared-beats-live (ADR-005): a live table already covered by a declared
  // provider is SKIPPED - exact lowercase match on the public schema only, no
  // pluralization guessing. Everything else lands with schema-qualified natural
  // keys (fact:db-schema/public.orders), the same payload shape as declared
  // tables, and INTROSPECTED confidence - so the ERD renders them unchanged.
  const declaredLower = new Set(declaredTables.map((n) => n.toLowerCase()));
  const facts = [];
  for (const t of raw.tables ?? []) {
    if (t.schema === "public" && declaredLower.has(t.table.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/${t.name}`,
      payload: { schema_version: 1, type: "table",
        attrs: { name: t.name,
          columns: (t.columns ?? []).map((c) => ({
            name: c.name, type: c.type, optional: !!c.nullable, list: false,
            attrs: c.default != null ? `default ${c.default}` : "",
          })),
          relations: (t.relations ?? []).map((r) => ({ field: r.field, target: r.target })) } },
      provenance: { ...provenanceBase, source: [{ kind: "live-catalog" }] },
    });
  }
  // Same hardcoded `gaps: []`. The declared-beats-live skip above is a
  // documented identity rule, but anything the live provider itself could not
  // read - a schema the role cannot see, a catalog entry it will not model -
  // had nowhere to go and was reported as a complete answer.
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function replayFacts(raw, provenanceBase, declaredTables, declaredEnums) {
  // The replay engine's catalog facts (doc 11 R1). Identity space is
  // schema-qualified SQL names (public.orders) like tbls-live; a DECLARED
  // provider's table/enum (prisma model space) covering the same lowercase
  // name wins and the replayed twin is SKIPPED - the same identity rule as
  // declared-beats-live, because the two id spellings can never meet inside
  // the resolver. Unifying the db identity space (@@map-aware) is named
  // follow-up work in doc 11 before replay may OVERRIDE declared facts.
  const declaredT = new Set(declaredTables.map((n) => n.toLowerCase()));
  const declaredE = new Set(declaredEnums.map((n) => n.toLowerCase()));
  const facts = [];
  for (const t of raw.tables ?? []) {
    if (t.schema === "public" && declaredT.has(t.table.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/${t.name}`,
      payload: { schema_version: 1, type: "table",
        attrs: { name: t.name,
          columns: (t.columns ?? []).map((c) => ({
            name: c.name, type: c.type, optional: !!c.nullable, list: false,
            attrs: c.default != null ? `default ${c.default}` : "",
          })),
          relations: (t.relations ?? []).map((r) => ({ field: r.field, target: r.target })) } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  for (const e of raw.enums ?? []) {
    const short = e.name.slice(e.name.indexOf(".") + 1);
    if (e.name.startsWith("public.") && declaredE.has(short.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/enum.${e.name}`,
      payload: { schema_version: 1, type: "enum", attrs: { name: e.name, values: e.values ?? [] } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  // Routines. Identity carries the IDENTITY ARGUMENT LIST, so overloads are
  // separate facts and a parameter RENAME is a new identity - correct for a
  // PostgREST app, where callers pass arguments by name and a rename breaks
  // them. body_digest inside the hashed payload is deliberate: a rewritten
  // body must stale the prose that describes what the function does.
  for (const fn of raw.functions ?? []) {
    facts.push({
      id: `fact:db-schema/fn.${fn.name}(${fn.signature ?? ""})`,
      payload: { schema_version: 1, type: "function",
        attrs: { name: fn.name, signature: fn.signature ?? "",
          arguments: fn.arguments ?? "", returns: fn.returns ?? "",
          kind: fn.kind ?? "function", set_returning: !!fn.set_returning,
          volatility: fn.volatility ?? "volatile", language: fn.language ?? "",
          security_definer: !!fn.security_definer,
          body_digest: fn.body_digest ?? "" } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  // Primary keys are their OWN fact, not a table attribute. Folding them into
  // the table payload would change every table hash on upgrade and stale every
  // ERD in existence for information that is an attribute OF a table rather
  // than a surface of its own - exactly the shape `rls` already has.
  for (const pk of raw.primary_keys ?? []) {
    if (!pk?.table) continue;
    facts.push({
      id: `fact:db-schema/pk.${pk.table}`,
      payload: { schema_version: 1, type: "pk",
        attrs: { table: pk.table, constraint: pk.constraint ?? "",
                 columns: pk.columns ?? [] } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  // Views and materialized views. A view IS a surface - PostgREST answers on
  // it - so it counts, and its WRITABILITY comes from the catalog rather than
  // from an assumption: a matview is never writable, and a plain view only
  // when it is auto-updatable or carries INSTEAD OF triggers.
  for (const v of raw.views ?? []) {
    facts.push({
      id: `fact:db-schema/view.${v.name}`,
      payload: { schema_version: 1, type: "view",
        attrs: { name: v.name, materialized: !!v.materialized,
          columns: (v.columns ?? []).map((c) => ({
            name: c.name, type: c.type, optional: !!c.nullable, list: false, attrs: "" })),
          insertable: !!v.insertable, updatable: !!v.updatable, deletable: !!v.deletable } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function messagingFacts(raw, provenanceBase) {
  // async-messaging (brief 3.1): the repo's declared topics/queues/channels.
  // transport IS hashed - migrating a channel redis->kafka is an architecture
  // change worth flagging; call SITES are provenance (a second publisher is
  // not documentation drift), same low-noise rule as env vars. `pattern` marks
  // a template-declared family (`ride:{}`) - honest shape, never a resolved guess.
  const facts = [];
  for (const c of raw.channels ?? []) {
    facts.push({
      id: `fact:async-messaging/${c.kind}.${c.name}`,
      payload: { schema_version: 1, type: "channel",
        attrs: { name: c.name, kind: c.kind, transport: c.transport,
                 role: c.role, pattern: !!c.pattern } },
      provenance: { ...provenanceBase, source: (c.files ?? []).slice(0, 20).map((f) => ({ file: f })) },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function routeFacts(raw, provenanceBase) {
  // client-routes (owner-requested, 2026-08-01): the app's screen inventory.
  // Route facts are NOT coverage surfaces (owner decision fixed the
  // denominator) but are fully bindable/drift-checkable via fact:client-routes/*.
  const facts = [];
  for (const r of raw.routes ?? []) {
    facts.push({
      id: `fact:client-routes/${r.path}`,
      payload: { schema_version: 1, type: "route", attrs: { path: r.path } },
      provenance: { ...provenanceBase, source: [{ file: r.file }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function policyFacts(raw, provenanceBase) {
  // Own capability so db-schema/* stays pure tables+enums (diagram noise
  // isolation + born-clean); db keys schema-qualified per ADR-007.
  const facts = [];
  for (const p of raw.policies ?? []) {
    facts.push({
      id: `fact:db-policies/policy.${p.schema}.${p.table}.${p.name}`,
      payload: { schema_version: 1, type: "policy",
        attrs: { schema: p.schema, table: p.table, name: p.name, command: p.command,
                 permissive: !!p.permissive, roles: p.roles ?? [],
                 using: p.using ?? null, with_check: p.with_check ?? null } },
      provenance: { ...provenanceBase, source: [{ file: p.file }] },
    });
  }
  for (const r of raw.rls ?? []) {
    facts.push({
      id: `fact:db-policies/rls.${r.schema}.${r.table}`,
      payload: { schema_version: 1, type: "rls",
        attrs: { schema: r.schema, table: r.table, enabled: !!r.enabled } },
      provenance: { ...provenanceBase, source: [{ file: r.file }] },
    });
  }
  // And the third. `sql-policies` is a PATTERN-tier parser by its own manifest -
  // it says so in its docstring, that exotic quoting "is simply not matched" -
  // so it is precisely the provider that most needs to be able to say what it
  // walked past. It could not, and neither could the engine on its behalf.
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function churnFacts(raw, provenanceBase) {
  const facts = [];
  for (const f of raw.files ?? []) {
    facts.push({
      id: `fact:decision-history/${f.path}`,
      // History facts move with history by nature - they rank the doc plan
      // (hotspot x fan-in) and are excluded from coverage; binding prose to
      // them is possible but self-inflicted noise.
      payload: { schema_version: 1, type: "churn",
        attrs: { path: f.path, commits: f.commits, last: f.last, authors: f.authors } },
      provenance: { ...provenanceBase, source: [{ file: f.path }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: null }));
  return { facts, gaps };
}

function packageFacts(raw, provenanceBase) {
  const facts = [];
  for (const p of raw.packages ?? []) {
    facts.push({
      id: `fact:workspace-layout/${p.name}`,
      // manager lives in the hashed payload deliberately: migrating pnpm->npm
      // IS a documented-architecture change, not provider noise.
      payload: { schema_version: 1, type: "package",
        attrs: { name: p.name, path: p.path, manager: raw.manager } },
      provenance: { ...provenanceBase, source: raw.file ? [{ file: raw.file }] : [] },
    });
  }
  // `gaps: []` was hardcoded here, so workspace-layout was structurally
  // incapable of reporting anything it could not resolve - the same defect
  // class as the db-schema normalizer that discarded `raw.warnings`. It made
  // the collapse to a single package total: a pnpm workspace declaring three
  // members reported one, an unparseable pnpm-workspace.yaml reported a
  // single-package repo, and both looked exactly like the truth from the
  // report, the coverage ratio and the rendered docs. Extraction gaps do not
  // move the exit code; a blind spot nobody is told about does worse than that.
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function serviceFacts(raw, provenanceBase) {
  const facts = [];
  for (const s of raw.services ?? []) {
    facts.push({
      id: `fact:services-topology/${s.name}`,
      // kind is the design's owned-vs-external split: build: = yours (owned),
      // image-only = someone else's software you depend on (external).
      payload: { schema_version: 1, type: "service",
        attrs: { name: s.name, kind: s.kind, image: s.image ?? null, build: s.build ?? null,
                 ports: s.ports ?? [], depends_on: s.depends_on ?? [] } },
      provenance: { ...provenanceBase, source: raw.file ? [{ file: raw.file }] : [] },
    });
  }
  // topology providers report honestly-unknown surface too (helm undeclared
  // values, kustomize overlays) - a gap dropped here would let a variant-shaped
  // unknown pass as complete truth
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function endpointFacts(raw, provenanceBase, repoRoot) {
  const facts = [];
  for (const e of raw.endpoints ?? []) {
    // Most endpoints are registered at a LINE of code. A derived surface
    // (PostgREST: the API is a total function of the catalog) has no such
    // line, and inventing a file for it would be a small lie in the one
    // column a reader trusts most - so it names the fact it derives from.
    const source = e.file
      ? [{ file: e.file, ...(e.line ? { line: e.line } : {}) }]
      : [{ kind: e.kind ?? "derived", ...(e.derived_from ? { from: e.derived_from } : {}) }];
    facts.push({
      id: `fact:http-endpoints/${e.method} ${e.path}`,
      payload: { schema_version: 1, type: "endpoint", attrs: { method: e.method, path: e.path } },
      provenance: { ...provenanceBase, source },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? w.reason ?? "unspecified", file: w.file ?? null }));
  return { facts, gaps };
}

function schemaFacts(raw, provenanceBase, schemaFile) {
  const facts = [];
  const src = [{ file: schemaFile }];
  // Enum-typed fields are COLUMNS, not relations - the extractor's uppercase
  // heuristic can't tell enums from model refs without this cross-check
  // (found by init-scenario: `status Status` was silently dropped).
  const enumNames = new Set((raw.enums ?? []).map((e) => e.name));
  for (const m of raw.models ?? []) {
    const columns = (m.fields ?? []).filter((f) => !f.is_relation_field || f.relation || enumNames.has(f.type)).map((f) => ({
      name: f.name, type: f.type, optional: !!f.optional, list: !!f.list, attrs: f.attrs ?? "",
    })); // ordered field - source order is semantic (ADR-008)
    const relations = (m.fields ?? []).filter((f) => f.relation).map((f) => ({
      field: f.name, target: f.type,
      fields: f.relation.fields ?? [], references: f.relation.references ?? [],
    })).sort((a, b) => a.field.localeCompare(b.field)); // set field - sorted by natural key
    facts.push({
      id: `fact:db-schema/${m.name}`,
      payload: { schema_version: 1, type: "table", attrs: { name: m.name, columns, relations } },
      provenance: { ...provenanceBase, source: src },
    });
  }
  for (const e of raw.enums ?? []) {
    facts.push({
      id: `fact:db-schema/enum.${e.name}`,
      payload: { schema_version: 1, type: "enum", attrs: { name: e.name, values: e.values ?? [] } },
      provenance: { ...provenanceBase, source: src },
    });
  }
  // The static db-schema normalizer discarded `raw.warnings` while every other
  // normalizer maps them, so no static schema provider could report anything it
  // could not determine. `drizzle` has declared `emits: [table, enum,
  // extraction-gap]` since N1 and was structurally incapable of producing the
  // third - its extractor really does emit a `chain-ignored` warning, and the
  // engine dropped it on the floor. A declared-but-unproducible fact type is the
  // blind spot the emits gate does not cover: it checks that everything emitted
  // was declared, not that everything declared can be emitted.
  return { facts, gaps: (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? String(w), file: w.file ?? null })) };
}

const capOf = (id) => id.startsWith("ds ") ? "module-graph" : id.slice(5, id.indexOf("/"));

// E10 injection barrier at the FACT boundary: no legitimate natural key or
// attribute ever contains HTML comment markers, but a hostile provider could
// use them to FORGE keeldocs anchors inside generated docs (the renderer
// interpolates fact strings into marker-bearing bodies). Such facts are
// dropped with a named gap - one choke point instead of per-render escaping.
const HOSTILE = /<!--|-->/;
export function isHostileFact(f) {
  const scan = (v) => typeof v === "string" ? HOSTILE.test(v)
    : Array.isArray(v) ? v.some(scan)
    : v && typeof v === "object" ? Object.values(v).some(scan) : false;
  return HOSTILE.test(f.id) || scan(f.payload?.attrs ?? {});
}

export function extractAll(repoRootIn, { disable = [], live = null, trustKeys = [], resolvePins = [], excludePaths = [] } = {}) {
  const repoRoot = resolve(repoRootIn); // subprocess cwd = repoRoot; args must be absolute
  if (REGISTRY_ERROR) {
    // fail closed and loudly - a half-loaded registry would masquerade as "no drift"
    return { factsById: new Map(), capabilities: {}, gaps: [], providerSetHash: null,
             toolError: `provider registry: ${REGISTRY_ERROR}` };
  }
  // T2 (R2): repo-local external providers join the registry ONLY behind the
  // full trust proof (lock + signature + trusted signer). Any refusal is a
  // loud tool error - a silently smaller registry is the failure mode.
  let registry = REGISTRY;
  try {
    const ext = loadExternalProviders(repoRoot, {
      refusalOf, lock: loadLock(repoRoot), trustedKeys: parseTrustedKeys(trustKeys) });
    if (ext.length) registry = orderEntries([...REGISTRY, ...ext]);
  } catch (err) {
    return { factsById: new Map(), capabilities: {}, gaps: [], providerSetHash: null,
             toolError: String(err.message) };
  }
  const pins = parsePins(resolvePins); // strict; loadConfig pre-validates
  const disabled = new Set(disable);
  // live providers run ONLY under --live (network never enters the default path)
  const active = registry.filter((r) => !disabled.has(r.id) && (!r.live || live));
  const capabilities = {};
  const factsById = new Map();
  const claimsById = new Map(); // id -> every provider's claim (ADR-003 resolution input)
  const gaps = [];
  let toolError = null;

  // Canonical fact files - byte-stable, diffable, gitignored (ADR-004). Written
  // INCREMENTALLY as each capability's provider group completes (the registry is
  // capability-major topo order), so a later provider's declared ${facts:cap}
  // read (provider contract §9) sees the complete upstream file. The dir is a
  // pure cache: cleared first so a capability that dropped to zero facts can't
  // leave a stale file lying about the current state.
  const factsDir = join(repoRoot, ".keeldocs", "cache", "facts");
  rmSync(factsDir, { recursive: true, force: true });
  mkdirSync(factsDir, { recursive: true });
  const capFile = (cap) => join(factsDir, `${cap}.jsonl`);

  // Per-glob read scoping context (ADR-002 FS slice II). The repo is walked ONCE
  // and every provider's view is a regex filter over that list. Scoping needs a
  // view to mount OVER the repository path, so the one case it cannot serve is
  // keeldocs reading the repository it is itself installed as: replacing the
  // repo root would remove the provider's own entry file. That degrades to the
  // repo-wide rofs tier with a NAMED gap rather than silently, because a
  // sandbox that quietly weakens is worse than one that says so.
  // ONE walk, now unconditional: scoping needs it to build views, detection
  // needs it to find manifests, and D1's cache needs it to know what each
  // provider could have read. Three consumers, one traversal.
  // KEEL-30: compiled once per extraction, not per fact.
  let scopedOut = 0;
  // Nested checkouts join the path scope. The walk already refuses to enter one,
  // which keeps it out of detection and out of the sandbox view; this keeps its
  // facts out of the answer on every host, including the ones where a provider
  // walks the tree itself and finds it regardless.
  const nested = [];
  const allFiles = repoFiles(repoRoot, excludePaths, nested);
  // ONE matcher, shared with the walk that just ran and with the doc sweep, so
  // the scope cannot mean one thing to the traversal and another to the fact
  // set. It matched the string only, which is why `exclude-paths = ["vendor"]`
  // pruned the directory here and matched none of the `vendor/…` FILES a fact
  // cites: the loudest half of the setting applied and the advertised half did
  // not. `pathScope` matches a path and everything under it, so a nested
  // checkout no longer needs its own `<n>/**` twin either.
  const outOfScope = pathScope([...excludePaths, ...nested]);
  const scoped = excludePaths.length > 0 || nested.length > 0;
  let scope = null;
  if (SANDBOX === "rofs") {
    const engineRel = toPosix(relative(repoRoot, ENGINE_ROOT));
    if (ENGINE_ROOT === repoRoot) {
      gaps.push({ kind: "scope-unavailable: engine is the repository under analysis", file: null });
    } else {
      const scopeDir = join(repoRoot, ".keeldocs", "cache", "scope");
      rmSync(scopeDir, { recursive: true, force: true });
      scope = { dir: scopeDir, allFiles,
                engineRel: engineRel.startsWith("..") ? [] : [engineRel] };
    }
  }
  // D1 (risk R10). Counters, not a report field: how a run was SERVED is run
  // state, not repository state. Two runs that disagree about hit counts must
  // still produce byte-identical facts, envelopes and reports - which is
  // exactly what the harness asserts - so this never enters the deterministic
  // stdout path. It surfaces on the human channel only.
  const useCache = cacheEnabled();
  const cacheStats = { hits: 0, misses: 0, uncacheable: 0, enabled: useCache, reasons: {}, reparsed: {} };
  // one hash pass for the whole run, shared by every provider's key
  const digests = useCache ? hashAll(repoRoot, allFiles) : null;
  // D2: how many bytes each provider was actually handed. One stat pass over
  // the same walk (~10ms at 1M LOC) - it must run whether or not the cache is
  // on, because the output cap is not a caching concern.
  const sizes = new Map();
  for (const rel of allFiles) {
    try { sizes.set(rel, statSync(join(repoRoot, rel)).size); } catch { sizes.set(rel, 0); }
  }
  const declaredBytes = (files) => files.reduce((n, rel) => n + (sizes.get(rel) ?? 0), 0);
  // D3. A CPU profile of a warm 1M-LOC run put 44% of it here: `jcs` at 20%,
  // `writeFileSync` at 17%, and a large share of the 18% spent in GC, because
  // this used to build ONE string of every fact in a capability - 77 MB for
  // module-graph's 190,400 symbols - and hand it to the filesystem in a single
  // call. Serialising in 1 MB chunks writes byte-identical output 73% faster
  // and never materialises the whole file in memory.
  const CHUNK = 1 << 20;
  const writeCapFile = (cap) => {
    const list = [...factsById.values()].filter((f) => capOf(f.id) === cap)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!list.length) return;
    const fd = openSync(capFile(cap), "w");
    try {
      let buf = [], n = 0;
      for (const f of list) {
        const line = jcs({ id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance });
        buf.push(line);
        n += line.length + 1;
        if (n >= CHUNK) { writeSync(fd, buf.join("\n") + "\n"); buf = []; n = 0; }
      }
      if (buf.length) writeSync(fd, buf.join("\n") + "\n");
    } finally { closeSync(fd); }
  };

  for (let i = 0; i < active.length; i++) {
    const reg = active[i];
    const flushGroup = () => { // last provider of this capability just finished
      if (active[i + 1]?.capability !== reg.capability) writeCapFile(reg.capability);
    };
    const d = detect(reg, repoRoot, allFiles);
    if (!d.applicable) {
      capabilities[reg.capability] ??= { status: "absent", providers: [] };
      flushGroup();
      continue;
    }
    // declared cross-capability reads, delivered by contract as env vars
    // pointing at the upstream capability's resolved fact file
    const factEnv = {};
    for (const cap of reg.factInputs ?? []) {
      if (existsSync(capFile(cap))) {
        factEnv[`KEELDOCS_FACTS_${cap.toUpperCase().replace(/-/g, "_")}`] = capFile(cap);
      }
    }
    if (reg.live) {
      // env-NAMED DSN (ADR-013): resolve the var here; the VALUE goes only into
      // the child env, never argv, never any report. Absence names the VAR only.
      const dsn = process.env[live.dsnEnv];
      const canned = process.env.KEELDOCS_TBLS_JSON; // deterministic test seam
      if (!dsn && !canned) {
        const cap = (capabilities[reg.capability] ??= { status: "absent", providers: [] });
        cap.providers.push(`${reg.id}@${reg.semver}`);
        cap.status = "failed";
        cap.reason = `live: env ${live.dsnEnv} is not set`;
        toolError = `${reg.id}: env ${live.dsnEnv} is not set ([live] dsn-env in keeldocs.toml names it)`;
        flushGroup();
        continue;
      }
      if (dsn) factEnv.KEELDOCS_DSN = dsn;
    }
    // ---- D1: the subprocess, or the answer it gave last time ----
    const resolved = resolveInputs(repoRoot, reg.inputs, allFiles);
    const { args, ignored, ignoredKind } = argsFor(reg, repoRoot, d, allFiles);
    // The engine chose the file, so the engine names the ones it did not choose.
    // Pushed here rather than left to the extractor because the extractor is
    // never told the others exist - it receives one path in argv. Recorded even
    // on a cache hit: what was skipped is a property of the tree, not of how
    // this run was served. The kind comes from the mode that did the choosing
    // (`schema-ignored` / `candidate-ignored`), because a gap whose noun is
    // wrong is a receipt a reader cannot act on.
    for (const rel of ignored) gaps.push({ kind: ignoredKind, file: rel });
    let run;
    if (args === null) {
      run = { status: "not_applicable" }; // argMode: schemaFile with no schema
    } else {
      const why = useCache ? uncacheableReason(reg, resolved) : "cache disabled";
      const key = why ? null : extractKey({
        reg, engine: ENGINE_VERSION, repoRoot, args,
        tier: `${reg.live ? "none" : SANDBOX}/${MINROOT.ok ? "minroot" : "host"}/${scope ? "scoped" : "wide"}`,
        detect: { via: d.via, file: d.file ? toPosix(relative(repoRoot, d.file)) : null },
        env: Object.keys(factEnv).sort(),
        files: hashInputs(repoRoot, resolved.files, digests),
        factFiles: (reg.factInputs ?? []).map((c) => [c, existsSync(capFile(c)) ? fileDigest(capFile(c)) : "absent"]),
      });
      const hit = key ? readEntry(repoRoot, reg.id, key) : null;
      if (hit !== null) {
        cacheStats.hits++;
        run = { status: "ok", raw: hit };
      } else {
        if (why) { cacheStats.uncacheable++; cacheStats.reasons[reg.id] = why; }
        else cacheStats.misses++;
        // D4: hand the provider its own previous per-file parses. This is a
        // PERFORMANCE input and nothing else - the provider's output must be
        // identical whether the handoff is complete, partial or absent, which
        // is what the harness gate asserts.
        let perFile = null;
        if (reg.incremental === "per-file" && useCache && digests) {
          const byRel = {};
          for (const rel of resolved.files) byRel[rel] = digests.get(rel) ?? fileDigest(join(repoRoot, rel));
          perFile = { byRel, parsed: loadPerFile(repoRoot, reg.id) };
          factEnv.KEELDOCS_INCREMENTAL = writeHandoff(repoRoot, reg.id, byRel, perFile.parsed);
        }
        // KEELDOCS_TIME=1 prints per-provider timings to STDERR. Twice now a
        // question about where a run's seconds went has been settled by this
        // and not by argument (D2's "is it the provider or the constant", D4's
        // "did the saving actually materialise"), so it stays. stderr, never
        // stdout: the deterministic channel is the repository's truth.
        const startedAt = process.hrtime.bigint();
        try {
          run = runProvider(reg, repoRoot, args, factEnv, scope, resolved, declaredBytes(resolved.files));
          if (process.env.KEELDOCS_TIME === "1") {
            const bytes = run.raw === undefined ? 0 : JSON.stringify(run.raw).length;
            process.stderr.write(`  [time] ${reg.id.padEnd(20)} ` +
              `${String(Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)).padStart(6)}ms  ` +
              `raw ${(bytes / 1048576).toFixed(1)}MB\n`);
          }
        } finally {
          if (perFile) clearHandoff(repoRoot, reg.id);
        }
        // `_parsed` is the provider's contribution to the cache, never a fact.
        // It is stripped before normalization sees the output, so a provider
        // that emits it cannot smuggle anything into the document.
        if (perFile && run.status === "ok" && run.raw && typeof run.raw === "object") {
          const fresh = run.raw._parsed;
          delete run.raw._parsed;
          if (fresh && typeof fresh === "object") {
            cacheStats.reparsed[reg.id] = Object.keys(fresh).length;
            const savedAt = process.hrtime.bigint();
            savePerFile(repoRoot, reg.id, perFile.byRel, perFile.parsed, fresh);
            if (process.env.KEELDOCS_TIME === "1") {
              process.stderr.write(`  [time] ${reg.id.padEnd(20)} ` +
                `${String(Math.round(Number(process.hrtime.bigint() - savedAt) / 1e6)).padStart(6)}ms  ` +
                `per-file cache write (${Object.keys(fresh).length} new)\n`);
            }
          }
        }
        // Only a clean run is worth remembering. A failure is a state of the
        // world right now, not a property of these inputs - caching it would
        // make a transient timeout permanent until something unrelated changed.
        // And only if the inputs held still while it ran: an answer computed
        // from bytes that arrived after the key was taken must not be filed
        // under that key (see inputsUnmoved).
        if (key && run.status === "ok" && inputsUnmoved(repoRoot, hashInputs(repoRoot, resolved.files, digests), resolved.files)) {
          writeEntry(repoRoot, reg.id, key, run.raw);
        }
      }
    }
    const cap = (capabilities[reg.capability] ??= { status: "absent", providers: [] });
    cap.providers.push(`${reg.id}@${reg.semver}`);
    if (run.status === "failed") {
      cap.status = "failed";
      cap.reason = run.reason;
      toolError = `${reg.id}: ${run.reason}`; // fail closed - never masquerade as "no drift"
      flushGroup();
      continue;
    }
    if (run.status !== "ok") { flushGroup(); continue; }
    const provenanceBase = { provider: `${reg.id}@${reg.semver}`,
      confidence: reg.confidence ?? (reg.tier === "declarative" ? "PATTERN" : "PARSED") };
    // Dispatch is a table keyed by capability, not a ternary chain. The chain's
    // last `else` was `schemaFacts`, so a capability nobody wrote a branch for
    // did not fail - it was silently normalized as a database schema and emitted
    // wrong-typed facts. A table has no last else: an unknown capability is a
    // TOOL error, which is the only honest answer for "the engine does not know
    // what these facts are".
    const attrsOf = (type) => [...factsById.values()]
      .filter((f) => f.payload.type === type).map((f) => f.payload.attrs);
    const NORMALIZE = {
      "http-endpoints": () => endpointFacts(run.raw, provenanceBase, repoRoot),
      "config-surface": () => envFacts(run.raw, provenanceBase),
      "workspace-layout": () => packageFacts(run.raw, provenanceBase),
      "services-topology": () => serviceFacts(run.raw, provenanceBase),
      "module-graph": () => moduleGraphFacts(run.raw, provenanceBase, attrsOf("package")),
      "decision-history": () => churnFacts(run.raw, provenanceBase),
      "db-policies": () => policyFacts(run.raw, provenanceBase),
      "client-routes": () => routeFacts(run.raw, provenanceBase),
      "async-messaging": () => messagingFacts(run.raw, provenanceBase),
      // db-schema is the one capability whose normalizer depends on the provider:
      // replay and live introspection carry a declared-beats-live join that a
      // static parse has no use for.
      "db-schema": () =>
        reg.id === "sql-replay"
          ? replayFacts(run.raw, provenanceBase,
              attrsOf("table").map((a) => a.name), attrsOf("enum").map((a) => a.name))
          : reg.id === "tbls-live"
          ? liveTableFacts(run.raw, provenanceBase, attrsOf("table").map((a) => a.name))
          : schemaFacts(run.raw, provenanceBase, toPosix(relative(repoRoot, d.file ?? ""))),
    };
    if (!NORMALIZE[reg.capability]) {
      cap.status = "failed";
      cap.reason = `no normalizer for capability '${reg.capability}'`;
      toolError = `${reg.id}: ${cap.reason}`;
      flushGroup();
      continue;
    }
    const norm = NORMALIZE[reg.capability]();

    // `emits:` was declaration only. `provider show` prints it in the permission
    // manifest a human reads before consenting to a third-party provider, and
    // nothing ever compared it to what the provider actually produced - so the
    // consent was to a list the engine did not hold anyone to. Fail closed, the
    // same way a crashed extractor does: a provider that emits outside its
    // declaration is not a partial result, it is a broken contract.
    if (reg.emits?.length) {
      const declared = new Set(reg.emits);
      const undeclared = [...new Set(norm.facts.map((f) => f.payload.type))]
        .filter((t) => !declared.has(t)).sort();
      if (undeclared.length) {
        cap.status = "failed";
        cap.reason = `emits undeclared fact type(s): ${undeclared.join(", ")} (declares ${reg.emits.join(", ")})`;
        toolError = `${reg.id}: ${cap.reason}`;
        flushGroup();
        continue;
      }
    }
    for (const f of norm.facts) {
      if (isHostileFact(f)) { // E10: marker-forging content never becomes a fact
        gaps.push({ kind: "hostile-content", file: null });
        continue;
      }
      // KEEL-30, the path scope. Applied to PROVENANCE, not to the repo walk:
      // filtering the walk would only bite where the sandbox builds a view, so
      // the same config would scope on Linux and silently do nothing on macOS
      // and Windows - a setting that means different things per platform is
      // worse than no setting. Provenance is outside the hash (ADR-008), so
      // pruning read sites cannot manufacture drift by itself.
      //
      // A fact keeps every site outside the scope and loses the ones inside it;
      // a fact with nothing left never existed as far as this repo is concerned.
      // That distinction is the whole point: an env var read by both a fixture
      // and the application is the application's, with one fewer receipt.
      //
      // This is a DOCUMENTATION scope, not a read restriction. What a provider
      // may read is `inputs` plus the sandbox, and that is unchanged.
      // KEEL-28's other half. A normalizer reads named fields out of whatever
      // the extractor printed, so an extractor that misspells one produces a
      // fact with an undefined attr - and JSON.stringify drops undefined keys,
      // so it lands in the fact file, the golden and the document as a fact that
      // is simply missing part of itself. `fact:db-schema/undefined` was
      // reachable from a `models` entry with no `name`. Silent absence is the
      // nastiest false-drift source the provider contract names, so this is a
      // named gap and a partial result - never a smaller-but-clean answer.
      const missing = Object.entries(f.payload?.attrs ?? {})
        .filter(([, v]) => v === undefined).map(([k]) => k);
      if (!f.id || String(f.id).includes("undefined") || missing.length) {
        gaps.push({ kind: `malformed-fact: ${reg.id} emitted a ${f.payload?.type ?? "?"} `
          + `missing ${missing.length ? missing.join(", ") : "an identifier"}`, file: null });
        continue;
      }
      if (scoped) {
        const src = f.provenance?.source ?? [];
        const kept = src.filter((s) => !s.file || !outOfScope(toPosix(s.file)));
        if (src.length && !kept.length) { scopedOut++; continue; }
        if (kept.length !== src.length) f.provenance = { ...f.provenance, source: kept };
      }
      f.hash = factHash(f.payload);
      const prior = claimsById.get(f.id);
      if (!prior) {
        claimsById.set(f.id, [f]);
        factsById.set(f.id, f);
      } else {
        // ADR-003: a second claim on the same id resolves by the pure total
        // order (lattice -> precedence -> provider id) - run order irrelevant
        prior.push(f);
        factsById.set(f.id, resolveClaims(f.id, prior, reg.capability, undefined, pins).winner);
      }
    }
    gaps.push(...norm.gaps);
    if (cap.status !== "failed") cap.status = "ok";
    flushGroup();
  }
  // Second teardown, deliberately redundant with the per-provider one: the
  // scope directory must not outlive the extraction that created it under any
  // exit path, because a leaked view inside the repository is indistinguishable
  // from repository content to anything that walks it.
  if (scope) rmSync(scope.dir, { recursive: true, force: true });

  // Disagreeing claims become conflict records: every claim, the winner, the
  // deciding rule (ADR-003 - "conflicts as facts", so silent averaging is
  // structurally impossible). Corroborating claims (same hash) report nothing.
  const conflicts = [];
  for (const [id, claims] of claimsById) {
    if (claims.length < 2) continue;
    const { conflict } = resolveClaims(id, claims, capOf(id), undefined, pins);
    if (conflict) conflicts.push(conflict);
  }
  conflicts.sort((a, b) => a.id.localeCompare(b.id));
  for (const c of conflicts) {
    const cap = capabilities[capOf(c.id)];
    if (cap) cap.conflicts = (cap.conflicts ?? 0) + 1; // noted on the card
  }

  // Cache identity covers the EFFECTIVE provider set - disabling a provider
  // via keeldocs.toml is a different extraction universe, so it must re-key.
  const providerSetHash = createHash("sha256")
    .update([...active.map((r) => `${r.id}@${r.semver}`)].sort().join(",") + `|engine:${ENGINE_VERSION.split(".")[0]}`)
    .digest("hex").slice(0, 16);

  return { factsById, capabilities, gaps, providerSetHash, toolError, conflicts, cache: cacheStats, scopedOut };
}
