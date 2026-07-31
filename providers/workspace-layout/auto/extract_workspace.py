#!/usr/bin/env python3
"""workspace-layout / auto provider (keeldocs).
Covers pnpm-workspace.yaml, package.json "workspaces" (npm/yarn), and
single-package repos. Manifest parsing only - no source reads, no execution.
Output: {"manager": "pnpm|npm-yarn|single", "file": <manifest|null>,
         "packages":[{"name","path"}]} sorted by path, paths always forward-slash.
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
    return os.path.basename(os.path.abspath(d))


def expand(root, patterns):
    out, seen = [], set()
    for pat in patterns:
        if not isinstance(pat, str) or pat.startswith("!"):
            continue  # negation patterns: v0.1 ignores excludes rather than guessing
        for d in glob.glob(os.path.join(root, pat)):
            if os.path.isdir(d) and os.path.exists(os.path.join(d, "package.json")):
                rel = os.path.relpath(d, root).replace(os.sep, "/")
                if rel not in seen:
                    seen.add(rel)
                    out.append({"name": pkg_name(d), "path": rel})
    return out


def main(root):
    manager, packages, mfile = "single", [], None
    pw = os.path.join(root, "pnpm-workspace.yaml")
    pj = os.path.join(root, "package.json")
    if os.path.exists(pw):
        try:
            doc = yaml.safe_load(open(pw)) or {}
            manager, mfile = "pnpm", "pnpm-workspace.yaml"
            packages = expand(root, doc.get("packages") or [])
        except Exception:
            pass
    elif os.path.exists(pj):
        try:
            ws = json.load(open(pj)).get("workspaces")
            pats = ws.get("packages") if isinstance(ws, dict) else ws
            if pats:
                manager, mfile = "npm-yarn", "package.json"
                packages = expand(root, pats)
        except Exception:
            pass
    if not packages:
        packages = [{"name": pkg_name(root), "path": "."}]
        manager = "single"
        mfile = ("package.json" if os.path.exists(pj)
                 else "pyproject.toml" if os.path.exists(os.path.join(root, "pyproject.toml"))
                 else None)
    packages.sort(key=lambda p: p["path"])
    print(json.dumps({"manager": manager, "file": mfile, "packages": packages}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
