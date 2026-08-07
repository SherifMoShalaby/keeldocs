// Per-glob read scoping (ADR-002's last sandbox debt). The `rofs` tier made the
// repository read-only; it stayed WHOLLY readable, so a hostile provider could
// still read any file it was never granted - the ADR's "scoped to declared
// globs minus the security exclusion set" was explicitly NOT claimed.
//
// This closes it. Before a provider runs, the engine builds a VIEW: a directory
// containing hardlinks to exactly the files its manifest declared, and nothing
// else. The view is bind-mounted over the repository path inside the provider's
// mount namespace, so the repo root the provider sees IS its declared input set.
// Undeclared files are not hidden, not permission-denied - they do not exist.
//
// Two consequences worth stating plainly, because both are the point:
//
//   * `inputs` stops being documentation and becomes an enforced contract. A
//     provider that reads what it did not declare now fails, loudly, in CI.
//   * Declaring `**/*` still does not buy secrets. The exclusion set below is
//     subtracted from every match, so `.env`, private keys and credential
//     stores are unreachable from inside a provider by construction.

import { readdirSync, statSync, mkdirSync, linkSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { toPosix } from "./paths.js";

// Same skip set the engine's own walk uses, so a scoped provider sees exactly
// the tree an unscoped one saw. A manifest that names a skipped directory
// explicitly (a `dir/` glob) still reaches it - the skip is a default, not a ban.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".keeldocs", "golden", "coverage"]);

// ---------- the same question, asked about DOCUMENTS ----------
//
// The set above is an extraction convenience: six directory names nobody wants
// a provider to waste a walk on, and harmless there because a manifest that
// names one still reaches it. It was also, silently, the boundary of a
// user-facing guarantee. `docPathsOf` carried a hand-copied subset of it while
// recursing INSIDE a directory the user had written into `[docs] dirs`, and the
// unscanned sweep inherited the whole of it, so an anchored, drifting document
// at `docs/golden/reference.md` was read by neither: measured at exit 0 CLEAN,
// `across 1 doc(s)`, with the same bytes at `docs/reference.md` exiting 1
// DRIFT_FOUND. `golden/`, `dist/` and `coverage/` are the user's own tree - a
// repository's test data and its build output are things a repository may
// document into - and skipping them was keeldocs' convention imposed as if it
// were a rule.
//
// So documentation asks a narrower question, and answers out loud. Three names
// are not read, each for a reason that is about the directory rather than about
// convenience, and only one of them is the user's:
//
//   * `node_modules` - somebody else's tree, at any depth. Sweeping it would
//     make every repository that installs keeldocs as a dependency answer for
//     documents it did not write, the day the published tarball carries an
//     anchored one. Skipped, and NAMED at runtime, because a dependency tree is
//     still part of the repository on disk.
//   * `.git` - the VCS's own storage, at any depth. Not repository content in
//     any form: an export of the identical tree has none, and `check` is a pure
//     function of the tree.
//   * `.keeldocs`, at the repo root only - keeldocs' own directory, which this
//     command CREATES. Reporting it would make the report depend on whether the
//     tool had run in this tree before, which is exactly the run-state leak the
//     cold/warm byte-identical contract exists to forbid. A `.keeldocs`
//     anywhere else is somebody's ordinary directory and is read.
//
// The default for anything added here later is "named": silence has to be
// argued for one directory at a time, which is the property that was missing.
export function docSkip(name, rel) {
  if (name === "node_modules") return "named";
  if (name === ".git") return "silent";
  if (rel === ".keeldocs") return "silent";
  return null;
}

// ---------- the security exclusion set ----------
//
// Subtracted from every provider's matches, however broadly it declared. These
// are the files whose CONTENTS are the secret; a provider legitimately needing
// to know a variable EXISTS reads the example file, which is why the safe-env
// forms are rescued rather than absent from the pattern.
const SECRET_NAME = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.dockercfg|id_rsa[^/]*|id_dsa[^/]*|id_ecdsa[^/]*|id_ed25519[^/]*)$/;
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i;
const SECRET_DIR = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.gcloud|\.kube|\.docker)\//;
const SAFE_ENV = /(^|\/)\.env\.(example|sample|schema|template|defaults|dist)$/;

export function isExcluded(rel) {
  if (SAFE_ENV.test(rel)) return false;
  return SECRET_NAME.test(rel) || SECRET_EXT.test(rel) || SECRET_DIR.test(rel);
}

// ---------- glob matching (the manifest subset, zero-dep) ----------
//
// Exactly the syntax provider.yaml uses: `**` across directories, `*`/`?`
// within a segment, `{a,b}` alternation, and a trailing `/` meaning "this
// directory, recursively" (which becomes a bind mount, not a hardlink farm).
const META = /[.+^$()|[\]\\]/g;
const lit = (s) => s.replace(META, "\\$&");

