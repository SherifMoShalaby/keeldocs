#!/usr/bin/env python3
"""module-graph / ts-imports provider (keeldocs).

Ports the E2/E3-validated symbol extractor (survival >=98.5% across 12 months
of hono+zod history) into the provider contract. Two outputs:

  modules: per-file import edges (ESM import/re-export specifiers; relative
           specifiers resolved against the walked file set, extension-probed)
  symbols: exported top-level declarations with NORMALIZED signatures - the
           declaration shape that symbol drift is defined over (ADR-008)

Normalization (tree-sitter token stream, from the E-series prototype):
- comments dropped; whitespace collapsed; ',' and ';' tokens dropped
- param names stripped to their type tokens ('...' rest prefix, '?' optional
  suffix); untyped params become '_'
- bodies and initializer values excluded - handler refactors are not API drift
- type aliases / interfaces / enums: full declaration stream (body IS the sig)
- class: heritage + public member signatures, sorted
- ADR-007 amendment (3): when a function has separate overload signatures,
  the non-callable implementation signature is EXCLUDED from the fact - the
  one observed false drift in E2 was implementation-signature churn.

Scope (honest v0.1): TS/TSX + ESM JS. CommonJS module.exports is not modeled;
files with neither import statements nor exported declarations emit nothing.
Output is deterministic: sorted modules, imports, symbols, sigs.
"""
import json
import os
import sys

import tree_sitter_typescript as tst
from tree_sitter import Language, Parser

TS = Language(tst.language_typescript())
TSX = Language(tst.language_tsx())

EXCLUDE_DIRS = {
    "node_modules", ".git", ".keeldocs", "golden", "docs", "dist", "build",
    "coverage", "test", "tests", "__tests__", "e2e", "examples", "fixtures",
}
EXCLUDE_SUFFIX = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts",
                  ".test.js", ".spec.js")
EXTS = (".ts", ".tsx", ".js", ".mjs")


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


def want_file(rel):
    return rel.endswith(EXTS) and not rel.endswith(EXCLUDE_SUFFIX)


def leaf_tokens(node, skip=()):
    out = []
    stack = [node]
    while stack:
        n = stack.pop()
        if id(n) in skip or n.type == "comment":
            continue
        if n.child_count == 0:
            t = n.text.decode("utf8", "replace")
            if t not in (",", ";") and t.strip():
                out.append(t)
        else:
            stack.extend(reversed(n.children))
    return out


def toks(node, skip_nodes=()):
    return " ".join(leaf_tokens(node, skip={id(x) for x in skip_nodes}))


def param_sig(p):
    if p.type in ("required_parameter", "optional_parameter"):
        pat = p.child_by_field_name("pattern")
        typ = p.child_by_field_name("type")
        rest = pat is not None and pat.type == "rest_pattern"
        opt = p.type == "optional_parameter"
        if typ is not None:
            ttoks = leaf_tokens(typ)
            if ttoks and ttoks[0] == ":":
                ttoks = ttoks[1:]
            core = " ".join(ttoks)
        else:
            core = "_"
        return ("..." if rest else "") + core + ("?" if opt else "")
    return toks(p)


def params_sig(fp):
    if fp is None:
        return ""
    ps = [param_sig(c) for c in fp.named_children if c.type != "comment"]
    return "( " + " , ".join(ps) + " )"


def callable_sig(node, kw, name):
    tp = node.child_by_field_name("type_parameters")
    fp = node.child_by_field_name("parameters")
    rt = node.child_by_field_name("return_type")
    parts = [kw, name]
    if tp is not None:
        parts.append(toks(tp))
    parts.append(params_sig(fp))
    if rt is not None:
        parts.append(toks(rt))
    return " ".join(p for p in parts if p)


