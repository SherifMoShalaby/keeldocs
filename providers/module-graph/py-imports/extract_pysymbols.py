#!/usr/bin/env python3
"""module-graph / py-imports provider (keeldocs) - the v0.2 Python headline.

Same raw contract as ts-imports ({modules, symbols, warnings}), so the engine
normalizer, `ds` identity scheme, and S1b move-matching apply unchanged - the
first capability served by two providers at once (fact paths cannot collide:
one walks .ts/.js, this walks .py).

Public surface, Python rules:
- `__all__ = [...]` (all-literal) defines the public set exactly when present;
  otherwise every non-underscore module-level def / class / assignment.
- Signatures normalized in the E2 discipline: parameter names stripped to
  their annotations ('_' when untyped, '=?' marks a default without its
  value - magic-number churn is not API drift), leading self/cls dropped in
  method signatures, async is part of the shape, decorators are not.
- ADR-007 amendment (3), Python form: when @typing.overload stubs exist for a
  name, the undecorated implementation signature is EXCLUDED from the fact.
- Imports: import / from-import edges; relative dots resolved against the
  walked file set (pkg/__init__.py aware); externals keep their specifier.
Deterministic: sorted modules, imports, symbols, sigs.
"""
import json
import os
import sys

import tree_sitter_python as tsp
from tree_sitter import Language, Parser

LANG = Language(tsp.language())
PARSER = Parser(LANG)

EXCLUDE_DIRS = {"node_modules", ".git", ".keeldocs", "golden", "docs", "dist",
                "build", "coverage", "test", "tests", "__pycache__", ".venv",
                "venv", ".eggs", "site-packages", "migrations", "fixtures", "e2e",
                "examples"}


def workspace_packages():
    """Declared cross-capability read (provider contract 9): the engine hands us
    workspace-layout's resolved fact file via KEELDOCS_FACTS_WORKSPACE_LAYOUT.
    Standalone runs (no env) return None -> package emitted as null and the
    engine normalizer fills the segment from its own view."""
    path = os.environ.get("KEELDOCS_FACTS_WORKSPACE_LAYOUT")
    if not path or not os.path.exists(path):
        return None
    pkgs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            f = json.loads(line)
        except ValueError:
            continue
        if f.get("payload", {}).get("type") == "package":
            a = f["payload"]["attrs"]
            pkgs.append({"name": a["name"], "path": a["path"]})
    return pkgs or None


def pkg_for(path, pkgs):
    if pkgs is None:
        return None
    best = None
    for p in pkgs:
        if p["path"] == "." or path == p["path"] or path.startswith(p["path"] + "/"):
            if best is None or len(p["path"]) > len(best["path"]):
                best = p
    return best["name"] if best else None


def want(fn):
    return fn.endswith(".py") and not fn.startswith("test_") and not fn.endswith("_test.py")


def toks(node, drop=(",",)):
    out, stack = [], [node]
    while stack:
        n = stack.pop()
        if n.type == "comment":
            continue
        if n.child_count == 0:
            t = n.text.decode("utf8", "replace")
            if t.strip() and t not in drop:
                out.append(t)
        else:
            stack.extend(reversed(n.children))
    return " ".join(out)


def param_sig(p, is_method, first):
    t = p.type
    if t == "identifier":
        name = p.text.decode()
        if is_method and first and name in ("self", "cls"):
            return None
        return "_"
    if t == "typed_parameter":
        return toks(p.child_by_field_name("type"))
    if t == "default_parameter":
        nm = p.child_by_field_name("name")
        if is_method and first and nm is not None and nm.text.decode() in ("self", "cls"):
            return None
        return "_ =?"
    if t == "typed_default_parameter":
        return toks(p.child_by_field_name("type")) + " =?"
    if t == "list_splat_pattern":
        return "*" + ("_" if p.named_child_count else "")
    if t == "dictionary_splat_pattern":
        return "**"
    if t in ("positional_separator", "keyword_separator"):
        return p.text.decode()  # '/' and '*' markers are API shape
    return toks(p)


def fn_sig(node, is_method=False, is_async=False):
    name = node.child_by_field_name("name").text.decode()
    params = node.child_by_field_name("parameters")
    ps, first = [], True
    for c in (params.named_children if params else []):
        s = param_sig(c, is_method, first)
        first = False
        if s is not None:
            ps.append(s)
    ret = node.child_by_field_name("return_type")
    kw = ("async def" if is_async else "def") + (" m" if is_method else "")
    sig = f"{kw} {name} ( {' , '.join(ps)} )"
    if ret is not None:
        sig += " -> " + toks(ret)
    return name, sig


def unwrap(node):
    """decorated_definition -> (inner def/class, decorator names, is_async)"""
    decs = []
    inner = node
    if node.type == "decorated_definition":
        for c in node.children:
            if c.type == "decorator":
                decs.append(toks(c).lstrip("@ ").split(" ")[0].split(".")[-1].split("(")[0])
        inner = node.child_by_field_name("definition") or node.children[-1]
    is_async = any(c.type == "async" or c.text == b"async" for c in inner.children if c.child_count == 0)
    return inner, decs, is_async


