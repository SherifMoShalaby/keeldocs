#!/usr/bin/env python3
"""ASP.NET Core endpoint extractor (breadth batch): attribute controllers +
minimal APIs, per the provider.yaml rationale. Deterministic sorted walks."""
import json, os, re, sys

from tree_sitter import Language, Parser
import tree_sitter_c_sharp as tscs

SKIP = {"bin", "obj", ".git", ".keeldocs", "golden", "node_modules"}
VERB_ATTRS = {"HttpGet": "GET", "HttpPost": "POST", "HttpPut": "PUT",
              "HttpDelete": "DELETE", "HttpPatch": "PATCH", "HttpHead": "HEAD"}
MAP_VERBS = {"MapGet": "GET", "MapPost": "POST", "MapPut": "PUT",
             "MapDelete": "DELETE", "MapPatch": "PATCH"}
lang = Language(tscs.language())
parser = Parser(lang)


def sstr(n):
    if n is not None and n.type == "string_literal":
        return n.text.decode()[1:-1]
    return None


def first_arg_str(node_with_args):
    args = next((c for c in node_with_args.children if c.type in ("attribute_argument_list", "argument_list")), None)
    if args is None:
        return None, True   # no-arg form
    for c in args.children:
        if c.type in ("attribute_argument", "argument"):
            inner = c.children[-1] if c.children else None
            if inner is not None and inner.type == "string_literal":
                return sstr(inner), True
            return None, False
    return None, True


def compose(prefix, seg):
    if seg and (seg.startswith("/") or seg.startswith("~/")):
        base = seg.lstrip("~")
    else:
        base = (prefix or "") + "/" + (seg or "")
    return "/" + "/".join(p for p in base.split("/") if p) or "/"


def scan(rel, src, endpoints, warns):
    tree = parser.parse(src)
    roots = set()
    groups = {}
    calls = []

    def attr_entries(node):
        for al in (c for c in node.children if c.type == "attribute_list"):
            for a in (c for c in al.children if c.type == "attribute"):
                name_n = a.child_by_field_name("name")
                if name_n is not None:
                    yield name_n.text.decode(), a

    def walk(n):
        if n.type == "class_declaration":
            cls = n.child_by_field_name("name").text.decode()
            prefix, plit = None, True
            for name, a in attr_entries(n):
                if name in ("Route", "RoutePrefix"):
                    prefix, plit = first_arg_str(a)
            if not plit:
                warns.append({"file": rel, "reason": "non-literal controller route"})
                prefix = None
            if prefix is not None:
                prefix = prefix.replace("[controller]", cls[:-10] if cls.endswith("Controller") else cls)
            body = n.child_by_field_name("body")
            for m in (c for c in (body.children if body is not None else []) if c.type == "method_declaration"):
                extra_route = None
                for name, a in attr_entries(m):
                    if name == "Route":
                        extra_route, _ = first_arg_str(a)
                for name, a in attr_entries(m):
                    if name in VERB_ATTRS:
                        seg, lit = first_arg_str(a)
                        if not lit:
                            warns.append({"file": rel, "reason": f"non-literal [{name}] template"})
                            continue
                        endpoints.append({"file": rel, "method": VERB_ATTRS[name],
                                          "path": compose(prefix, seg if seg is not None else extra_route)})
        if n.type == "variable_declarator":
            name_n = n.child_by_field_name("name")
            val = next((c for c in n.children if c.type == "invocation_expression"), None)
            if name_n is not None and val is not None:
                fn = val.child_by_field_name("function")
                ftxt = fn.text.decode() if fn is not None else ""
                tail = ftxt.split(".")[-1]
                if tail == "Build" or ftxt.endswith("WebApplication.Create"):
                    roots.add(name_n.text.decode())
                elif tail == "MapGroup":
                    recv = ftxt.rsplit(".", 1)[0] if "." in ftxt else ""
                    seg, lit = first_arg_str(val)
                    groups[name_n.text.decode()] = (recv, seg if lit else None)
        if n.type == "invocation_expression":
            fn = n.child_by_field_name("function")
            ftxt = fn.text.decode() if fn is not None else ""
            tail = ftxt.split(".")[-1]
            if tail in MAP_VERBS and "." in ftxt:
                calls.append((ftxt.rsplit(".", 1)[0], tail, n))
        for c in n.children:
            walk(c)

    walk(tree.root_node)

    def prefix_of(var, seen=()):
        if var in roots:
            return "", True
        if var in seen or var not in groups:
            return "", False
        parent, seg = groups[var]
        if seg is None:
            return "", False
        pre, ok = prefix_of(parent, seen + (var,))
        return pre + seg, ok

    for recv, tail, call in calls:
        seg, lit = first_arg_str(call)
        if not lit or seg is None:
            warns.append({"file": rel, "reason": f"non-literal {tail} path"})
            continue
        pre, ok = prefix_of(recv)
        if not ok and recv not in roots:
            if recv in groups:
                warns.append({"file": rel, "reason": "non-literal group prefix"})
            else:
                warns.append({"file": rel, "reason": f"unknown receiver `{recv[:24]}`"})
            continue
        # minimal-API segments ALWAYS nest under their group (a leading "/" is
        # not an absolute override there, unlike attribute routing)
        full = "/" + "/".join(p for p in (pre + "/" + seg).split("/") if p)
        endpoints.append({"file": rel, "method": MAP_VERBS[tail], "path": full or "/"})


def main(root):
    endpoints, warns = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(".cs") and not fn.endswith((".Designer.cs", ".g.cs")):
                p = os.path.join(dirpath, fn)
                scan(os.path.relpath(p, root).replace(os.sep, "/"), open(p, "rb").read(), endpoints, warns)
    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    print(json.dumps({"endpoints": endpoints, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
