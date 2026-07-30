#!/usr/bin/env python3
"""undrift E2/E3 prototype fact extractor.

Extracts exported top-level declarations from .ts/.tsx files under any 'src'
directory of a repo checkout, computes a normalized signature per symbol and
fact_hash = sha256(canonical JSON of {kind, name, sigs}) (file path EXCLUDED
from hash; symbol ID = path::name).

Normalization (tree-sitter token stream):
- comments dropped; all whitespace collapsed (tokens joined by single space)
- ',' and ';' tokens dropped (kills trailing-comma / separator formatting)
- function/method params: where a type annotation is parseable, the param name
  is stripped and replaced by its type tokens ('...' prefix for rest,
  '?' suffix for optional); untyped params become '_'
- bodies excluded: function/method/arrow bodies, class method bodies,
  const initializer values (except arrow/function initializers -> treated as
  callable signature). namespace bodies excluded (sig = 'namespace NAME').
- type aliases / interfaces / enums: full declaration token stream (their body
  IS their signature)
- class: heritage clause + public member signatures (bodies/initializers cut)
Body tokens (truncated) are stored separately for E3 similarity, NOT hashed.
"""
import hashlib
import json
import os
import sys

import tree_sitter_typescript as tst
from tree_sitter import Language, Parser

TS = Language(tst.language_typescript())
TSX = Language(tst.language_tsx())

EXCLUDE_SEGMENTS = {
    "node_modules", "test", "tests", "__tests__", "bench", "benchmarks",
    "examples", "playground", "playgrounds", "docs", "website", "fixtures",
    "e2e", "deno", ".github", "sandbox", "runtime-tests", "perf-measures",
}
EXCLUDE_SUFFIX = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts")


def want_file(rel):
    parts = rel.split("/")
    if "src" not in parts[:-1]:
        return False
    if any(p in EXCLUDE_SEGMENTS for p in parts):
        return False
    if rel.endswith(EXCLUDE_SUFFIX):
        return False
    return rel.endswith((".ts", ".tsx"))


def leaf_tokens(node, skip=()):
    """Collect leaf token texts, skipping comments and any node in `skip`."""
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
    """Normalize one formal parameter: name stripped to type where parseable."""
    if p.type in ("required_parameter", "optional_parameter"):
        pat = p.child_by_field_name("pattern")
        typ = p.child_by_field_name("type")  # type_annotation node ': T'
        rest = pat is not None and pat.type == "rest_pattern"
        opt = p.type == "optional_parameter"
        if typ is not None:
            # type_annotation = ':' + type; drop leading ':'
            ttoks = leaf_tokens(typ)
            if ttoks and ttoks[0] == ":":
                ttoks = ttoks[1:]
            core = " ".join(ttoks)
        else:
            core = "_"
        return ("..." if rest else "") + core + ("?" if opt else "")
    # this-param, or anything unexpected: raw tokens (parseable fallback)
    return toks(p)


def params_sig(fp):
    if fp is None:
        return ""
    ps = [param_sig(c) for c in fp.named_children if c.type != "comment"]
    return "( " + " , ".join(ps) + " )"  # commas here are ours, deterministic


def callable_sig(node, kw, name):
    """function/method/arrow: kw NAME <typeparams> (paramtypes) : ret"""
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


def body_text(node):
    b = node.child_by_field_name("body")
    if b is None:
        return ""
    return toks(b)[:4000]


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
            if mtxt.startswith("private") or "#" in mtxt.split("(")[0][:40]:
                # private member (TS modifier or #-field): not part of API sig
                if mtxt.startswith("private") or mtxt.lstrip("static ").startswith("#"):
                    continue
            if m.type in ("method_definition", "abstract_method_signature",
                          "method_signature"):
                nm = m.child_by_field_name("name")
                members.append(callable_sig(m, "m", toks(nm) if nm else "?"))
            elif m.type in ("public_field_definition", "field_definition"):
                nm = m.child_by_field_name("name")
                ty = m.child_by_field_name("type")
                members.append("f " + (toks(nm) if nm else "?") +
                               (" " + toks(ty) if ty else ""))
            elif m.type == "index_signature":
                members.append("ix " + toks(m))
            # class_static_block / decorators ignored
    parts.append("{ " + " | ".join(sorted(members)) + " }")
    return " ".join(parts)


