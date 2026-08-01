#!/usr/bin/env python3
"""Shared nested-route-object scanner (angular + vue).

Both frameworks declare routes as arrays of objects with `path` and nested
`children`, so one walker serves both: find every routes ARRAY (by the
framework's own anchors), compose paths through `children`, keep dynamic
segments verbatim (`:id`), and emit gaps - never guesses - for computed
paths. Angular's "" empty path means "this level", matching vue's "".
Deterministic: sorted files, deduped, sorted emission.
"""
import json, os, sys

from tree_sitter import Language, Parser
import tree_sitter_typescript as tst

SKIP = {"node_modules", "dist", "build", ".git", ".keeldocs", "golden", "coverage", ".angular"}
TS = Language(tst.language_typescript())
TSX = Language(tst.language_tsx())


def sstr(n):
    if n is None:
        return None
    if n.type == "string":
        return "".join(c.text.decode() for c in n.children if c.type == "string_fragment")
    if n.type == "template_string" and not any(c.type == "template_substitution" for c in n.children):
        return "".join(c.text.decode() for c in n.children if c.type != "`")
    return None


def prop(obj, name):
    for p in obj.named_children:
        if p.type == "pair":
            k = p.child_by_field_name("key")
            if k is not None and k.text.decode().strip("\"'") == name:
                return p.child_by_field_name("value")
    return None


def compose(prefix, seg):
    if seg is None or seg == "":
        return prefix or "/"
    if seg.startswith("/"):
        base = seg
    else:
        base = (prefix or "").rstrip("/") + "/" + seg
    return "/" + "/".join(p for p in base.split("/") if p)


def scan(root, anchors, marker_bytes):
    """anchors: property names whose ARRAY value is a route list, plus bare
    `routes`-shaped identifiers; marker_bytes: cheap file prefilter"""
    routes, warns = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            if not fn.endswith((".ts", ".js", ".mjs")) or fn.endswith((".d.ts", ".spec.ts", ".test.ts")):
                continue
            path = os.path.join(dirpath, fn)
            src = open(path, "rb").read()
            if not any(m in src for m in marker_bytes):
                continue
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            tree = Parser(TSX if fn.endswith(".tsx") else TS).parse(src)

            def walk_array(arr, prefix):
                for el in arr.named_children:
                    if el.type != "object":
                        continue
                    pv = prop(el, "path")
                    here = prefix
                    if pv is not None:
                        seg = sstr(pv)
                        if seg is None:
                            warns.append({"file": rel, "reason": "non-literal route path"})
                            continue
                        here = compose(prefix, seg)
                        routes.append({"file": rel, "path": here})
                    for lazy in ("loadChildren", "loadComponent"):
                        if prop(el, lazy) is not None and prop(el, "children") is None:
                            warns.append({"file": rel, "reason": f"lazy {lazy} - child routes live in another file"})
                            break
                    ch = prop(el, "children")
                    if ch is not None and ch.type == "array":
                        walk_array(ch, here)

            def find(n):
                if n.type == "array":
                    parent = n.parent
                    named = False
                    if parent is not None and parent.type == "pair":
                        k = parent.child_by_field_name("key")
                        named = k is not None and k.text.decode().strip("\"'") in anchors
                    if parent is not None and parent.type == "variable_declarator":
                        nm = parent.child_by_field_name("name")
                        named = nm is not None and any(a.lower() in nm.text.decode().lower() for a in anchors)
                    if named:
                        walk_array(n, "")
                        return
                for c in n.children:
                    find(c)

            find(tree.root_node)
    seen, uniq = set(), []
    for r in sorted(routes, key=lambda r: (r["path"], r["file"])):
        if r["path"] in seen:
            continue
        seen.add(r["path"])
        uniq.append(r)
    dedup, wout = set(), []
    for w in sorted(warns, key=lambda w: (w["file"], w["reason"])):
        k = (w["file"], w["reason"])
        if k not in dedup:
            dedup.add(k)
            wout.append(w)
    print(json.dumps({"routes": uniq, "warnings": wout}, indent=1))
