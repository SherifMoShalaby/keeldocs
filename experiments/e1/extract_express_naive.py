#!/usr/bin/env python3
"""Express NAIVE extractor — declarative-only baseline for the design's ~70% prediction.

Single-file, direct-call-only: matches (identifier).(get|post|put|patch|delete|all)
('literal', >=2 args) anywhere, where the receiver identifier merely *looks* like an
app/router (any bare identifier). Emits the literal path verbatim.
NO mount resolution, NO import following, NO chain evaluation.
"""
import json, os, sys
import tree_sitter_typescript as tst
import tree_sitter_javascript as tsj
from tree_sitter import Language, Parser

TS, JS = Language(tst.language_typescript()), Language(tsj.language())
METHODS = {"get", "post", "put", "patch", "delete", "all"}
SKIP_DIRS = {"node_modules", "dist", ".git", "test", "tests", "coverage", "public", "views", "migrations"}


def sstr(n):
    if n.type == "string":
        for c in n.children:
            if c.type == "string_fragment":
                return c.text.decode()
        return ""
    return None


def scan(path, root, out):
    lang = TS if path.endswith(".ts") else JS
    tree = Parser(lang).parse(open(path, "rb").read())
    rel = os.path.relpath(path, root)

    def walk(n):
        if n.type == "call_expression":
            fn = n.child_by_field_name("function")
            if fn is not None and fn.type == "member_expression":
                obj = fn.child_by_field_name("object")
                prop = fn.child_by_field_name("property")
                if (obj is not None and obj.type == "identifier"
                        and prop is not None and prop.text.decode() in METHODS):
                    args = [c for c in n.child_by_field_name("arguments").children
                            if c.type not in ("(", ")", ",", "comment")]
                    p = sstr(args[0]) if args else None
                    if p is not None and len(args) >= 2:
                        out.append({"file": rel, "method": prop.text.decode().upper(),
                                    "path": p if p.startswith("/") else "/" + p,
                                    "line": n.start_point[0] + 1})
        for c in n.children:
            walk(c)
    walk(tree.root_node)


def main(root):
    out = []
    for dirpath, dirnames, fnames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in fnames:
            if f.endswith((".ts", ".js")) and not f.endswith((".d.ts", ".spec.ts", ".test.ts", ".test.js", ".min.js")):
                scan(os.path.join(dirpath, f), root, out)
    print(json.dumps({"endpoints": out}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
