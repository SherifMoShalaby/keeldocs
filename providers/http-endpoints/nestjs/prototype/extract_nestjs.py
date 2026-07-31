#!/usr/bin/env python3
"""NestJS endpoint extractor — DECLARATIVE tier.

Tree-sitter query finds @Controller-decorated classes (exported or not);
inside each matched class body we associate runs of decorators with the
method_definition they precede and keep HTTP-verb decorators.
Path = '/' + controllerPath + '/' + methodPath (no global prefix / version,
matching ground-truth convention).
"""
import json, os, sys
import tree_sitter_typescript as tst
from tree_sitter import Language, Parser, Query, QueryCursor

LANG = Language(tst.language_typescript())
PARSER = Parser(LANG)
HTTP_DECS = {"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH",
             "Delete": "DELETE", "All": "ALL", "Head": "HEAD", "Options": "OPTIONS"}

CONTROLLER_QUERY = Query(LANG, r"""
(export_statement
  (decorator (call_expression
    function: (identifier) @cdec (#eq? @cdec "Controller")
    arguments: (arguments) @cargs))
  declaration: (class_declaration body: (class_body) @cbody))

(class_declaration
  (decorator (call_expression
    function: (identifier) @cdec2 (#eq? @cdec2 "Controller")
    arguments: (arguments) @cargs2))
  body: (class_body) @cbody2)
""")


def string_text(node):
    """text of a string literal node without quotes"""
    for c in node.children:
        if c.type == "string_fragment":
            return c.text.decode()
    return ""  # empty string literal ''


def parse_decorator_args(args_node):
    """Return (paths:list[str], literal:bool). arguments node of @Controller(...) / @Get(...)."""
    vals = [c for c in args_node.children if c.type not in ("(", ")", ",")]
    if not vals:
        return [""], True
    first = vals[0]
    if first.type == "string":
        return [string_text(first)], True
    if first.type == "array":
        out = [string_text(c) for c in first.children if c.type == "string"]
        return (out or [""]), all(c.type in ("string", "[", "]", ",") for c in first.children)
    if first.type == "object":
        for pair in first.children:
            if pair.type == "pair":
                key = pair.child_by_field_name("key")
                val = pair.child_by_field_name("value")
                if key is not None and key.text.decode() in ("path",):
                    if val.type == "string":
                        return [string_text(val)], True
                    if val.type == "array":
                        return [string_text(c) for c in val.children if c.type == "string"], True
                    return [None], False
        return [""], True  # object without path => path ''
    return [None], False  # identifier / template string / etc: non-literal


def compose(ctrl, meth):
    parts = [p for p in (ctrl or "").strip("/").split("/") + (meth or "").strip("/").split("/") if p]
    return "/" + "/".join(parts)


def extract_file(path, repo_root):
    src = open(path, "rb").read()
    tree = PARSER.parse(src)
    rel = os.path.relpath(path, repo_root)
    out, nonliteral = [], []
    matches = QueryCursor(CONTROLLER_QUERY).matches(tree.root_node)
    for _pat, caps in matches:
        cargs = (caps.get("cargs") or caps.get("cargs2"))[0]
        cbody = (caps.get("cbody") or caps.get("cbody2"))[0]
        cpaths, lit = parse_decorator_args(cargs)
        if not lit or cpaths == [None]:
            nonliteral.append({"file": rel, "reason": "non-literal controller path"})
            cpaths = [""]
        # associate decorator runs with following method_definition
        pending = []
        for child in cbody.children:
            if child.type == "decorator":
                call = next((c for c in child.children if c.type == "call_expression"), None)
                if call is not None:
                    fn = call.child_by_field_name("function")
                    if fn is not None and fn.type == "identifier" and fn.text.decode() in HTTP_DECS:
                        pending.append((fn.text.decode(), call.child_by_field_name("arguments")))
            elif child.type == "method_definition":
                for dec_name, dec_args in pending:
                    mpaths, mlit = parse_decorator_args(dec_args) if dec_args is not None else ([""], True)
                    if not mlit or mpaths == [None]:
                        nonliteral.append({"file": rel, "reason": f"non-literal @{dec_name} path"})
                        mpaths = [""]
                    for cp in cpaths:
                        for mp in mpaths:
                            out.append({"file": rel, "method": HTTP_DECS[dec_name],
                                        "path": compose(cp, mp)})
                pending = []
            elif child.type not in ("comment", "{", "}", ";"):
                pending = []
    return out, nonliteral


def main(repo_root):
    endpoints, warns = [], []
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", "dist", ".git", "test", "coverage"))
        for f in sorted(filenames):
            if f.endswith(".ts") and not f.endswith((".spec.ts", ".d.ts", ".e2e-spec.ts")):
                e, w = extract_file(os.path.join(dirpath, f), repo_root)
                endpoints += e
                warns += w
    endpoints.sort(key=lambda e: (e["file"], e.get("line") or 0, e["method"], e["path"]))
    warns.sort(key=lambda w: (w.get("file") or "", w.get("reason") or ""))
    print(json.dumps({"endpoints": endpoints, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
