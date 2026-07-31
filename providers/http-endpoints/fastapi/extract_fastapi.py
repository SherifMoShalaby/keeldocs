#!/usr/bin/env python3
"""http-endpoints / fastapi provider (keeldocs) - CODE tier, v0.2 Python headline.

FastAPI is decorator-shaped at the leaf but mount-shaped at the trunk - the
same lesson E1 taught for Express: naive decorator scanning misses every
router prefix. This extractor resolves the mount graph:

  app = FastAPI(...)                       -> app node
  r = APIRouter(prefix="/items")           -> router node w/ own prefix
  @r.get("/{id}") / @r.api_route(..., methods=[...])  -> registrations
  app.include_router(r, prefix="/api")     -> mount edge (+ prefix)
  from .routers import items ; items.router      -> cross-file router refs
  from .routers.items import router              -> ditto, direct form

Full path = include-prefix chain + APIRouter(prefix=) + decorator path.
Non-literal paths/prefixes emit extraction-gap warnings, never guesses
(constraint 6). Deterministic contract: endpoints sorted by
(file, line, method, path); warnings by (file, reason).
"""
import json
import os
import sys

import tree_sitter_python as tsp
from tree_sitter import Language, Parser

LANG = Language(tsp.language())
PARSER = Parser(LANG)

VERBS = {"get": "GET", "post": "POST", "put": "PUT", "patch": "PATCH",
         "delete": "DELETE", "head": "HEAD", "options": "OPTIONS", "trace": "TRACE"}
EXCLUDE_DIRS = {"node_modules", ".git", ".keeldocs", "golden", "docs", "dist", "build",
                "coverage", "test", "tests", "__pycache__", ".venv", "venv", "fixtures",
                "examples", "e2e", "migrations"}

files = {}          # rel -> {"imports": {local: (module_rel, attr|None)}, "routers": {name: nodeid}}
node_kind = {}      # nodeid -> "app" | "router"
node_prefix = {}    # nodeid -> APIRouter(prefix=...) literal or ""
registrations = []  # (nodeid, METHOD, path, rel, line)
mounts = []         # (parent_nodeid, prefix, (rel, name) child ref)
warnings = []


def lit_string(node):
    if node is None or node.type != "string":
        return None
    return "".join(c.text.decode() for c in node.children if c.type == "string_content")


def kwarg(call_args, name):
    for c in call_args.named_children:
        if c.type == "keyword_argument":
            k = c.child_by_field_name("name")
            if k is not None and k.text.decode() == name:
                return c.child_by_field_name("value")
    return None


def first_positional(call_args):
    for c in call_args.named_children:
        if c.type != "keyword_argument":
            return c
    return None


def want(fn):
    return fn.endswith(".py") and not fn.startswith("test_") and not fn.endswith("_test.py")


def scan_file(root, rel):
    tree = PARSER.parse(open(os.path.join(root, rel), "rb").read())
    f = files[rel] = {"imports": {}, "routers": {}}

    def node_id(name):
        return f"{rel}::{name}"

    for stmt in tree.root_node.children:
        # imports: from .routers import items [as x] / from .routers.items import router
        if stmt.type == "import_from_statement":
            mod = stmt.child_by_field_name("module_name")
            if mod is None:
                continue
            spec = mod.text.decode()
            for c in stmt.named_children[1:]:
                if c.type == "dotted_name":
                    f["imports"][c.text.decode()] = (spec, c.text.decode())
                elif c.type == "aliased_import":
                    nm = c.child_by_field_name("name")
                    al = c.child_by_field_name("alias")
                    if nm is not None and al is not None:
                        f["imports"][al.text.decode()] = (spec, nm.text.decode())
            continue

        inner = stmt
        if stmt.type == "decorated_definition":
            # verb decorators handled below via the decorators themselves
            for dec in (c for c in stmt.children if c.type == "decorator"):
                call = dec.named_children[0] if dec.named_children else None
                if call is None or call.type != "call":
                    continue
                fn = call.child_by_field_name("function")
                if fn is None or fn.type != "attribute":
                    continue
                obj = fn.child_by_field_name("object")
                attr = fn.child_by_field_name("attribute")
                if obj is None or attr is None or obj.type != "identifier":
                    continue
                owner, meth = obj.text.decode(), attr.text.decode()
                args = call.child_by_field_name("arguments")
                line = dec.start_point[0] + 1
                if meth in VERBS:
                    path = lit_string(first_positional(args)) if args is not None else None
                    if args is not None and first_positional(args) is not None and path is None:
                        warnings.append({"file": rel, "reason": f"non-literal @{owner}.{meth} path"})
                        path = ""
                    registrations.append((node_id(owner), VERBS[meth], path or "", rel, line))
                elif meth == "api_route":
                    path = lit_string(first_positional(args)) if args is not None else None
                    methods = kwarg(args, "methods") if args is not None else None
                    if path is None:
                        warnings.append({"file": rel, "reason": f"non-literal @{owner}.api_route path"})
                        path = ""
                    verbs = []
                    if methods is not None and methods.type == "list":
                        for s in methods.named_children:
                            v = lit_string(s)
                            if v and v.upper() in VERBS.values():
                                verbs.append(v.upper())
                    for v in (verbs or ["GET"]):
                        registrations.append((node_id(owner), v, path, rel, line))
            continue

        if inner.type != "expression_statement":
            continue
        for e in inner.named_children:
            # app = FastAPI() / r = APIRouter(prefix="/x")
            if e.type == "assignment":
                lhs = e.child_by_field_name("left")
                rhs = e.child_by_field_name("right")
                if lhs is None or rhs is None or lhs.type != "identifier" or rhs.type != "call":
                    continue
                cfn = rhs.child_by_field_name("function")
                if cfn is None or cfn.type != "identifier":
                    continue
                ctor = cfn.text.decode()
                if ctor in ("FastAPI", "APIRouter"):
                    name = lhs.text.decode()
                    nid = node_id(name)
                    node_kind[nid] = "app" if ctor == "FastAPI" else "router"
                    f["routers"][name] = nid
                    args = rhs.child_by_field_name("arguments")
                    pref = kwarg(args, "prefix") if args is not None else None
                    if pref is not None:
                        lit = lit_string(pref)
                        if lit is None:
                            warnings.append({"file": rel, "reason": f"non-literal APIRouter prefix for {name}"})
                            lit = ""
                        node_prefix[nid] = lit
            # app.include_router(items.router, prefix="/api")
            elif e.type == "call":
                cfn = e.child_by_field_name("function")
                if cfn is None or cfn.type != "attribute":
                    continue
                obj = cfn.child_by_field_name("object")
                attr = cfn.child_by_field_name("attribute")
                if obj is None or attr is None or attr.text.decode() != "include_router" or obj.type != "identifier":
                    continue
                args = e.child_by_field_name("arguments")
                if args is None:
                    continue
                child = first_positional(args)
                pref = kwarg(args, "prefix")
                prefix = ""
                if pref is not None:
                    lit = lit_string(pref)
                    if lit is None:
                        warnings.append({"file": rel, "reason": "non-literal include_router prefix"})
                        lit = ""
                    prefix = lit
                ref = None
                if child is not None and child.type == "identifier":
                    ref = (rel, child.text.decode())
                elif child is not None and child.type == "attribute":
                    o = child.child_by_field_name("object")
                    a = child.child_by_field_name("attribute")
                    if o is not None and a is not None and o.type == "identifier":
                        ref = (rel, f"{o.text.decode()}.{a.text.decode()}")
                if ref is not None:
                    mounts.append((node_id(obj.text.decode()), prefix, ref))
                else:
                    warnings.append({"file": rel, "reason": "unresolvable include_router target"})


