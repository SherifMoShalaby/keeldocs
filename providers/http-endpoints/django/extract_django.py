#!/usr/bin/env python3
"""Django URLconf extractor (breadth batch; probe: wagtail/bakerydemo).

Any repo file defining `urlpatterns` is a urlconf. path()/re_path() entries
collect per file; include() edges compose prefixes across files - string form
("app.urls") resolves module-path-style, imported-name form resolves through
that file's from-imports when the target lives in the repo. Roots are
urlconfs nobody includes. Method-agnostic by platform design -> method ALL;
converters (<int:pk>) stay verbatim; re_path regexes and urlconfs outside the
repo are named gaps, never guessed paths. Deterministic throughout.
"""
import json, os, sys

from tree_sitter import Language, Parser
import tree_sitter_python as tspy

SKIP = {"node_modules", ".git", ".keeldocs", "golden", "migrations", "__pycache__", ".venv", "venv", "dist"}
lang = Language(tspy.language())
parser = Parser(lang)


def sstr(n):
    if n is not None and n.type == "string":
        return "".join(c.text.decode() for c in n.children if c.type == "string_content")
    return None


def main(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(".py"):
                files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))

    conf = {}    # rel -> {"entries": [(prefix, kind, target)], } kind: route|include
    imports = {} # rel -> {local name -> dotted module}
    warns = []

    def module_to_rel(dotted):
        base = dotted.replace(".", "/")
        for cand in (base + ".py", base + "/__init__.py"):
            if cand in set(files):
                return cand
        return None

    for rel in files:
        src = open(os.path.join(root, rel), "rb").read()
        if b"urlpatterns" not in src:
            continue
        tree = parser.parse(src)
        entries, imap = [], {}
        def walk(n):
            if n.type == "import_from_statement":
                mod = n.child_by_field_name("module_name")
                if mod is not None:
                    dotted = mod.text.decode()
                    for c in n.children:
                        if c.type == "dotted_name" and c is not mod:
                            imap[c.text.decode()] = f"{dotted}.{c.text.decode()}"
                        if c.type == "aliased_import":
                            name = c.child_by_field_name("name")
                            alias = c.child_by_field_name("alias")
                            if name is not None and alias is not None:
                                imap[alias.text.decode()] = f"{dotted}.{name.text.decode()}"
            if n.type == "call":
                fn = n.child_by_field_name("function")
                fname = fn.text.decode().split(".")[-1] if fn is not None else ""
                if fname in ("path", "re_path", "url"):
                    args = n.child_by_field_name("arguments")
                    if args is None or args.named_child_count == 0:
                        return
                    route = sstr(args.named_child(0))
                    if route is None:
                        warns.append({"file": rel, "reason": "non-literal route"})
                        return
                    if fname in ("re_path", "url"):
                        warns.append({"file": rel, "reason": "regex route (re_path) not composed"})
                        return
                    second = args.named_child(1) if args.named_child_count > 1 else None
                    inc = None
                    if second is not None and second.type == "call":
                        sfn = second.child_by_field_name("function")
                        if sfn is not None and sfn.text.decode().split(".")[-1] == "include":
                            sargs = second.child_by_field_name("arguments")
                            tgt = sargs.named_child(0) if sargs is not None and sargs.named_child_count else None
                            inc = sstr(tgt) or (tgt.text.decode() if tgt is not None and tgt.type == "identifier" else None)
                    if inc is not None:
                        entries.append((route, "include", inc))
                    else:
                        entries.append((route, "route", None))
                    return  # do not descend into handled call
            for c in n.children:
                walk(c)
        walk(tree.root_node)
        conf[rel] = entries
        imports[rel] = imap

    # include edges -> which urlconfs are roots
    included = set()
    edges = {}  # rel -> [(prefix, target rel)]
    for rel, entries in sorted(conf.items()):
        edges[rel] = []
        for prefix, kind, tgt in entries:
            if kind != "include":
                continue
            dotted = tgt if "." in (tgt or "") else imports[rel].get(tgt, tgt)
            child = module_to_rel(dotted) if dotted else None
            if child is None or child not in conf:
                warns.append({"file": rel, "reason": f"urlconf outside the repo: {str(tgt)[:40]}"})
                continue
            edges[rel].append((prefix, child))
            included.add(child)

    endpoints = []
    def emit(rel, prefix, seen):
        if rel in seen:
            return
        for route, kind, _tgt in conf[rel]:
            if kind == "route":
                full = "/" + "/".join(p for p in (prefix + route).split("/") if p)
                endpoints.append({"file": rel, "method": "ALL", "path": full or "/"})
        for pre, child in edges[rel]:
            emit(child, prefix + pre, seen | {rel})

    for rel in sorted(conf):
        if rel not in included:
            emit(rel, "/", frozenset())

    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    print(json.dumps({"endpoints": endpoints, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