export function globToRegExp(glob) {
  const g = glob.endsWith("/") ? glob + "**" : glob;
  let re = "", i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 3; continue; } // zero or more dirs
        re += ".*"; i += 2; continue;
      }
      re += "[^/]*"; i++; continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") {
      const end = g.indexOf("}", i);
      if (end !== -1) {
        re += "(?:" + g.slice(i + 1, end).split(",").map((a) => lit(a.trim())).join("|") + ")";
        i = end + 1; continue;
      }
    }
    re += lit(c); i++;
  }
  return new RegExp("^" + re + "$");
}

// ---------- the user's path scope, asked as ONE question ----------
//
// `[providers] exclude-paths` names a PATH, and a path names its subtree. That
// sentence had two implementations and they disagreed. The walk below tests the
// patterns against every entry it meets INCLUDING directories, so `vendor`
// pruned the whole subtree; the provenance filter in src/facts.js tests the same
// patterns against FILE paths, where `^vendor$` matches nothing at all. So a
// bare directory name reached three of the four consumers - it removed the
// directory from provider detection, from `inputs` resolution and from the
// anchored-doc sweep - while the facts read out of it were still counted, and
// `meta.scopedOut` stayed 0, which is the field that would have said so.
// Measured on `fixtures/exclude-shape-scenario`: `["vendor"]` reported
// `0/2 surfaces documented` with `VENDOR_SECRET_KEY` still in the denominator
// and `services-topology` gone, where `["vendor/**"]` reported `0/1` and named
// the scope. One spelling, two meanings, and the more destructive one was the
// silent one.
//
// One matcher now answers for every consumer: a path is out of scope when the
// path itself matches, or when ANY of its ancestor directories does. That is
// the walk's semantics - the one a user writing `vendor` is asking for - applied
// everywhere instead of in the one place a directory name is visible.
//
// What it deliberately does NOT do is widen a pattern that was already about
// files. `fixtures/**` still leaves the `fixtures` directory itself unmatched
// and prunes its contents one by one, exactly as before; `demo.js` still means
// the file at the repository root and never a basename anywhere in the tree.
export function pathScope(patterns) {
  const res = (patterns ?? []).map(globToRegExp);
  if (!res.length) return () => false;
  return (rel) => {
    if (res.some((re) => re.test(rel))) return true;
    for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) {
      const ancestor = rel.slice(0, i);
      if (res.some((re) => re.test(ancestor))) return true;
    }
    return false;
  };
}

// The literal directory prefix before the first wildcard - what a walk can be
// anchored to, and what makes `dir/` cheap.
function baseOf(glob) {
  const w = glob.search(/[*?{]/);
  const head = w === -1 ? glob : glob.slice(0, w);
  const cut = head.lastIndexOf("/");
  return cut === -1 ? "" : head.slice(0, cut);
}

// Every file under root, minus the default skips. Walked ONCE per extraction
// and reused for every provider - the per-provider cost is a regex filter.
// `exclude` is the user's path scope (`[providers] exclude-paths`). Applied here,
// in the ONE walk, so a scoped path is invisible to provider detection and to
// `inputs` resolution - which is what keeps it out of the sandbox view, so that
// on a host with a mount namespace an excluded file is not merely absent from
// the output but absent from the provider's filesystem.
//
// This is not sufficient on its own and is not meant to be: where no view can be
// built (macOS, Windows, any host without user namespaces) a provider walks the
// real tree itself and would still find the file. The fact set is made uniform
// across platforms in src/facts.js, which drops the provenance either way. Both
// halves, for one reason each: this one restricts the read where the kernel can,
// that one makes the ANSWER the same everywhere.
// `nested`, when given an array, collects the repo-relative prefixes of every
// nested checkout the walk refused to enter. The caller needs them because
// skipping the walk is only half a fix: where no sandbox view is built - macOS,
// Windows, any host without user namespaces - a provider walks the real tree
// itself and finds the nested repository anyway. The same shape as the path
// scope, and for the same reason.
// `skipDir` decides what the walk will not enter, and `skipped` collects the
// repo-relative path of every directory it declined to enter LOUDLY (see
// `docSkip`). The default is the provider skip set and reports nothing, so
// extraction is byte-for-byte the walk it always was; the doc sweep passes its
// own, narrower question. The user's `exclude` is now tested FIRST, so a path
// the user scoped out is attributed to the line they wrote rather than counted
// as an engine skip - it changes which list a directory lands in, never which
// files come back.
// `denied`, when given an array, turns the exclusion from a prune into a
// CLASSIFICATION: excluded files land in it instead of in the result, and the
// walk descends into an excluded directory to find them. Only the doc sweep asks
// for this, because it is the one consumer that has something to say about what
// the scope removed - an anchored document nobody is checking. With the
// collector absent (extraction, `inputs` resolution, every existing caller) the
// walk short-circuits exactly where it always did and returns the same list.
// Inside an excluded subtree `skipDir` still applies but never NAMES: a
// dependency tree under a directory the user scoped out is attributed to the
// line the user wrote, not reported as an engine skip.
export function repoFiles(root, exclude = [], nested = null,
                          { skipDir = (name) => (SKIP_DIRS.has(name) ? "silent" : null),
                            skipped = null, denied = null } = {}) {
  const outOfScope = pathScope(exclude);
  const out = [];
  const walk = (dir, rel, inDenied) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const excluded = inDenied || outOfScope(r);
      if (excluded && !denied) continue;
      const why = skipDir(name, r);
      if (why) { if (why === "named" && !excluded) skipped?.push(r); continue; }
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; } // broken symlink
      // A directory holding a `.git` entry is a nested repository or a git
      // worktree, not part of this tree, and git itself does not track through
      // one. Walking in double-counts somebody else's code as this project's:
      // an agent worktree under .claude/ put this repository's whole fixture
      // tree back into its own dogfood and took it from 12 documented surfaces
      // to 32. `.git` is a FILE in a linked worktree and a directory in a clone,
      // so both forms are checked.
      if (st.isDirectory() && existsSync(join(abs, ".git"))) { if (!excluded) nested?.push(r); continue; }
      if (st.isDirectory()) walk(abs, r, excluded);
      else if (st.isFile()) (excluded ? denied : out).push(r);
    }
  };
  walk(root, "", false);
  return out;
}