def class_sig(node):
    name = node.child_by_field_name("name").text.decode()
    parts = ["class", name]
    sup = node.child_by_field_name("superclasses")
    if sup is not None:
        parts.append(toks(sup))
    members = []
    body = node.child_by_field_name("body")
    for stmt in (body.named_children if body else []):
        inner, _decs, is_async = unwrap(stmt)
        if inner.type == "function_definition":
            mname = inner.child_by_field_name("name").text.decode()
            if not mname.startswith("_") or mname in ("__init__", "__call__"):
                members.append(fn_sig(inner, is_method=True, is_async=is_async)[1])
        elif inner.type == "expression_statement":
            for a in inner.named_children:
                if a.type == "assignment":
                    lhs = a.child_by_field_name("left")
                    typ = a.child_by_field_name("type")
                    if lhs is not None and lhs.type == "identifier" and not lhs.text.decode().startswith("_"):
                        members.append("f " + lhs.text.decode() + (" " + toks(typ) if typ is not None else ""))
    parts.append("{ " + " | ".join(sorted(members)) + " }")
    return name, " ".join(parts)


def module_decls(tree):
    """[(name, kind, sig, overload?)] for module-level definitions; plus __all__ or None."""
    decls, dunder_all = [], None
    for stmt in tree.root_node.children:
        inner, decs, is_async = unwrap(stmt)
        if inner.type == "function_definition":
            name, sig = fn_sig(inner, is_async=is_async)
            decls.append({"name": name, "kind": "function", "sig": sig,
                          "overload": "overload" in decs,
                          "impl": "overload" not in decs})
        elif inner.type == "class_definition":
            name, sig = class_sig(inner)
            decls.append({"name": name, "kind": "class", "sig": sig, "overload": False, "impl": False})
        elif inner.type == "expression_statement":
            for a in inner.named_children:
                if a.type != "assignment":
                    continue
                lhs = a.child_by_field_name("left")
                if lhs is None or lhs.type != "identifier":
                    continue
                name = lhs.text.decode()
                rhs = a.child_by_field_name("right")
                typ = a.child_by_field_name("type")
                if name == "__all__" and rhs is not None and rhs.type == "list":
                    items = [toks(s, drop=(",", '"', "'")) for s in rhs.named_children if s.type == "string"]
                    if all(items):
                        dunder_all = items
                    continue
                sig = f"const {name} " + (toks(typ) if typ is not None
                                          else f"= <{rhs.type}>" if rhs is not None else "")
                decls.append({"name": name, "kind": "const", "sig": sig.strip(), "overload": False, "impl": False})
    return decls, dunder_all


def imports_of(tree):
    out = []
    for stmt in tree.root_node.children:
        if stmt.type == "import_statement":
            for c in stmt.named_children:
                d = c.child_by_field_name("name") if c.type == "aliased_import" else c
                if d is not None and d.type == "dotted_name":
                    out.append(d.text.decode())
        elif stmt.type == "import_from_statement":
            mod = stmt.child_by_field_name("module_name")
            if mod is not None:
                out.append(mod.text.decode())
    return sorted(set(out))


def resolve(from_rel, spec, file_set):
    """Resolve a dotted (possibly relative) module spec to a repo file, or None."""
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


def main(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if want(fn):
                files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    files.sort()
    file_set = set(files)

    pkgs = workspace_packages()
    symbols, modules, warnings = [], [], []
    for rel in files:
        try:
            tree = PARSER.parse(open(os.path.join(root, rel), "rb").read())
        except OSError:
            continue
        if tree.root_node.has_error:
            warnings.append({"kind": "parse-errors", "file": rel})
        decls, dunder_all = module_decls(tree)
        public = set(dunder_all) if dunder_all is not None else None
        grouped = {}
        for d in decls:
            if public is not None:
                if d["name"] not in public:
                    continue
            elif d["name"].startswith("_"):
                continue
            grouped.setdefault(d["name"], []).append(d)
        for name in sorted(grouped):
            ds = grouped[name]
            # amendment (3), Python form: overload stubs present -> impl sig excluded
            has_overloads = any(d["overload"] for d in ds)
            kept = [d for d in ds if not (has_overloads and d["impl"])]
            kinds = "+".join(sorted({d["kind"] for d in kept}))
            sigs = sorted({d["sig"] for d in kept})
            nameless = [s.replace(" " + name + " ", " § ", 1) if (" " + name + " ") in s else s
                        for s in sigs]
            symbols.append({"path": rel, "name": name, "package": pkg_for(rel, pkgs),
                            "kind": kinds, "sigs": sigs, "nameless": nameless})
        imps = imports_of(tree)
        if imps or grouped:
            modules.append({"path": rel, "package": pkg_for(rel, pkgs), "imports": [
                {"specifier": s, "resolved": resolve(rel, s, file_set)} for s in imps]})

    symbols.sort(key=lambda s: (s["path"], s["name"]))
    modules.sort(key=lambda m: m["path"])
    warnings.sort(key=lambda w: (w["kind"], w["file"]))
    print(json.dumps({"modules": modules, "symbols": symbols, "warnings": warnings}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
