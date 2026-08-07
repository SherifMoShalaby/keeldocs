// keeldocs.toml - the entire v0.1 config surface, loaded by every command.
// Schema-strict (ADR-013 discipline): unknown sections, unknown keys, wrong
// value shapes, and unknown provider ids are CONFIG errors (exit 2), never
// silently ignored - a typo'd key that quietly no-ops lies about what is
// configured. Zero-dep by design: this is a deliberate strict SUBSET of TOML
// (sections, string/bool/integer values, single-line string arrays, comments),
// which covers the whole schema below; anything outside the subset is an error.
//
//   [providers]
//   disable = ["compose", "git-log"]   # provider ids to skip this repo
//   exclude-paths = ["fixtures/**"]    # paths no provider may see (KEEL-30)
//
//   [docs]
//   dirs = ["docs", "handbook"]        # scan roots (default ["docs"]); README.md is always scanned

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toPosix } from "./paths.js";
import { parsePins } from "./resolve.js";
import { parseDoc } from "./anchors.js";
import { docSkip, repoFiles } from "./scope.js";
import { REGISTRY, REGISTRY_ERROR } from "./registry.js";

const SCHEMA = {
  // `exclude-paths` is the path scope. `disable` removes a whole PROVIDER, which
  // is the wrong shape for the common case: a repo with fixtures/, examples/,
  // vendor/ or testdata/ wants env-readers to run - just not over its test data.
  // Without this, the choice was to lose the provider everywhere or document the
  // fixtures as though they were the application.
  providers: { disable: "string[]", "exclude-paths": "string[]" },
  docs: { dirs: "string[]" },
  live: { "dsn-env": "string" }, // the NAME of the env var holding the DSN - never the DSN
  trust: { keys: "string[]" },   // T2: trusted signer keys, `name:spki-base64` (R2)
  resolve: { pin: "string[]" },  // ADR-003 pins, `capability:provider-id` (N1)
};

const DEFAULTS = () => ({ providers: { disable: [], "exclude-paths": [] }, docs: { dirs: ["docs"] },
  live: { "dsn-env": "DATABASE_URL" }, trust: { keys: [] }, resolve: { pin: [] } });

function parseValue(raw, where) {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^"([^"\\]*)"$/.test(s)) return s.slice(1, -1);
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`${where}: arrays must be single-line`);
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((p) => {
      const t = p.trim();
      const m = t.match(/^"([^"\\]*)"$/);
      if (!m) throw new Error(`${where}: array items must be double-quoted strings (got ${t.slice(0, 40)})`);
      return m[1];
    });
  }
  throw new Error(`${where}: unsupported value \`${s.slice(0, 40)}\` (strings, booleans, integers, ["a","b"] arrays only)`);
}

export function parseToml(text) {
  const out = {};
  let section = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const where = `keeldocs.toml:${i + 1}`;
    const line = lines[i].replace(/(^|\s)#.*$/, "").trim(); // comments (values here never contain '#')
    if (line === "") continue;
    const sec = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (sec) {
      section = sec[1];
      if (!(section in SCHEMA)) throw new Error(`${where}: unknown section [${section}] (known: ${Object.keys(SCHEMA).join(", ")})`);
      out[section] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`${where}: expected \`key = value\` or \`[section]\``);
    if (!section) throw new Error(`${where}: keys must live under a [section]`);
    const [, key, rawVal] = kv;
    const want = SCHEMA[section][key];
    if (!want) throw new Error(`${where}: unknown key \`${key}\` in [${section}] (known: ${Object.keys(SCHEMA[section]).join(", ")})`);
    const val = parseValue(rawVal, where);
    if (want === "string[]" && !(Array.isArray(val) && val.every((v) => typeof v === "string"))) {
      throw new Error(`${where}: \`${key}\` must be an array of strings`);
    }
    if (key in out[section]) throw new Error(`${where}: duplicate key \`${key}\``);
    out[section][key] = val;
  }
  return out;
}

