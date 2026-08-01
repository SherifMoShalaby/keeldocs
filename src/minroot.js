// Minimal root (ADR-002's last sandbox residual). Per-glob scoping shrank what
// a provider can read INSIDE the repository; everything else on the host stayed
// visible, so a hostile provider could still read `~/.ssh/id_rsa`, a cloud
// credential file, an unrelated checkout, or the operator's shell history.
//
// This closes it by inverting the default. Inside the provider's mount
// namespace every top-level directory of `/` is replaced by an empty private
// tmpfs, EXCEPT the ones a language runtime cannot start without. The few paths
// that must survive under a masked tree - the engine's own tree, the
// interpreter's install prefix, python's site-packages - are staged before the
// masking and re-exposed read-only afterwards, at their original paths, so
// nothing has to be relocated or rewritten.
//
// Two honest limits, stated rather than implied. The keep-set is computed from
// the host at probe time, so it adapts to where node and python actually live -
// but a runtime that reads from a path nobody declared will fail loudly rather
// than silently degrade, which is the intended direction. And `/proc`, `/sys`
// and `/dev` remain the host's: they leak machine shape (cpu count, kernel
// version), not user data, and taking them away breaks interpreters for no
// confidentiality gain.

import { readdirSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

// Directories a POSIX runtime genuinely needs. Everything else at `/` is
// masked - an allowlist implemented by masking, so it adapts to whatever
// top-level entries a given host happens to have.
const SYSTEM_KEEP = new Set([
  "bin", "sbin", "lib", "lib32", "lib64", "libx32", "usr", "etc",
  "proc", "sys", "dev",
]);

// The staging mount point. It is masked first (so the host's copy is hidden),
// used to hold the pre-mask binds, and masked again at the end.
export const STAGE = "/mnt";

function topLevelDirs() {
  const out = [];
  for (const name of readdirSync("/").sort()) {
    if (SYSTEM_KEEP.has(name)) continue;
    if (name === STAGE.slice(1)) continue; // the staging dir is handled first
    try { if (statSync(`/${name}`).isDirectory()) out.push(`/${name}`); } catch { /* vanished */ }
  }
  return out;
}

const underMask = (p, masks) => masks.some((m) => p === m || p.startsWith(m + "/"));

// Where python will look for modules. A `pip install --user` puts tree_sitter
// under $HOME, which the mask would otherwise remove - so ASK the interpreter
// rather than assuming a layout.
function pythonSiteDirs() {
  const code = "import site,sys;print('\\n'.join([p for p in " +
    "(list(getattr(site,'getsitepackages',lambda: [])()) + " +
    "[getattr(site,'getusersitepackages',lambda: '')()] + [sys.prefix]) if p]))";
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["-c", code], { encoding: "utf8" });
    if (r.status === 0) {
      return [...new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))];
    }
  }
  return [];
}

// The plan is computed ONCE per process: which trees get masked, and which
// paths must survive under them. `extra` carries engine-side paths the caller
// knows about (ENGINE_ROOT, the running node binary's prefix).
export function minimalRootPlan(extra = []) {
  const masks = topLevelDirs();
  const wanted = [
    ...extra,
    // `dirname(dirname(execPath))` is the install PREFIX, not the bin dir:
    // an nvm or npm-global node needs its sibling lib/ as much as its bin/
    dirname(dirname(process.execPath)),
    ...pythonSiteDirs(),
  ];
  const keeps = [];
  for (const p of wanted) {
    if (typeof p !== "string" || !p.startsWith("/")) continue;
    if (!underMask(p, masks)) continue;      // already visible - nothing to do
    if (!existsSync(p)) continue;
    if (keeps.some((k) => p === k || p.startsWith(k + "/"))) continue; // covered
    keeps.push(p);
  }
  // drop keeps that a later, shorter keep subsumes; sort for determinism
  const minimal = keeps.filter((p, _i, all) =>
    !all.some((q) => q !== p && p.startsWith(q + "/")));
  // STAGE is NOT in this list: the wrapper masks it first (hiding the host's
  // copy), uses it to hold the pre-mask binds, and masks it again at the end.
  return { masks: masks.sort(), keeps: [...new Set(minimal)].sort() };
}
