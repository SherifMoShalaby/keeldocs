#!/usr/bin/env python3
"""react-router route extractor (client-routes capability, owner-requested).

Two registration idioms, both with NESTED path composition:
  JSX:    <Routes><Route path="owners"><Route path=":id" element/></Route></Routes>
  object: createBrowserRouter([{ path: "/", children: [{ path: "tags" }] }])
          (also useRoutes([...]))

Rules (the E1 lesson, again):
- literal path values only; a computed `path={expr}` emits an extraction-gap,
  never a guessed route
- `index` routes resolve to their parent's path
- absolute child paths (leading "/") replace the accumulated prefix, matching
  react-router semantics
Deterministic: sorted walks and emission, no clock, no network.
"""
import json, os, sys

from tree_sitter import Language, Parser
import tree_sitter_typescript as tst

EXCLUDE = {"node_modules", "dist", "build", ".git", ".keeldocs", "golden", "coverage"}
TSX = Language(tst.language_tsx())
TS = Language(tst.language_typescript())


def sstr(n):
    if n is None:
        return None
    if n.type == "string":
        for c in n.children:
            if c.type == "string_fragment":
                return c.text.decode()
        return ""
    return None


def compose(prefix, seg):
    if seg is None:
        return prefix or "/"
    if seg.startswith("/"):
        base = seg
    else:
        base = (prefix or "").rstrip("/") + "/" + seg
    out = "/" + "/".join(p for p in base.split("/") if p)
    return out or "/"


def scan_file(rel, src, lang, routes, warns):
    tree = Parser(lang).parse(src)

    def jsx_attr(node, name):
        for c in node.children:
            if c.type == "jsx_attribute" and c.children and c.children[0].text.decode() == name:
                if len(c.children) >= 3:
                    v = c.children[2]
                    if v.type == "string":
                        return sstr(v), True
                    return None, False  # computed value
                return "", True  # bare attribute (e.g. `index`)
        return None, None  # absent

    def is_route(node):
        if node.type not in ("jsx_element", "jsx_self_closing_element"):
            return None
        head = node.children[0] if node.type == "jsx_element" else node
        for c in head.children:
            if c.type == "identifier" and c.text.decode() == "Route":
                return head
        return None

    def walk_jsx(node, prefix):
        head = is_route(node)
        if head is not None:
            path, lit = jsx_attr(head, "path")
            index, _ = jsx_attr(head, "index")
            if lit is False:
                warns.append({"file": rel, "reason": "non-literal Route path"})
                return
            here = compose(prefix, path) if path is not None else (prefix or "/")
            has_el, _ = jsx_attr(head, "element")
            if path is not None or index is not None or has_el is not None:
                routes.append({"file": rel, "path": here})
            for c in node.children:
                walk_jsx(c, here)
            return
        for c in node.children:
            walk_jsx(c, prefix)

    def obj_prop(obj, name):
        for p in obj.children:
            if p.type == "pair":
                k = p.child_by_field_name("key")
                if k is not None and k.text.decode().strip("\"'") == name:
                    return p.child_by_field_name("value")
        return None

    def walk_objects(arr, prefix):
        for el in arr.children:
            if el.type != "object":
                continue
            pv = obj_prop(el, "path")
            here = prefix or "/"
            if pv is not None:
                s = sstr(pv)
                if s is None:
                    warns.append({"file": rel, "reason": "non-literal route path"})
                    continue
                here = compose(prefix, s)
                routes.append({"file": rel, "path": here})
            elif obj_prop(el, "index") is not None or obj_prop(el, "element") is not None:
                routes.append({"file": rel, "path": here})
            ch = obj_prop(el, "children")
            if ch is not None and ch.type == "array":
                walk_objects(ch, here)

    def find_router_calls(node):
        if node.type == "call_expression":
            fn = node.child_by_field_name("function")
            if fn is not None and fn.text.decode().split(".")[-1] in ("createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes"):
                args = node.child_by_field_name("arguments")
                if args is not None:
                    for a in args.children:
                        if a.type == "array":
                            walk_objects(a, "")
        for c in node.children:
            find_router_calls(c)

    walk_jsx(tree.root_node, "")
    find_router_calls(tree.root_node)


def main(root):
    routes, warns = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE and not d.startswith("."))
        for fn in sorted(filenames):
            if not fn.endswith((".tsx", ".jsx", ".ts")) or fn.endswith((".test.tsx", ".spec.tsx", ".d.ts")):
                continue
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            lang = TSX if fn.endswith((".tsx", ".jsx")) else TS
            scan_file(rel, open(p, "rb").read(), lang, routes, warns)
    seen = set()
    uniq = []
    for r in sorted(routes, key=lambda r: (r["path"], r["file"])):
        if r["path"] in seen:
            continue  # layout wrappers repeat their own path once per child level
        seen.add(r["path"])
        uniq.append(r)
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    print(json.dumps({"routes": uniq, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
