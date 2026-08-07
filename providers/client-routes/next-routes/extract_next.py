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


def main(root, detected=None):
    # argv[2], when the engine supplies it, is the `next.config.*` DETECTION
    # proved. The App Router root lives beside that file, not at the repository
    # root: an app at `apps/web/` was detected, ran, and returned
    # `{"routes": [], "warnings": []}` - a literal empty warnings list, so
    # client-routes reported `status: ok` over nothing at all. The candidate
    # ORDER inside a Next project is deliberately unchanged; only where it is
    # anchored moved.
    anchor = root
    if detected:
        p = detected if os.path.isabs(detected) else os.path.join(root, detected)
        anchor = os.path.dirname(p) or root
    base = None
    for cand in ("app", os.path.join("src", "app")):
        if os.path.isdir(os.path.join(anchor, cand)):
            base = os.path.join(anchor, cand)
            break
    routes, warns = [], []
    if base is None:
        # A Next project with neither `app/` nor `src/app/` is a Pages Router
        # project, or a router root this provider does not resolve. Either way
        # the honest answer is a named gap - "no routes" and "I did not look in
        # the right place" are the same bytes without one.
        warns.append({"kind": "app-router-root-not-found",
                      "file": os.path.relpath(anchor, root).replace(os.sep, "/")})
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
    warns.sort(key=lambda w: (w["kind"], w["file"]))
    print(json.dumps({"routes": uniq, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