// Returns { ok: true, config } or { ok: false, error } - commands emit the
// error as a CONFIG envelope with exit 2 and touch nothing.
export function loadConfig(root) {
  const cfg = DEFAULTS();
  const path = join(root, "keeldocs.toml");
  if (!existsSync(path)) return { ok: true, config: cfg };
  let parsed;
  try {
    parsed = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
  for (const [sec, keys] of Object.entries(parsed)) {
    for (const [k, v] of Object.entries(keys)) cfg[sec][k] = v;
  }
  if (!REGISTRY_ERROR) { // a broken registry is extractAll's loud failure, not config's
    const ids = new Set(REGISTRY.map((r) => r.id));
    for (const id of cfg.providers.disable) {
      if (!ids.has(id)) {
        return { ok: false, error: `keeldocs.toml: [providers] disable names unknown provider \`${id}\` (known: ${[...ids].sort().join(", ")})` };
      }
    }
  }
  try { parsePins(cfg.resolve.pin); } catch (err) {
    return { ok: false, error: `keeldocs.toml: ${String(err.message)}` };
  }
  if (cfg.docs.dirs.some((d) => d.startsWith("/") || d.includes(".."))) {
    return { ok: false, error: "keeldocs.toml: [docs] dirs must be repo-relative paths without `..`" };
  }
  // A scan root the user WROTE DOWN and that does not exist is a CONFIG error
  // for exactly the reason an unknown provider id is: it names something that
  // cannot be read, and the run that follows is quieter than what was asked for
  // rather than louder. Measured: `dirs = ["docz"]` exited 0 CLEAN, and because
  // README.md is always scanned the summary read `across 1 doc(s)` - a number on
  // screen that looks like an answer while the entire handbook goes unread.
  // Only what the FILE names is checked, never the `["docs"]` default: a
  // greenfield repo with no docs/ and no config still has to run, which is the
  // first thing anyone does with this tool.
  for (const d of parsed.docs?.dirs ?? []) {
    let isDir = false;
    try { isDir = statSync(join(root, d)).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      return { ok: false, error: `keeldocs.toml: [docs] dirs names \`${d}\`, which is not a directory in this repo (create it, or remove the entry - nothing under a missing scan root is ever checked)` };
    }
  }
  // Same rule as [docs] dirs, and for a sharper reason: an absolute or escaping
  // pattern in a path SCOPE would silently widen or misdirect what the engine is
  // allowed to look at, and a scope that does not mean what it says is worse than
  // no scope.
  const badScope = cfg.providers["exclude-paths"].filter((g) => g.startsWith("/") || g.includes(".."));
  if (badScope.length) {
    return { ok: false, error: `keeldocs.toml: [providers] exclude-paths must be repo-relative globs without \`..\` (got ${badScope.join(", ")})` };
  }
  return { ok: true, config: cfg };
}

// Every command's extraction options, in ONE place. They were spelled out at
// six call sites, and the copies had already diverged: `check --since` built its
// base extraction without `resolvePins`, so with a pin configured the base and
// the head resolved conflicts by different rules and the diff manufactured
// changed facts. A fourth option (`exclude-paths`) spread across six sites by
// hand would have gone the same way.
export const extractOpts = (config) => ({
  disable: config.providers.disable,
  excludePaths: config.providers["exclude-paths"],
  trustKeys: config.trust.keys,
  resolvePins: config.resolve.pin,
});

// Shared doc discovery for every command: configured scan roots + README.md,
// repo-relative, deduped, sorted (was triplicated across check/init/sync).
//
// What it does NOT read is `docSkip`'s three names and nothing else. It used to
// carry a hand-copied subset of the PROVIDER skip set - `.keeldocs`,
// `node_modules`, `golden`, `.git` - applied while recursing inside a directory
// the user had named in `[docs] dirs`, and that subset had drifted from the set
// it was copied from: `dist/` and `coverage/` under a scan root were read all
// along, `golden/` was not, and nothing anywhere said so. An anchored, drifting
// document at `docs/golden/reference.md` measured exit 0 CLEAN with the same
// bytes at `docs/reference.md` exiting 1 DRIFT_FOUND, and at
// `dirs = ["docs/golden"]` exiting 1 too - which is the proof it was an
// artefact of the skip rather than anyone's intent.
//
// `skipped`, when given an array, collects the repo-relative path of every
// directory that was skipped LOUDLY, for the caller to report. A silent skip
// inside a root the user wrote down is the shape of defect this whole family is.
export function docPathsOf(root, dirs, skipped = null) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = toPosix(relative(root, p)); // emitted paths are posix on every OS
      const why = docSkip(name, rel);
      if (why) { if (why === "named") skipped?.push(rel); continue; }
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith(".md")) out.push(rel);
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) rec(join(root, d));
  if (existsSync(join(root, "README.md"))) out.push("README.md");
  return [...new Set(out)].sort();
}

