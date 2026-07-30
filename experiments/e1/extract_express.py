#!/usr/bin/env python3
"""Express endpoint extractor — CODE tier.

Resolves:
- const app = express(); const r = Router()/express.Router()
- direct registrations  X.get|post|put|patch|delete|all('/p', ...>=2 args)
- mounts X.use('/prefix', Y) and X.use(Y)  (Y: local var, imported default, require())
- chained builders  Router().use(a).use('/p', b)  (Express returns self)
- export default R / module.exports = R, followed across files (relative imports)
Emits full path = mount-prefix chain + registered path.
"""
import json, os, sys
import tree_sitter_typescript as tst
import tree_sitter_javascript as tsj
from tree_sitter import Language, Parser

TS = Language(tst.language_typescript())
JS = Language(tsj.language())
METHODS = {"get", "post", "put", "patch", "delete", "all"}
SKIP_DIRS = {"node_modules", "dist", ".git", "test", "tests", "coverage", "public", "views", "migrations"}

files = {}          # abs -> {"imports": {local: absfile}, "default": nodeid|None}
node_kind = {}      # nodeid -> "app"|"router"
registrations = []  # (nodeid, METHOD, path, relfile)
mounts = []         # (parent_nodeid, prefix, child_ref)  child_ref resolved later
anon_ct = 0
unresolved = []


def resolve_import(from_file, spec):
    if not spec.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    for cand in (base, base + ".ts", base + ".js",
                 os.path.join(base, "index.ts"), os.path.join(base, "index.js")):
        if os.path.isfile(cand):
            return cand
    return None


def sstr(n):
    if n.type == "string":
        for c in n.children:
            if c.type == "string_fragment":
                return c.text.decode()
        return ""
    return None


def call_args(call):
    a = call.child_by_field_name("arguments")
    if a is None:
        return []
    return [c for c in a.children if c.type not in ("(", ")", ",", "comment")]


def is_creator(call):
    """call_expression that creates app/router -> kind or None"""
    fn = call.child_by_field_name("function")
    if fn is None:
        return None
    t = fn.text.decode()
    if t == "express":
        return "app"
    if t in ("Router", "express.Router"):
        return "router"
    return None