def class_sig(node, name):
    parts = ["class", name]
    tp = node.child_by_field_name("type_parameters")
    if tp is not None:
        parts.append(toks(tp))
    for ch in node.children:
        if ch.type == "class_heritage":
            parts.append(toks(ch))
    body = node.child_by_field_name("body")
    members = []
    if body is not None:
        for m in body.named_children:
            if m.type == "comment":
                continue
            mtxt = m.text.decode("utf8", "replace").lstrip()
            head = mtxt.split("(")[0][:40]
            if mtxt.startswith("private") or head.lstrip("static ").startswith("#"):
                continue  # private API is not signature surface
            if m.type in ("method_definition", "abstract_method_signature", "method_signature"):
                nm = m.child_by_field_name("name")
                members.append(callable_sig(m, "m", toks(nm) if nm else "?"))
            elif m.type in ("public_field_definition", "field_definition"):
                nm = m.child_by_field_name("name")
                ty = m.child_by_field_name("type")
                members.append("f " + (toks(nm) if nm else "?") + (" " + toks(ty) if ty else ""))
            elif m.type == "index_signature":
                members.append("ix " + toks(m))
    parts.append("{ " + " | ".join(sorted(members)) + " }")
    return " ".join(parts)


def extract_decls(decl, out, path):
    t = decl.type

    def add(name, kind, sig, impl=False):
        if name:
            out.append({"path": path, "name": name, "kind": kind, "sig": sig, "impl": impl})

    if t in ("function_declaration", "generator_function_declaration", "function_signature"):
        nm = decl.child_by_field_name("name")
        name = toks(nm) if nm else "default"
        impl = t != "function_signature" and decl.child_by_field_name("body") is not None
        add(name, "function", callable_sig(decl, "function", name), impl)
    elif t in ("class_declaration", "abstract_class_declaration"):
        nm = decl.child_by_field_name("name")
        add(toks(nm) if nm else "default", "class", class_sig(decl, toks(nm) if nm else "default"))
    elif t == "type_alias_declaration":
        add(toks(decl.child_by_field_name("name")), "type", toks(decl))
    elif t == "interface_declaration":
        add(toks(decl.child_by_field_name("name")), "interface", toks(decl))
    elif t == "enum_declaration":
        add(toks(decl.child_by_field_name("name")), "enum", toks(decl))
    elif t in ("lexical_declaration", "variable_declaration"):
        kw = "const" if "const" in (c.type for c in decl.children) else "let"
        for d in decl.named_children:
            if d.type != "variable_declarator":
                continue
            nm = d.child_by_field_name("name")
            name = toks(nm) if nm else None
            ty = d.child_by_field_name("type")
            val = d.child_by_field_name("value")
            if ty is not None:
                add(name, kw, f"{kw} {name} {toks(ty)}")
            elif val is not None and val.type in ("arrow_function", "function_expression",
                                                  "generator_function"):
                add(name, "function", callable_sig(val, f"{kw} fn {name}", ""))
            elif val is not None:
                add(name, kw, f"{kw} {name} = <{val.type}>")
            else:
                add(name, kw, f"{kw} {name}")
    elif t in ("module", "internal_module"):
        nm = decl.child_by_field_name("name")
        add(toks(nm), "namespace", f"namespace {toks(nm)}")


def import_specifier(stmt):
    src = stmt.child_by_field_name("source")
    if src is None:
        for c in stmt.children:  # export ... from "x" keeps source as plain child
            if c.type == "string":
                src = c
                break
    if src is None:
        return None
    return src.text.decode("utf8", "replace").strip("\"'`")


def resolve_relative(from_rel, spec, file_set):
    if not spec.startswith("."):
        return None  # external package - edge kept by specifier only
    base = os.path.normpath(os.path.join(os.path.dirname(from_rel), spec)).replace(os.sep, "/")
    probes = [base] if base.endswith(EXTS) else []
    stem = base[:-3] if base.endswith(".js") else base  # TS emits .js specifiers for .ts files
    probes += [stem + e for e in EXTS] + [base + "/index" + e for e in EXTS]
    for p in probes:
        if p in file_set:
            return p
    return None


def extract_file(full, rel):
    with open(full, "rb") as f:
        src = f.read()
    parser = Parser(TSX if rel.endswith(".tsx") else TS)
    tree = parser.parse(src)
    decls, imports = [], []
    for ch in tree.root_node.children:
        if ch.type == "import_statement":
            spec = import_specifier(ch)
            if spec:
                imports.append(spec)
        elif ch.type == "export_statement":
            spec = import_specifier(ch)  # export {x} from "./y" is an edge too
            if spec:
                imports.append(spec)
            decl = ch.child_by_field_name("declaration")
            if decl is None:
                for c in ch.children:
                    if c.type in ("function_declaration", "class_declaration", "arrow_function"):
                        decl = c
                        break
            if decl is not None:
                extract_decls(decl, decls, rel)
    return decls, imports


