#!/usr/bin/env python3
"""Shared async-messaging scanner (the transport providers' only code).

Each transport provider (kafka, sqs-sns, rabbitmq, redis-pubsub,
supabase-realtime) is a thin script declaring a RULES table and calling
scan(); this module owns the language handling so a new transport costs a
table, not a parser - the same economics the .scm tier gives declarative
endpoint providers.

RULE = (callee_tail, receiver_regex_or_None, kind, role, [arg_specs])
  arg specs, tried in order:
    "pos:N"      Nth positional argument, string literal (or array of them)
    "obj:name"   object-literal property / python kwarg / named argument
    "ann:name"   (java annotations only, handled by the annotation pass)
  a spec value that resolves to a non-literal emits a NAMED GAP, never a guess
  "arn" / "url" suffixes take the last :- or /-separated segment as the name

Deterministic: sorted walks, sorted emission, literal-only, no clock, no
network.
"""
import json, os, re, sys

EXT_LANG = {".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "tsx",
            ".ts": "ts", ".tsx": "tsx", ".py": "py", ".java": "java"}
SKIP = {"node_modules", ".git", ".keeldocs", "golden", "dist", "build",
        "vendor", "__pycache__", ".venv", "venv", "target", "coverage"}

_PARSERS = {}


def parser_for(lang):
    from tree_sitter import Language, Parser
    if lang in _PARSERS:
        return _PARSERS[lang]
    if lang in ("ts",):
        import tree_sitter_typescript as m
        obj = Language(m.language_typescript())
    elif lang == "tsx":
        import tree_sitter_typescript as m
        obj = Language(m.language_tsx())
    elif lang == "js":
        import tree_sitter_javascript as m
        obj = Language(m.language())
    elif lang == "py":
        import tree_sitter_python as m
        obj = Language(m.language())
    elif lang == "java":
        import tree_sitter_java as m
        obj = Language(m.language())
    else:
        raise SystemExit(f"msgscan: unsupported language {lang!r}")
    _PARSERS[lang] = Parser(obj)
    return _PARSERS[lang]


FRAGMENTS = {"string_fragment", "string_content"}


def as_string(node):
    """literal string value, or None when the node is not a plain literal"""
    if node is None:
        return None
    if node.type in ("string", "string_literal", "interpreted_string_literal"):
        parts = [c.text.decode() for c in node.children if c.type in FRAGMENTS]
        if parts:
            return "".join(parts)
        raw = node.text.decode()
        return raw[1:-1] if len(raw) >= 2 else ""
    if node.type == "template_string" and not any(
            c.type == "template_substitution" for c in node.children):
        return "".join(c.text.decode() for c in node.children
                       if c.type not in ("`",))
    return None


def as_pattern(node):
    """A template literal with interpolations declares a channel FAMILY whose
    SHAPE is visible in the source: `ride:${id}` -> "ride:{}". Emitting the
    shape is not a guess (the alternative - resolving the variable - would
    be); it is the same honesty endpoints use when they keep :id verbatim.
    Python f-strings carry the same shape."""
    if node is None:
        return None
    if node.type == "template_string":
        out = []
        for c in node.children:
            if c.type == "`":
                continue
            out.append("{}" if c.type == "template_substitution" else c.text.decode())
        return "".join(out) if any(c.type == "template_substitution" for c in node.children) else None
    if node.type == "string" and any(c.type == "interpolation" for c in node.children):
        out = []
        for c in node.children:
            if c.type in ("string_start", "string_end"):
                continue
            out.append("{}" if c.type == "interpolation" else c.text.decode())
        return "".join(out)
    return None


def as_strings(node):
    """([(value, is_pattern)], resolvable?) - a string/template, or an array of them"""
    s = as_string(node)
    if s is not None:
        return [(s, False)], True
    p = as_pattern(node)
    if p is not None:
        return [(p, True)], True
    if node is not None and node.type in ("array", "list"):
        out, lit = [], True
        for c in node.named_children:
            v = as_string(c)
            if v is not None:
                out.append((v, False))
                continue
            vp = as_pattern(c)
            if vp is not None:
                out.append((vp, True))
            else:
                lit = False
        return out, lit
    return [], False


def call_parts(node):
    """(receiver_text, callee_tail, args_node) for a call in any language"""
    if node.type in ("call_expression", "call"):
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments")
        if fn is None:
            return None, None, None
        txt = fn.text.decode()
        tail = txt.split(".")[-1].split("(")[0]
        recv = txt.rsplit(".", 1)[0] if "." in txt else ""
        return recv, tail, args
    if node.type == "new_expression":  # js/ts: new SendMessageCommand({...})
        ctor = node.child_by_field_name("constructor")
        args = node.child_by_field_name("arguments")
        if ctor is None:
            return None, None, None
        txt = ctor.text.decode()
        return (txt.rsplit(".", 1)[0] if "." in txt else ""), txt.split(".")[-1], args
    if node.type == "object_creation_expression":  # java: new X(...)
        t = node.child_by_field_name("type")
        args = node.child_by_field_name("arguments")
        if t is None:
            return None, None, None
        return "", t.text.decode().split(".")[-1], args
    if node.type == "method_invocation":  # java
        obj = node.child_by_field_name("object")
        name = node.child_by_field_name("name")
        args = node.child_by_field_name("arguments")
        if name is None:
            return None, None, None
        return (obj.text.decode() if obj is not None else ""), name.text.decode(), args
    return None, None, None