// Resolve one manifest's `inputs` into what the view must contain. `${facts:…}`
// tokens are not repo paths - the engine delivers those separately - so they
// are skipped here rather than silently matching nothing.
export function resolveInputs(root, inputs, allFiles) {
  const files = new Set(), dirs = new Set();
  for (const raw of inputs ?? []) {
    if (typeof raw !== "string" || raw.startsWith("${facts:")) continue;
    const glob = raw.replace(/^\.\//, "");
    if (glob.endsWith("/")) {
      const d = glob.slice(0, -1);
      // A directory grant becomes a bind MOUNT, so the source has to really be
      // a directory. In a linked worktree `.git` is a FILE holding `gitdir: …`,
      // and binding a file onto a directory fails at the kernel - so that case
      // falls through to the file matcher and is hardlinked instead, which is
      // both correct and what lets base-revision extraction work at all.
      let isDir = false;
      try { isDir = !!d && !d.includes("*") && statSync(join(root, d)).isDirectory(); }
      catch { isDir = false; }
      if (isDir) { dirs.add(d); continue; }
    }
    const re = globToRegExp(glob);
    const base = baseOf(glob);
    // A glob anchored below a default-skipped directory is walked on demand;
    // otherwise the cached whole-repo list answers it.
    const pool = base && base.split("/").some((s) => SKIP_DIRS.has(s))
      ? repoFiles(join(root, base)).map((r) => `${base}/${r}`)
      : allFiles;
    for (const rel of pool) {
      if (base && !(rel === base || rel.startsWith(base + "/"))) continue;
      if (re.test(rel) && !isExcluded(rel)) files.add(rel);
    }
    // a bare-file grant whose source is a plain file at the root of the glob
    // (the worktree `.git` case) is not reachable through the cached walk,
    // because the walk skips that name by default
    if (glob.endsWith("/")) {
      const d = glob.slice(0, -1);
      try { if (statSync(join(root, d)).isFile()) files.add(d); } catch { /* absent */ }
    }
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

// Materialise the view. Hardlinks, never copies, whenever the filesystem allows
// it: the view is a second name for the same inode, so it costs directory
// entries rather than bytes, and the read-only bind mount is what makes it
// unwritable. Directory grants become empty mount POINTS - they have to exist
// before the view is remounted read-only, since nothing can be created after.
export function buildView(root, viewDir, { files, dirs, links = [] }) {
  mkdirSync(viewDir, { recursive: true });
  // One mkdir per DIRECTORY, not per file. `files` is sorted, so a package of
  // 30 modules used to issue 30 recursive mkdir calls for the same parent.
  // Worth 16% of view construction (D7) and nothing else: the view's contents,
  // and therefore what the provider can read, are byte-for-byte what they were.
  const made = new Set([viewDir]);
  for (const rel of files) {
    const dst = join(viewDir, rel);
    const parent = dirname(dst);
    if (!made.has(parent)) { mkdirSync(parent, { recursive: true }); made.add(parent); }
    try { linkSync(join(root, rel), dst); }
    catch (err) {
      if (err.code === "EEXIST") continue;
      try { copyFileSync(join(root, rel), dst); } catch { /* vanished mid-run */ }
    }
  }
  // Pairs of (real source, mount point INSIDE the view). Both are bound while
  // paths still resolve against the real tree; once the view is rbind-ed onto
  // the repo path these ride along, and `root/<rel>` is the real directory.
  const mounts = [];
  for (const rel of [...dirs, ...links]) {
    const point = join(viewDir, rel);
    mkdirSync(point, { recursive: true });
    mounts.push([toPosix(join(root, rel)), toPosix(point)]);
  }
  return { mounts };
}