def load_handoff():
    """The engine's per-file parse cache for THIS provider, if it supplied one.

    Every failure mode here degrades to a full parse rather than to a wrong
    answer: no env var, a missing file, malformed JSON, a digest the engine
    never mentioned. That asymmetry is the whole safety argument - the worst
    case is slow, never incorrect.
    """
    path = os.environ.get("KEELDOCS_INCREMENTAL")
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            h = json.load(f)
        if not isinstance(h, dict):
            return {}
        return {"parsed": h.get("parsed") or {}, "digests": h.get("digests") or {}}
    except Exception:
        return {}


def main(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in EXCLUDE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
            if want_file(rel):
                files.append(rel)
    file_set = set(files)

    # D4 per-file parse cache. PARSING one file is independent of the others;
    # RESOLUTION below is not, and it still runs over every file every time.
    # The engine hands back parses it has seen before, keyed by content digest,
    # so an edit re-parses the file that changed and nothing else. Absent,
    # partial or stale handoff must all produce identical output - the handoff
    # is an optimisation, never an input to the answer.
    handoff = load_handoff()
    known = handoff.get("parsed", {})
    digests = handoff.get("digests", {})
    fresh = {}

    all_decls, mod_imports, warnings = [], {}, []
    for rel in files:
        # The cache key is the engine's content digest plus what else actually
        # changes this parse - here the grammar, since a .tsx and a .ts file
        # with identical bytes do not parse the same. The stored decls are
        # PATH-FREE and the path is stamped on use: two identical files at
        # different paths share one parse, and an intermediate that carried a
        # path would have quietly given both of them the same one.
        digest = digests.get(rel)
        key = digest + ("|tsx" if rel.endswith(".tsx") else "|ts") if digest else None
        cached = known.get(key) if key else None
        if cached is not None:
            decls = [dict(d, path=rel) for d in cached["decls"]]
            imports = cached["imports"]
        else:
            try:
                decls, imports = extract_file(os.path.join(root, rel), rel)
            except Exception as e:  # parse failure is a gap, never silence
                warnings.append({"kind": "parse-failed", "file": rel, "detail": str(e)[:120]})
                continue
            if key:
                fresh[key] = {"decls": [{k: v for k, v in d.items() if k != "path"} for d in decls],
                              "imports": sorted(set(imports))}
        all_decls.extend(decls)
        if imports:
            mod_imports[rel] = sorted(set(imports))

    # group overloads per (path, name); amendment (3): drop the implementation
    # signature when separate overload signatures exist for the same name
    grouped = {}
    for d in all_decls:
        grouped.setdefault((d["path"], d["name"]), []).append(d)
    pkgs = workspace_packages()
    symbols = []
    for (path, name), ds in sorted(grouped.items()):
        has_overloads = any(d["kind"] == "function" and not d["impl"] for d in ds) \
            and any(d["impl"] for d in ds)
        kept = [d for d in ds if not (has_overloads and d["impl"])]
        kinds = "+".join(sorted({d["kind"] for d in kept}))
        sigs = sorted({d["sig"] for d in kept})
        nameless = [s.replace(" " + name + " ", " § ", 1)
                    if (" " + name + " ") in s else s for s in sigs]
        symbols.append({"path": path, "name": name, "package": pkg_for(path, pkgs),
                        "kind": kinds, "sigs": sigs, "nameless": nameless})

    modules = []
    participating = {s["path"] for s in symbols} | set(mod_imports)
    for rel in sorted(participating):
        edges = [{"specifier": s, "resolved": resolve_relative(rel, s, file_set)}
                 for s in mod_imports.get(rel, [])]
        modules.append({"path": rel, "package": pkg_for(rel, pkgs), "imports": edges})

    out = {"modules": modules, "symbols": symbols, "warnings": warnings}
    # The engine strips `_parsed` before anything sees it as a fact; it exists
    # only so the next run can skip re-parsing what has not changed.
    if fresh:
        out["_parsed"] = fresh
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