def positional(args, n):
    if args is None:
        return None
    pos = [c for c in args.named_children
           if c.type not in ("keyword_argument", "comment")]
    return pos[n] if len(pos) > n else None


def named_value(args, key):
    """object-literal property (JS), kwarg (python), or named annotation arg"""
    if args is None:
        return None
    for c in args.named_children:
        if c.type == "keyword_argument":  # python
            n = c.child_by_field_name("name")
            if n is not None and n.text.decode() == key:
                return c.child_by_field_name("value")
        if c.type in ("object",):  # js/ts object literal
            for p in c.named_children:
                if p.type == "pair":
                    k = p.child_by_field_name("key")
                    if k is not None and k.text.decode().strip("\"'") == key:
                        return p.child_by_field_name("value")
    return None


def resolve(args, specs):
    """(names, literal?) for the first spec that MATCHES a present argument"""
    for spec in specs:
        kind, _, arg = spec.partition(":")
        node = positional(args, int(arg)) if kind == "pos" else named_value(args, arg)
        if node is None:
            continue
        vals, lit = as_strings(node)
        return vals, lit
    return None, True  # absent entirely: not this rule's call


def tail_segment(name):
    return re.split(r"[:/]", name)[-1] if name else name


def scan(root, rules, annotations=(), provider_exts=None):
    """rules: RULE tuples; annotations: (annotation_name, arg_key, kind, role)"""
    found, warns = [], []
    exts = provider_exts or tuple(EXT_LANG)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1]
            if ext not in EXT_LANG or ext not in exts:
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
            src = open(os.path.join(dirpath, fn), "rb").read()
            if not any(k.encode() in src for k, *_ in [(r[0],) for r in rules] +
                       [(a[0],) for a in annotations]):
                continue  # cheap prefilter: no rule keyword in the file at all
            tree = parser_for(EXT_LANG[ext]).parse(src)

            def visit(n):
                recv, tail, args = call_parts(n)
                if tail is not None:
                    for rtail, rrecv, kind, role, specs in rules:
                        if tail != rtail:
                            continue
                        if rrecv and not re.search(rrecv, recv or "", re.I):
                            continue
                        names, lit = resolve(args, specs)
                        if names is None:
                            continue
                        if not lit or not names:
                            warns.append({"file": rel,
                                          "reason": f"non-literal {kind} name in {tail}()"})
                            break
                        for nm, is_pat in names:
                            short = (tail_segment(nm) if kind in ("queue", "topic")
                                     and not is_pat and re.search(r"[:/]", nm) else nm)
                            found.append({"file": rel, "kind": kind, "role": role,
                                          "name": short, "pattern": is_pat})
                        break
                if n.type in ("annotation", "marker_annotation"):  # java
                    nm = n.child_by_field_name("name")
                    if nm is not None:
                        aname = nm.text.decode()
                        for ann, key, kind, role in annotations:
                            if aname != ann:
                                continue
                            args_n = next((c for c in n.children
                                           if c.type == "annotation_argument_list"), None)
                            node = None
                            if args_n is not None:
                                for c in args_n.named_children:
                                    if c.type == "element_value_pair":
                                        k = c.child_by_field_name("key")
                                        if k is not None and k.text.decode() == key:
                                            node = c.child_by_field_name("value")
                                    elif node is None and c.type in ("string_literal",):
                                        node = c
                            vals, lit = as_strings(node) if node is not None else ([], False)
                            if not lit or not vals:
                                warns.append({"file": rel,
                                              "reason": f"non-literal {kind} name in @{ann}"})
                            for v, is_pat in vals:
                                found.append({"file": rel, "kind": kind, "role": role,
                                              "name": v, "pattern": is_pat})
                for c in n.children:
                    visit(c)

            visit(tree.root_node)
    return found, warns


def emit(root, transport, rules, annotations=(), exts=None):
    found, warns = scan(root, rules, annotations, exts)
    merged = {}
    for f in found:
        key = (f["kind"], f["name"])
        e = merged.setdefault(key, {"name": f["name"], "kind": f["kind"],
                                    "transport": transport, "roles": set(), "files": set(),
                                    "pattern": bool(f.get("pattern"))})
        e["roles"].add(f["role"])
        e["files"].add(f["file"])
    out = []
    for (_k, _n), e in sorted(merged.items()):
        roles = sorted(e["roles"])
        out.append({"name": e["name"], "kind": e["kind"], "transport": transport,
                    "role": "both" if len(roles) > 1 else roles[0],
                    "pattern": e["pattern"], "files": sorted(e["files"])})
    seen = set()
    uniq_warns = []
    for w in sorted(warns, key=lambda w: (w["file"], w["reason"])):
        k = (w["file"], w["reason"])
        if k not in seen:
            seen.add(k)
            uniq_warns.append(w)
    print(json.dumps({"channels": out, "warnings": uniq_warns}, indent=1))
