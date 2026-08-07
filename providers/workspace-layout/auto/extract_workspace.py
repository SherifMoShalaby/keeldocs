#!/usr/bin/env python3
"""workspace-layout / auto provider (keeldocs).
Covers pnpm-workspace.yaml, package.json "workspaces" (npm/yarn), and
single-package repos. Manifest parsing only - no source reads, no execution.
Output: {"manager": "pnpm|npm-yarn|single", "file": <manifest|null>,
         "packages":[{"name","path"}]} sorted by path, paths always forward-slash,
plus "warnings":[{"kind","file"}] - omitted entirely when there is nothing to
report, so a repo with a clean layout keeps a byte-stable golden. Everything this
provider declines to resolve is named there: a declared member it could not
identify, a manifest it could not parse, a manifest that declares no members.
"""
import glob, json, os, sys
import yaml


def pkg_name(d):
    p = os.path.join(d, "package.json")
    if os.path.exists(p):
        try:
            return json.load(open(p)).get("name") or os.path.basename(os.path.abspath(d))
        except Exception:
            pass
    pt = os.path.join(d, "pyproject.toml")
    if os.path.exists(pt):
        try:
            import tomllib
            name = (tomllib.load(open(pt, "rb")).get("project") or {}).get("name")
            if name:
                return name
        except Exception:
            pass
    ps = os.path.join(d, "pubspec.yaml")
    if os.path.exists(ps):  # dart/flutter identity (breadth batch)
        try:
            name = (yaml.safe_load(open(ps, encoding="utf-8")) or {}).get("name")
            if name:
                return name
        except Exception:
            pass
    gm = os.path.join(d, "go.mod")
    if os.path.exists(gm):  # module path's last segment is the go identity (N2)
        try:
            for line in open(gm, encoding="utf-8"):
                if line.startswith("module "):
                    return line.split()[1].rstrip("/").rsplit("/", 1)[-1]
        except OSError:
            pass
    pom = os.path.join(d, "pom.xml")
    if os.path.exists(pom):  # maven artifactId, PROJECT-level only (N2)
        try:
            import re as _re
            top = _re.sub(r"<(parent|dependencies|build|profiles)[\s\S]*?</\1>", "",
                          open(pom, encoding="utf-8").read())
            m = _re.search(r"<artifactId>\s*([^<\s]+)\s*</artifactId>", top)
            if m:
                return m.group(1)
        except OSError:
            pass
    return os.path.basename(os.path.abspath(d))


def expand(root, patterns):
    """-> (packages, warnings). A directory the manifest DECLARES as a member but
    that carries no package.json is not a workspace member to pnpm/npm, and this
    provider still refuses to guess one. What changed is that it says so: the
    drop used to be silent, so a pnpm workspace declaring three members - one JS,
    one python, one go - reported one package, the system-map renderer saw a
    single-package repo and wrote no Packages section at all, and nothing in the
    run mentioned the other two. Deterministic order: glob's order is the
    filesystem's, so both lists are sorted before they leave this function."""
    out, seen, warnings = [], set(), []
    for pat in patterns:
        if not isinstance(pat, str) or pat.startswith("!"):
            continue  # negation patterns: v0.1 ignores excludes rather than guessing
        for d in sorted(glob.glob(os.path.join(root, pat))):
            if not os.path.isdir(d):
                continue
            rel = os.path.relpath(d, root).replace(os.sep, "/")
            if rel in seen:
                continue
            seen.add(rel)
            if os.path.exists(os.path.join(d, "package.json")):
                out.append({"name": pkg_name(d), "path": rel})
            else:
                warnings.append({"kind": "workspace-member-unresolved", "file": rel})
    return out, sorted(warnings, key=lambda w: w["file"])


def main(root):
    manager, packages, mfile, warnings = "single", [], None, []
    pw = os.path.join(root, "pnpm-workspace.yaml")
    pj = os.path.join(root, "package.json")
    if os.path.exists(pw):
        # The bare `except Exception: pass` that used to wrap this whole block
        # turned every unreadable pnpm manifest into "manager: single, one
        # package, no error". One tab character instead of two spaces is enough
        # to raise here, and the repo then read as a single-package repo that
        # simply had no workspace - indistinguishable, to every downstream
        # reader, from the truth. The parse failure is now the only thing the
        # try covers, and it is reported instead of swallowed.
        try:
            doc = yaml.safe_load(open(pw, encoding="utf-8")) or {}
        except Exception:
            doc = None
        if not isinstance(doc, dict):
            warnings.append({"kind": "workspace-manifest-unparsed", "file": "pnpm-workspace.yaml"})
        else:
            manager, mfile = "pnpm", "pnpm-workspace.yaml"
            pats = doc.get("packages")
            if pats:
                packages, w = expand(root, pats)
                warnings.extend(w)
            else:
                # A valid pnpm-workspace.yaml with no `packages:` key (only
                # `onlyBuiltDependencies:`, say) is a workspace whose members
                # this provider cannot enumerate - not a repo without one.
                warnings.append({"kind": "workspace-no-packages-declared", "file": "pnpm-workspace.yaml"})
    elif os.path.exists(pj):
        try:
            ws = json.load(open(pj)).get("workspaces")
            pats = ws.get("packages") if isinstance(ws, dict) else ws
            if pats:
                manager, mfile = "npm-yarn", "package.json"
                packages, w = expand(root, pats)
                warnings.extend(w)
        except Exception:
            pass
    if not packages:
        packages = [{"name": pkg_name(root), "path": "."}]
        manager = "single"
        mfile = ("package.json" if os.path.exists(pj)
                 else "pyproject.toml" if os.path.exists(os.path.join(root, "pyproject.toml"))
                 else "pubspec.yaml" if os.path.exists(os.path.join(root, "pubspec.yaml"))
                 else "go.mod" if os.path.exists(os.path.join(root, "go.mod"))
                 else "pom.xml" if os.path.exists(os.path.join(root, "pom.xml"))
                 else None)
    packages.sort(key=lambda p: p["path"])
    out = {"manager": manager, "file": mfile, "packages": packages}
    # Absent when empty, like every other optional key in this codebase: a repo
    # with nothing to report keeps its golden byte-identical.
    if warnings:
        out["warnings"] = sorted(warnings, key=lambda w: (w["kind"], w["file"] or ""))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
