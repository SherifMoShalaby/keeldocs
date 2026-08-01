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
         "PATCH": "PATCH", "HEAD": "HEAD", "OPTIONS": "OPTIONS", "Any": "ALL",
         # chi spells verbs Capitalized
         "Get": "GET", "Post": "POST", "Put": "PUT", "Delete": "DELETE", "Patch": "PATCH"}

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

    def selector(call):
        fn = call.child_by_field_name("function")
        if fn is not None and fn.type == "selector_expression":
            op = fn.child_by_field_name("operand")
            fld = fn.child_by_field_name("field")
            if op is not None and fld is not None:
                return op.text.decode(), fld.text.decode()
        return None, None

    ROOT_MAKERS = {("gin", "Default"), ("gin", "New"), ("echo", "New"),
                   ("chi", "NewRouter"), ("chi", "NewMux")}

    # eager scoped walk: env maps router var -> resolved prefix (None = tainted)
    def walk(n, env):
        if n.type in ("short_var_declaration", "assignment_statement"):
            left = n.child_by_field_name("left")
            right = n.child_by_field_name("right")
            if left is not None and right is not None and right.named_child_count == 1 \
               and left.named_child_count == 1 and left.named_child(0).type == "identifier":
                var = left.named_child(0).text.decode()
                call = right.named_child(0)
                if call.type == "call_expression":
                    op, fld = selector(call)
                    if (op, fld) in ROOT_MAKERS:
                        env[var] = ""
                    elif fld == "Group":
                        seg = lit(first_arg(call))
                        base = env.get(op)
                        env[var] = (base + seg) if (base is not None and seg is not None) else None
        if n.type == "call_expression":
            op, fld = selector(n)
            if fld in VERBS and op is not None:
                seg = lit(first_arg(n))
                # chi capitalizes verbs, but so do unrelated APIs (gin's own
                # c.Get("key")) - Capitalized verbs must LOOK like routes
                # (literal leading-slash) or they are silently not routes
                chi_style = fld in ("Get", "Post", "Put", "Delete", "Patch")
                if chi_style and (seg is None or not seg.startswith("/")):
                    walk_children(n, env)
                    return
                if seg is None:
                    warns.append({"file": rel, "reason": f"non-literal {fld} path"})
                else:
                    base = env.get(op, "__unknown__")
                    if base == "__unknown__":
                        warns.append({"file": rel, "reason": f"cross-file or unknown receiver `{op}`"})
                    elif base is None:
                        warns.append({"file": rel, "reason": "non-literal group prefix"})
                    else:
                        full = "/" + "/".join(x for x in (base + seg).split("/") if x)
                        endpoints.append({"file": rel, "method": VERBS[fld], "path": full or "/"})
            elif fld == "Route" and op is not None:
                # chi idiom: r.Route("/p", func(r chi.Router) { ... }) - the
                # closure PARAM shadows into a nested scope with the composed prefix
                args = n.child_by_field_name("arguments")
                seg = lit(first_arg(n))
                fnlit = None
                if args is not None:
                    for c in args.children:
                        if c.type == "func_literal":
                            fnlit = c
                if fnlit is not None:
                    base = env.get(op)
                    params = fnlit.child_by_field_name("parameters")
                    pname = None
                    if params is not None and params.named_child_count:
                        first = params.named_child(0)
                        nn = first.child_by_field_name("name")
                        pname = nn.text.decode() if nn is not None else None
                    inner = dict(env)
                    if pname is not None:
                        inner[pname] = (base + seg) if (base is not None and seg is not None) else None
                        if seg is None:
                            warns.append({"file": rel, "reason": "non-literal group prefix"})
                    walk_children(fnlit, inner)
                    return  # closure handled with its own scope
        walk_children(n, env)

    def walk_children(n, env):
        for c in n.children:
            walk(c, env)

    walk(tree.root_node, {})


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
