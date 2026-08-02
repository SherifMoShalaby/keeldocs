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

import { readdirSync, statSync, mkdirSync, linkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toPosix } from "./paths.js";

// Same skip set the engine's own walk uses, so a scoped provider sees exactly
// the tree an unscoped one saw. A manifest that names a skipped directory
// explicitly (a `dir/` glob) still reaches it - the skip is a default, not a ban.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".keeldocs", "golden", "coverage"]);

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
export function repoFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; } // broken symlink
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk(root, "");
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
