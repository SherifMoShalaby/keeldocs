#!/usr/bin/env python3
"""Next.js App Router route extractor (E9 field gap; doc 11 follow-up).

The route tree IS the filesystem: app/**/page.* are screens, app/**/route.*
are HTTP handler URLs - both are the app's route surface. Composition rules:
(group) segments vanish from the URL, @parallel slots are skipped entirely,
dynamic [param]/[...rest]/[[...opt]] segments stay verbatim (the convention
developers recognize). Pure sorted fs walk - no parsing, no clock.
"""
import json, os, sys

PAGE = {"page.tsx", "page.jsx", "page.ts", "page.js", "page.mdx"}
HANDLER = {"route.ts", "route.js", "route.tsx"}
SKIP = {"node_modules", ".git", ".keeldocs", "golden", ".next", "dist"}


def main(root):
    base = None
    for cand in ("app", os.path.join("src", "app")):
        if os.path.isdir(os.path.join(root, cand)):
            base = os.path.join(root, cand)
            break
    routes = []
    if base is not None:
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("@"))
            hits = sorted(set(filenames) & (PAGE | HANDLER))
            if not hits:
                continue
            rel = os.path.relpath(dirpath, base).replace(os.sep, "/")
            segs = [] if rel == "." else [s for s in rel.split("/")
                                          if not (s.startswith("(") and s.endswith(")"))]
            path = "/" + "/".join(segs) if segs else "/"
            for fn in hits:
                routes.append({"file": os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"),
                               "path": path})
    seen, uniq = set(), []
    for r in sorted(routes, key=lambda r: (r["path"], r["file"])):
        if r["path"] in seen:
            continue
        seen.add(r["path"])
        uniq.append(r)
    print(json.dumps({"routes": uniq, "warnings": []}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