// The scan roots are the widest blind spot the engine has, and they were a
// SILENT one: nothing outside them is read, and nothing said so. `git mv docs
// handbook` retires every anchored document in a repository from drift
// detection in one command - measured on this project: five committed markers
// still tracked, `check` still CLEAN, still exit 0. The documents went on being
// wrong and the tool that exists to say so said nothing, which is the precise
// failure "your documentation is not lying to you" is a claim against.
//
// So sweep what the scan roots do not cover and report any document that is
// ANCHORED and unread. Three properties, each load-bearing:
//
//   * It fires on real structure only - `parseDoc` anchors and regions - and
//     never on a quarantined marker. This repository's own CLAUDE.md, AGENTS.md
//     and skills/keeldocs-core/SKILL.md each mention `<!-- keeldocs:gen -->`
//     inside an inline code span, which quarantines as `no-keys`; a
//     quarantine-inclusive sweep would turn keeldocs' own dogfood gate red for
//     three sentences of prose telling people not to hand-edit.
//   * `parseDoc` masks fenced blocks, so a vendored README that DOCUMENTS an
//     anchor in a code fence stays silent. That is the difference between a
//     scan-root warning and a nuisance nobody leaves switched on.
//   * `repoFiles` carries the user's `exclude-paths` scope and the
//     nested-checkout refusal, so somebody else's committed docs stay somebody
//     else's problem - and a repo whose examples really are examples has a
//     written way to say so. What it did NOT do was say which documents that
//     cost, and the scope is written for a different purpose entirely: it exists
//     to keep `fixtures/` out of the FACTS. `exclude-paths = ["**/*.md"]`
//     excludes no code at all and disarmed this sweep repo-wide - measured, the
//     same `git mv docs handbook` this function was written for went back to
//     exit 0 CLEAN with an empty `meta`. So an exclusion still wins, and every
//     anchored document it suppressed is now NAMED in `excluded`. That is the
//     `skipped` precedent rather than the `unscanned` one: the user asked for
//     this blind spot, so it moves no exit code, but a blind spot the report
//     does not name is indistinguishable from an empty one.
//   * What it does NOT carry any more is the PROVIDER skip set. It inherited all
//     six names, so `golden/`, `dist/` and `coverage/` - the user's own test data
//     and build output - were unswept as silently as `node_modules`, and an
//     anchored document in any of them measured exit 0 CLEAN. The sweep asks
//     `docSkip` instead: three names, one of which (`node_modules`) is reported
//     by path rather than passed over in silence.
//
// No git, deliberately: `check` is a pure function of the TREE, and gating this
// on `git ls-files` would make the same bytes answer differently depending on
// the index - and go vacuously silent in every non-git fixture.
// `excluded`, when given an array, collects the same record for every anchored
// document the user's own scope suppressed. Asking for it is what makes the walk
// descend into an excluded directory at all, so a caller that does not want the
// disclosure pays nothing for it. A document inside a `[docs] dirs` scan root is
// read whatever the scope says - the scan roots have always won - so it is
// neither swept nor disclosed here; it is simply checked.
export function unscannedAnchoredDocs(root, docPaths, excludePaths = [], skipped = null, excluded = null) {
  const scanned = new Set(docPaths);
  const out = [];
  const byScope = excluded ? [] : null;
  const anchored = (rel) => {
    let parsed;
    try { parsed = parseDoc(readFileSync(join(root, rel), "utf8"), rel); }
    catch { return null; } // unreadable file: not this function's finding
    if (parsed.anchors.length + parsed.regions.length === 0) return null;
    return { doc: rel, anchors: parsed.anchors.length, regions: parsed.regions.length };
  };
  const byDoc = (a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0);
  for (const rel of repoFiles(root, excludePaths, null, { skipDir: docSkip, skipped, denied: byScope })) {
    if (!rel.endsWith(".md") || scanned.has(rel)) continue;
    const rec = anchored(rel);
    if (rec) out.push(rec);
  }
  for (const rel of byScope ?? []) {
    if (!rel.endsWith(".md") || scanned.has(rel)) continue;
    const rec = anchored(rel);
    if (rec) excluded.push(rec);
  }
  excluded?.sort(byDoc);
  return out.sort(byDoc);
}