class FileScan:
    def __init__(self, abspath, root):
        global anon_ct
        self.f = abspath
        self.rel = os.path.relpath(abspath, root)
        self.vars = {}       # local var -> nodeid
        self.imports = {}    # local name -> absfile
        self.default = None  # nodeid or ("file", absfile) alias
        lang = TS if abspath.endswith(".ts") else JS
        tree = Parser(lang).parse(open(abspath, "rb").read())
        self.walk(tree.root_node)
        files[abspath] = self

    def new_anon(self, kind):
        global anon_ct
        anon_ct += 1
        nid = (self.f, f"#anon{anon_ct}")
        node_kind[nid] = kind
        return nid

    def value_of(self, n):
        """resolve an expression to a nodeid / ('file', abs) alias / None"""
        if n.type == "identifier":
            name = n.text.decode()
            if name in self.vars:
                return self.vars[name]
            if name in self.imports:
                return ("file", self.imports[name])
            return None
        if n.type == "call_expression":
            fn = n.child_by_field_name("function")
            if fn is not None and fn.type == "identifier" and fn.text.decode() == "require":
                args = call_args(n)
                spec = sstr(args[0]) if args else None
                tgt = resolve_import(self.f, spec) if spec else None
                return ("file", tgt) if tgt else None
            return self.eval_chain(n)
        return None

    def eval_chain(self, call):
        """evaluate a call chain; returns nodeid if it builds/extends a router/app"""
        kind = is_creator(call)
        if kind:
            return self.new_anon(kind)
        fn = call.child_by_field_name("function")
        if fn is not None and fn.type == "member_expression":
            obj = fn.child_by_field_name("object")
            prop = fn.child_by_field_name("property").text.decode()
            base = None
            if obj.type == "call_expression":
                base = self.eval_chain(obj)
            elif obj.type == "identifier":
                base = self.value_of(obj)
            if base is not None:
                self.record_member_call(base, prop, call)
                return base  # express chaining returns self
        return None

    def record_member_call(self, target, prop, call):
        args = call_args(call)
        if prop in METHODS:
            p = sstr(args[0]) if args else None
            if p is not None and len(args) >= 2:
                registrations.append((target, prop.upper(), p, self.rel,
                                      call.start_point[0] + 1))
            elif args and args[0].type in ("template_string", "binary_expression", "identifier") and len(args) >= 2:
                unresolved.append({"file": self.rel, "kind": "non-literal-path",
                                   "text": call.text.decode()[:80]})
        elif prop == "use":
            prefix = sstr(args[0]) if args else None
            rest = args[1:] if prefix is not None else args
            if prefix is None:
                prefix = ""
            for a in rest:
                child = self.value_of(a)
                if child is not None:
                    mounts.append((target, prefix, child))

    def walk(self, n):
        t = n.type
        if t == "variable_declarator":
            name_n = n.child_by_field_name("name")
            val = n.child_by_field_name("value")
            if name_n is not None and val is not None and name_n.type == "identifier":
                if val.type == "call_expression":
                    kind = is_creator(val)
                    if kind:
                        nid = (self.f, name_n.text.decode())
                        node_kind[nid] = kind
                        self.vars[name_n.text.decode()] = nid
                        return
                    v = self.eval_chain(val)
                    if v is not None:
                        self.vars[name_n.text.decode()] = v
                        return
        elif t == "import_statement":
            src = n.child_by_field_name("source")
            tgt = resolve_import(self.f, sstr(src)) if src is not None else None
            if tgt:
                clause = next((c for c in n.children if c.type == "import_clause"), None)
                if clause is not None:
                    for c in clause.children:
                        if c.type == "identifier":         # default import
                            self.imports[c.text.decode()] = tgt
            return
        elif t == "export_statement":
            # export default X
            for c in n.children:
                if c.type in ("identifier", "call_expression"):
                    v = self.value_of(c)
                    if v is not None:
                        self.default = v
            # fallthrough to walk children (export default Router().use(...) handled by value_of)
            if self.default is not None:
                return
        elif t == "expression_statement":
            expr = n.children[0] if n.children else None
            if expr is not None and expr.type == "call_expression":
                self.eval_chain(expr)
                return
            if expr is not None and expr.type == "assignment_expression":
                l = expr.child_by_field_name("left")
                r = expr.child_by_field_name("right")
                if l is not None and l.text.decode() in ("module.exports", "exports.default") and r is not None:
                    v = self.value_of(r)
                    if v is not None:
                        self.default = v
                        return
        for c in n.children:
            self.walk(c)


def resolve_ref(ref, seen=None):
    """('file', abs) alias -> that file's default-export nodeid"""
    seen = seen or set()
    while isinstance(ref, tuple) and ref[0] == "file":
        if ref in seen:
            return None
        seen.add(ref)
        fs = files.get(ref[1])
        ref = fs.default if fs else None
    return ref


def main(root):
    for dirpath, dirnames, fnames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in fnames:
            if f.endswith((".ts", ".js")) and not f.endswith((".d.ts", ".spec.ts", ".test.ts", ".test.js", ".min.js")):
                FileScan(os.path.join(dirpath, f), root)

    # build mount graph
    children = {}   # nodeid -> [(prefix, child nodeid)]
    mounted = set()
    for parent, prefix, child in mounts:
        c = resolve_ref(child)
        if c is None or c not in node_kind:
            continue
        children.setdefault(parent, []).append((prefix, c))
        mounted.add(c)

    # prefixes via BFS from roots (apps + unmounted routers)
    prefixes = {}   # nodeid -> set of full prefixes
    roots = [n for n, k in node_kind.items() if k == "app" or n not in mounted]
    work = [(r, "") for r in roots]
    guard = 0
    while work and guard < 10000:
        guard += 1
        node, pre = work.pop()
        if pre in prefixes.setdefault(node, set()):
            continue
        prefixes[node].add(pre)
        for cp, child in children.get(node, []):
            work.append((child, (pre.rstrip("/") + "/" + cp.strip("/")).rstrip("/")))

    out = []
    for target, meth, path, rel, line in registrations:
        t = resolve_ref(target)
        if t is None:
            continue
        for pre in sorted(prefixes.get(t, {""})):
            full = (pre.rstrip("/") + "/" + path.lstrip("/")).rstrip("/") or "/"
            out.append({"file": rel, "method": meth, "path": full, "line": line})
    print(json.dumps({"endpoints": out, "warnings": unresolved}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