def resolve_module(from_rel, spec, file_set):
    if spec.startswith("."):
        dots = len(spec) - len(spec.lstrip("."))
        rest = spec.lstrip(".")
        base = os.path.dirname(from_rel)
        for _ in range(dots - 1):
            base = os.path.dirname(base)
        parts = ([base] if base else []) + (rest.split(".") if rest else [])
    else:
        parts = spec.split(".")
    stem = "/".join(p for p in parts if p)
    for cand in (stem + ".py", stem + "/__init__.py"):
        if cand in file_set:
            return cand
    return None


def resolve_ref(rel, name, file_set, depth=0):
    """(rel, name) -> node id, following imports and module.attr forms."""
    if depth > 6:
        return None
    f = files.get(rel)
    if f is None:
        return None
    if "." in name:  # items.router -> module local `items`, attr `router`
        mod_local, attr = name.split(".", 1)
        imp = f["imports"].get(mod_local)
        if imp is None:
            return None
        target = resolve_module(rel, imp[0] + ("." + imp[1] if imp[1] else ""), file_set)
        if target is None:
            return None
        return resolve_ref(target, attr, file_set, depth + 1)
    if name in f["routers"]:
        return f["routers"][name]
    imp = f["imports"].get(name)
    if imp is not None:  # from .routers.items import router
        target = resolve_module(rel, imp[0], file_set)
        if target is not None:
            return resolve_ref(target, imp[1], file_set, depth + 1)
    return None


def main(root):
    rels = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if want(fn):
                rels.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    rels.sort()
    file_set = set(rels)
    for rel in rels:
        try:
            scan_file(root, rel)
        except OSError:
            continue

    # mount graph: accumulate prefixes from apps downward
    children = {}
    mounted = set()
    for parent, prefix, (rel, name) in mounts:
        child = resolve_ref(rel, name, file_set)
        if child is None:
            warnings.append({"file": rel, "reason": f"include_router target `{name}` not found"})
            continue
        children.setdefault(parent, []).append((prefix, child))
        mounted.add(child)

    roots = [n for n, k in node_kind.items() if k == "app" or n not in mounted]
    prefixes = {}
    work = [(r, "") for r in sorted(roots)]
    guard = 0
    while work and guard < 10000:
        guard += 1
        node, pre = work.pop()
        own = node_prefix.get(node, "")
        full = (pre.rstrip("/") + "/" + own.strip("/")).rstrip("/") if own else pre
        if full in prefixes.setdefault(node, set()):
            continue
        prefixes[node].add(full)
        for cp, child in children.get(node, []):
            work.append((child, (full.rstrip("/") + "/" + cp.strip("/")).rstrip("/")))

    out = []
    for nid, meth, path, rel, line in registrations:
        for pre in sorted(prefixes.get(nid, {""})):
            full = (pre.rstrip("/") + "/" + path.lstrip("/")).rstrip("/") or "/"
            out.append({"file": rel, "method": meth, "path": full, "line": line})
    out.sort(key=lambda e: (e["file"], e["line"], e["method"], e["path"]))
    uniq_warn = sorted({(w["file"], w["reason"]) for w in warnings})
    print(json.dumps({"endpoints": out,
                      "warnings": [{"file": f, "reason": r} for f, r in uniq_warn]}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
