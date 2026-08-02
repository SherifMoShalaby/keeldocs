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
import hashlib, json, os, sys
import tree_sitter_typescript as tst
import tree_sitter_javascript as tsj
from tree_sitter import Language, Parser

TS = Language(tst.language_typescript())
JS = Language(tsj.language())
METHODS = {"get", "post", "put", "patch", "delete", "all"}
SKIP_DIRS = {"node_modules", "dist", ".git", ".keeldocs", "test", "tests",
             "coverage", "public", "views", "migrations"}
# `.keeldocs` is engine-owned cache (fact files, sandbox views). An extractor
# that reads it would report the engine's own scratch space as repository code.

files = {}          # abs -> {"imports": {local: absfile}, "default": nodeid|None}
node_kind = {}      # nodeid -> "app"|"router"
registrations = []  # (nodeid, METHOD, path, relfile)
mounts = []         # (parent_nodeid, prefix, child_ref)  child_ref resolved later
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
        # ONE canonical spelling per file: this key must collide with
        # resolve_import's normpath output on every OS (on Windows the raw
        # walk join is mixed-separator and the mount edges silently miss)
        self.f = os.path.normpath(abspath)
        self.rel = os.path.relpath(abspath, root).replace(os.sep, "/")  # emitted paths are posix on every OS
        self.vars = {}       # local var -> nodeid
        self.imports = {}    # local name -> absfile
        self.default = None  # nodeid or ("file", absfile) alias
        # Anonymous nodes are numbered PER FILE, not per run (D6). The file is
        # already in the id tuple, so per-file numbering is still unique - and
        # it makes the id a function of this file alone, which a global counter
        # never was: the same file scanned after a different number of other
        # files used to get a different id.
        self.anon_ct = 0
        # what this file contributed, so a scan can be cached and replayed
        self.own_kinds = []      # [(nodeid, kind)]
        self.own_regs = []       # [(nodeid, METHOD, path, rel, line)]
        self.own_mounts = []     # [(nodeid, prefix, child_ref)]
        self.own_unresolved = []
        lang = TS if abspath.endswith(".ts") else JS
        tree = Parser(lang).parse(open(abspath, "rb").read())
        self.walk(tree.root_node)
        self.publish()

    def serialize(self, root):
        """This file's whole contribution, or None if any of it escapes the repo.

        Refusing to cache is always available and always safe; a partially
        encoded scan would not be."""
        out = {"default": None, "kinds": [], "regs": [], "mounts": [], "unresolved": self.own_unresolved}
        if self.default is not None:
            e = _enc(self.default, root)
            if e is None:
                return None
            out["default"] = e
        for nid, kind in self.own_kinds:
            e = _enc(nid, root)
            if e is None:
                return None
            out["kinds"].append([e, kind])
        for tgt, meth, path, rel, line in self.own_regs:
            e = _enc(tgt, root)
            if e is None:
                return None
            out["regs"].append([e, meth, path, rel, line])
        for tgt, prefix, child in self.own_mounts:
            a, b = _enc(tgt, root), _enc(child, root)
            if a is None or b is None:
                return None
            out["mounts"].append([a, prefix, b])
        return out

    @classmethod
    def replay(cls, abspath, root, blob):
        """Rebuild a scan from cache and publish it exactly as a fresh one would."""
        self = cls.__new__(cls)
        self.f = os.path.normpath(abspath)
        self.rel = os.path.relpath(abspath, root).replace(os.sep, "/")
        self.vars, self.imports = {}, {}
        self.anon_ct = 0
        self.default = _dec(blob["default"], root)
        self.own_kinds = [(_dec(e, root), k) for e, k in blob["kinds"]]
        self.own_regs = [(_dec(e, root), m, p, r, l) for e, m, p, r, l in blob["regs"]]
        self.own_mounts = [(_dec(a, root), pre, _dec(b, root)) for a, pre, b in blob["mounts"]]
        self.own_unresolved = blob["unresolved"]
        self.publish()
        return self

    def publish(self):
        """Push this file's contribution into the run-wide collections.

        Scanning and publishing are separate so a REPLAYED scan (from the
        engine's per-file cache) lands in exactly the same collections, in the
        same order, as a fresh one. Order is emission order, and emission order
        is contract."""
        for nid, kind in self.own_kinds:
            node_kind[nid] = kind
        registrations.extend(self.own_regs)
        mounts.extend(self.own_mounts)
        unresolved.extend(self.own_unresolved)
        files[self.f] = self

    def new_anon(self, kind):
        self.anon_ct += 1
        nid = (self.f, f"#anon{self.anon_ct}")
        self.own_kinds.append((nid, kind))
        node_kind[nid] = kind   # visible immediately: eval_chain consults it mid-scan
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
                self.own_regs.append((target, prop.upper(), p, self.rel,
                                      call.start_point[0] + 1))
            elif args and args[0].type in ("template_string", "binary_expression", "identifier") and len(args) >= 2:
                self.own_unresolved.append({"file": self.rel, "kind": "non-literal-path",
                                            "text": call.text.decode()[:80]})
        elif prop == "use":
            prefix = sstr(args[0]) if args else None
            rest = args[1:] if prefix is not None else args
            if prefix is None:
                prefix = ""
            for a in rest:
                child = self.value_of(a)
                if child is not None:
                    self.own_mounts.append((target, prefix, child))

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
                        self.own_kinds.append((nid, kind))
                        node_kind[nid] = kind
                        self.vars[name_n.text.decode()] = nid
                        return
                    v = self.eval_chain(val)
                    if v is not None:
                        self.vars[name_n.text.decode()] = v
                        return
                    # const X = require('./mod') - variable-assigned require.
                    # (fixture express-mounts exposed this gap 2026-07-30: eval_chain
                    # handles member chains only, so the binding dropped silently)
                    fn = val.child_by_field_name("function")
                    if fn is not None and fn.type == "identifier" and fn.text.decode() == "require":
                        args = call_args(val)
                        spec = sstr(args[0]) if args else None
                        tgt = resolve_import(self.f, spec) if spec else None
                        if tgt:
                            self.vars[name_n.text.decode()] = ("file", tgt)
                            return
                elif val.type == "identifier":
                    # const alias = existingRouterOrApp
                    v = self.value_of(val)
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