def extract_decl(decl, out, path):
    """decl: the declaration node inside an export_statement."""
    t = decl.type

    def add(name, kind, sig, body=""):
        if not name:
            return
        out.append({"path": path, "name": name, "kind": kind,
                    "sig": sig, "body": body})

    if t in ("function_declaration", "generator_function_declaration",
             "function_signature"):
        nm = decl.child_by_field_name("name")
        name = toks(nm) if nm else "default"
        add(name, "function", callable_sig(decl, "function", name),
            body_text(decl))
    elif t in ("class_declaration", "abstract_class_declaration"):
        nm = decl.child_by_field_name("name")
        name = toks(nm) if nm else "default"
        add(name, "class", class_sig(decl, name))
    elif t == "type_alias_declaration":
        nm = decl.child_by_field_name("name")
        add(toks(nm), "type", toks(decl))
    elif t == "interface_declaration":
        nm = decl.child_by_field_name("name")
        add(toks(nm), "interface", toks(decl))
    elif t == "enum_declaration":
        nm = decl.child_by_field_name("name")
        add(toks(nm), "enum", toks(decl))
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
                add(name, kw, f"{kw} {name} {toks(ty)}",
                    toks(val)[:4000] if val is not None else "")
            elif val is not None and val.type in ("arrow_function",
                                                  "function_expression",
                                                  "generator_function"):
                add(name, kw, callable_sig(val, f"{kw} fn {name}", ""),
                    body_text(val))
            elif val is not None:
                # non-callable untyped initializer: shape only (value changes
                # invisible to hash -- prototype limitation, documented)
                add(name, kw, f"{kw} {name} = <{val.type}>", toks(val)[:4000])
            else:
                add(name, kw, f"{kw} {name}")
    elif t in ("module", "internal_module"):
        nm = decl.child_by_field_name("name")
        add(toks(nm), "namespace", f"namespace {toks(nm)}")


def extract_file(path, rel):
    with open(path, "rb") as f:
        src = f.read()
    parser = Parser(TSX if rel.endswith(".tsx") else TS)
    tree = parser.parse(src)
    out = []
    for ch in tree.root_node.children:
        if ch.type != "export_statement":
            continue
        decl = ch.child_by_field_name("declaration")
        if decl is None:
            # export default <expr>, or export {..} re-export list: skip lists
            for c in ch.children:
                if c.type in ("function_declaration", "class_declaration",
                              "arrow_function"):
                    decl = c
                    break
        if decl is not None:
            extract_decl(decl, out, rel)
    return out


def main(repo_dir, out_path):
    decls = []
    nfiles = 0
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = [d for d in dirs
                   if d not in EXCLUDE_SEGMENTS and not d.startswith(".")]
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, repo_dir).replace(os.sep, "/")
            if not want_file(rel):
                continue
            nfiles += 1
            try:
                decls.extend(extract_file(full, rel))
            except Exception as e:
                print(f"WARN parse fail {rel}: {e}", file=sys.stderr)
    # group overloads: (path, name) -> sorted sig list
    symbols = {}
    for d in decls:
        key = d["path"] + "::" + d["name"]
        s = symbols.setdefault(key, {"path": d["path"], "name": d["name"],
                                     "kinds": set(), "sigs": [], "body": ""})
        s["kinds"].add(d["kind"])
        s["sigs"].append(d["sig"])
        if d["body"] and not s["body"]:
            s["body"] = d["body"]
    final = {}
    for key, s in symbols.items():
        sigs = sorted(set(s["sigs"]))
        kind = "+".join(sorted(s["kinds"]))
        canon = json.dumps({"kind": kind, "name": s["name"], "sigs": sigs},
                           sort_keys=True, separators=(",", ":"))
        h = hashlib.sha256(canon.encode()).hexdigest()[:16]
        nameless = [x.replace(" " + s["name"] + " ", " § ", 1)
                    if (" " + s["name"] + " ") in x else x for x in sigs]
        final[key] = {"path": s["path"], "name": s["name"], "kind": kind,
                      "sigs": sigs, "hash": h, "nameless": nameless,
                      "body": s["body"]}
    with open(out_path, "w") as f:
        json.dump({"nfiles": nfiles, "symbols": final}, f)
    print(f"{out_path}: {nfiles} files, {len(final)} symbols")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
