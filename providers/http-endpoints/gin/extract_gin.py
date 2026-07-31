#!/usr/bin/env python3
"""gin endpoint extractor (doc 11 N2, probe-first: code tier).

Per-file resolution of gin's idiomatic registration shape:
    r := gin.Default()                  # root (any gin.New/Default call)
    api := r.Group("/api")              # group chains, recursively
    v1 := api.Group("/v1")
    v1.GET("/tags", handler)            # -> GET /api/v1/tags

Rules (the E1/E6 lesson applied to Go):
- literal paths only; a non-literal Group or route path emits an
  extraction-gap and is never guessed
- group variables resolve within their FILE (gin idiom keeps registration
  local); a route on an unknown receiver variable is emitted with its own
  path only if the receiver is a known root, otherwise it emits a
  cross-file-group gap - honest partiality over invented prefixes
- gofmt guarantees no gin route split across weird shapes; still, only
  call_expression forms are read
Deterministic: sorted walks, sorted emission, no clock, no network.
"""
import json, os, sys

from tree_sitter import Language, Parser
import tree_sitter_go as tsgo

EXCLUDE_DIRS = {"vendor", ".git", ".keeldocs", "golden", "node_modules", "testdata"}
VERBS = {"GET": "GET", "POST": "POST", "PUT": "PUT", "DELETE": "DELETE",
         "PATCH": "PATCH", "HEAD": "HEAD", "OPTIONS": "OPTIONS", "Any": "ALL"}

lang = Language(tsgo.language())
parser = Parser(lang)


def lit(node):
    if node is not None and node.type == "interpreted_string_literal":
        return node.text.decode()[1:-1]
    return None


def first_arg(call):
    args = call.child_by_field_name("arguments")
    if args is None or args.named_child_count == 0:
        return None
    return args.named_child(0)


def scan_file(rel, src, endpoints, warns):
    tree = parser.parse(src)
    roots = set()    # vars holding gin.Default()/gin.New() engines
    groups = {}      # var -> (parent var, literal prefix or None)
    calls = []       # (receiver var, verb, path node)

    def selector(call):
        fn = call.child_by_field_name("function")
        if fn is not None and fn.type == "selector_expression":
            op = fn.child_by_field_name("operand")
            fld = fn.child_by_field_name("field")
            if op is not None and fld is not None:
                return op.text.decode(), fld.text.decode()
        return None, None

    def walk(n):
        if n.type in ("short_var_declaration", "assignment_statement"):
            left = n.child_by_field_name("left")
            right = n.child_by_field_name("right")
            if left is not None and right is not None and right.named_child_count == 1 \
               and left.named_child_count == 1 and left.named_child(0).type == "identifier":
                var = left.named_child(0).text.decode()
                call = right.named_child(0)
                if call.type == "call_expression":
                    op, fld = selector(call)
                    if fld in ("Default", "New") and op == "gin":
                        roots.add(var)
                    elif fld == "Group":
                        groups[var] = (op, lit(first_arg(call)))
        if n.type == "call_expression":
            op, fld = selector(n)
            if fld in VERBS and op is not None:
                calls.append((op, fld, first_arg(n)))
        for c in n.children:
            walk(c)

    walk(tree.root_node)

    def prefix_of(var, seen=()):
        """(prefix, resolved?) - walk the group chain to a root."""
        if var in roots:
            return "", True
        if var in seen or var not in groups:
            return "", False
        parent, p = groups[var]
        if p is None:
            return "", False  # non-literal group path taints the chain
        pre, ok = prefix_of(parent, seen + (var,))
        return pre + p, ok

    for var, verb, pnode in calls:
        path = lit(pnode)
        if path is None:
            warns.append({"file": rel, "reason": f"non-literal {verb} path"})
            continue
        pre, ok = prefix_of(var)
        if not ok and var not in roots:
            if var in groups:
                warns.append({"file": rel, "reason": "non-literal group prefix"})
                continue
            warns.append({"file": rel, "reason": f"cross-file or unknown receiver `{var}`"})
            continue
        full = "/" + "/".join(x for x in (pre + path).split("/") if x)
        endpoints.append({"file": rel, "method": VERBS[verb], "path": full or "/"})


def main(root):
    endpoints, warns = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(".go") and not fn.endswith("_test.go"):
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, root).replace(os.sep, "/")
                scan_file(rel, open(p, "rb").read(), endpoints, warns)
    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    print(json.dumps({"endpoints": endpoints, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