# ---------------------------------------------------------------------------
# D6 per-file scan cache.
#
# A scan is a pure function of (this file's bytes, this file's path, which
# files exist). The first two are obvious; the third is not, and it is the
# reason the cache key carries a path-set digest: `resolve_import` probes the
# filesystem DURING the scan, so adding or removing a file can change what an
# untouched file's imports resolve to. Keying on content alone would serve a
# resolution computed against a tree that no longer exists.
#
# The consequence is stated rather than hidden: an EDIT re-scans one file, and
# an ADD or DELETE re-scans everything. That is the common case optimised and
# the rare case left correct, which is the right way round.
#
# Node ids embed absolute paths, so they are stored repo-RELATIVE and rebuilt
# on load - a cache that only worked at one absolute path would be a cache that
# silently did nothing after a checkout moved.


def _enc(ref, root):
    """nodeid / ('file', abs) / None -> JSON-safe, repo-relative. None if it escapes root."""
    if ref is None:
        return None
    if not isinstance(ref, tuple):
        return None
    def rel_of(p):
        r = os.path.relpath(p, root)
        return None if r.startswith("..") else r.replace(os.sep, "/")
    if ref[0] == "file":
        r = rel_of(ref[1])
        return ["f", r] if r is not None else None
    r = rel_of(ref[0])
    return ["n", r, ref[1]] if r is not None else None


def _dec(enc, root):
    if enc is None:
        return None
    if enc[0] == "f":
        return ("file", os.path.normpath(os.path.join(root, enc[1])))
    return (os.path.normpath(os.path.join(root, enc[1])), enc[2])


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


def load_handoff():
    """The engine's per-file scan cache, if it supplied one.

    Every failure path degrades to a full scan rather than to a wrong answer:
    no env var, missing file, malformed JSON, a digest the engine never
    mentioned. The worst case is slow, never incorrect."""
    path = os.environ.get("KEELDOCS_INCREMENTAL")
    if not path:
        return {}, {}
    try:
        with open(path, encoding="utf-8") as f:
            h = json.load(f)
        if not isinstance(h, dict):
            return {}, {}
        return h.get("parsed") or {}, h.get("digests") or {}
    except Exception:
        return {}, {}


def main(root):
    scan_list = []
    for dirpath, dirnames, fnames in os.walk(root):
        # sorted traversal: raw readdir order is filesystem-dependent, which
        # made emission order differ across checkouts (caught by CI matrix)
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(fnames):
            if f.endswith((".ts", ".js")) and not f.endswith((".d.ts", ".spec.ts", ".test.ts", ".test.js", ".min.js")):
                abspath = os.path.join(dirpath, f)
                scan_list.append((abspath, os.path.relpath(abspath, root).replace(os.sep, "/")))

    known, digests = load_handoff()
    # WHICH FILES EXIST is part of a scan's input, because resolve_import probes
    # the filesystem while scanning. One digest over the scanned set expresses
    # that: an edit leaves it alone, an add or delete invalidates every entry.
    pathset = hashlib.sha256("\n".join(sorted(r for _, r in scan_list)).encode()).hexdigest()[:12]
    fresh = {}
    for abspath, rel in scan_list:
        d = digests.get(rel)
        # the path is in the key, not just the digest: node ids and emitted
        # `file` fields embed it, so two identical files are two different scans
        key = f"{d}|{pathset}:{rel}" if d else None
        blob = known.get(key) if key else None
        if blob is not None:
            FileScan.replay(abspath, root, blob)
            continue
        fs = FileScan(abspath, root)
        if key:
            enc = fs.serialize(root)
            if enc is not None:
                fresh[key] = enc

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
    # emission order is CONTRACT, not traversal accident (golden-compared)
    out.sort(key=lambda e: (e["file"], e["line"], e["method"], e["path"]))
    unresolved.sort(key=lambda w: (w.get("file") or "", w.get("reason") or ""))
    payload = {"endpoints": out, "warnings": unresolved}
    # engine plumbing, stripped before anything sees it as a fact
    if fresh:
        payload["_parsed"] = fresh
    print(json.dumps(payload, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
