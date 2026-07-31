#!/usr/bin/env python3
"""keeldocs generic .scm query runtime - the declarative (T0) provider tier
made real (ADR-001; audit item 1). A declarative provider is a provider.yaml
plus one tree-sitter query file: NO per-provider code. This runtime is the
only code, shared by every query provider.

Usage: tsq.py <provider-dir> <repo-root>

The provider.yaml declares: language, query file, file suffixes, and the
emit contract (`emits: [endpoint]` today). The .scm declares WHAT the shapes
are via a NAMED-CAPTURE CONTRACT; the runtime owns the language-agnostic
composition semantics per emit contract. For `endpoint` (decorator-shaped
frameworks - NestJS now, FastAPI/Spring next):

  @scope        the container whose children associate decorators to methods
                (class_body for NestJS); one endpoint group per @scope match
  @prefix.args  arguments node of the container path decorator (optional)
  @verb         identifier node of an HTTP decorator (name mapped via `verbs:`)
  @verb.args    arguments node belonging to that decorator (optional)

Association is positional within @scope, replicating the validated E1
prototype: a run of decorators binds to the next method-shaped sibling;
any other member resets the run. Non-literal path arguments emit
extraction-gap warnings, never guessed paths (constraint 6). Output is
sorted as CONTRACT: endpoints by (file, method, path), warnings by
(file, reason). Deterministic double-run enforced by the harness.
"""
import json
import os
import sys

import yaml
from tree_sitter import Language, Parser, Query, QueryCursor

EXCLUDE_DIRS = {"node_modules", "dist", ".git", ".keeldocs", "golden", "test",
                "tests", "coverage", "build"}


def load_language(name):
    if name in ("typescript", "tsx"):
        import tree_sitter_typescript as tst
        return Language(tst.language_tsx() if name == "tsx" else tst.language_typescript())
    if name == "javascript":
        import tree_sitter_javascript as tsj
        return Language(tsj.language())
    raise SystemExit(f"tsq: unsupported language {name!r}")


def string_text(node):
    for c in node.children:
        if c.type == "string_fragment":
            return c.text.decode()
    return ""  # empty string literal


def decorator_paths(args_node):
    """(paths, literal) from a decorator arguments node - @Get(), @Get(':id'),
    @Controller(['a','b']), @Controller({path: 'x'}). None args = no-arg form."""
    if args_node is None:
        return [""], True
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
                if key is not None and key.text.decode() == "path":
                    if val.type == "string":
                        return [string_text(val)], True
                    if val.type == "array":
                        return [string_text(c) for c in val.children if c.type == "string"], True
                    return [None], False
        return [""], True  # object without path => ''
    return [None], False


def compose(prefix, sub):
    parts = [p for p in (prefix or "").strip("/").split("/") + (sub or "").strip("/").split("/") if p]
    return "/" + "/".join(parts)


def emit_endpoints(cfg, query, parser, files, root):
    verbs = cfg.get("verbs") or {}
    method_nodes = set(cfg.get("member-nodes") or ["method_definition"])
    endpoints, warns = [], []
    for rel in files:
        tree = parser.parse(open(os.path.join(root, rel), "rb").read())
        node_of = {}  # decorator call node id -> (verb ident text, args node)
        scopes = []   # (scope node, prefix args node or None)
        for _pat, caps in QueryCursor(query).matches(tree.root_node):
            if "scope" in caps:
                pref = caps.get("prefix.args")
                scopes.append((caps["scope"][0], pref[0] if pref else None))
            if "verb" in caps:
                verb = caps["verb"][0]
                args = caps.get("verb.args")
                # key by the decorator ancestor so scope-walking can find it
                dec = verb
                while dec is not None and dec.type != "decorator":
                    dec = dec.parent
                if dec is not None:
                    node_of[dec.id] = (verb.text.decode(), args[0] if args else None)
        for scope, prefix_args in sorted(scopes, key=lambda s: s[0].start_byte):
            prefixes, lit = decorator_paths(prefix_args)
            if not lit or prefixes == [None]:
                warns.append({"file": rel, "reason": "non-literal controller path"})
                prefixes = [""]
            pending = []
            for child in scope.children:
                if child.type == "decorator":
                    hit = node_of.get(child.id)
                    if hit is not None:
                        pending.append(hit)
                elif child.type in method_nodes:
                    for verb_name, dec_args in pending:
                        paths, mlit = decorator_paths(dec_args)
                        if not mlit or paths == [None]:
                            warns.append({"file": rel, "reason": f"non-literal @{verb_name} path"})
                            paths = [""]
                        for pre in prefixes:
                            for p in paths:
                                endpoints.append({"file": rel, "method": verbs[verb_name],
                                                  "path": compose(pre, p)})
                    pending = []
                elif child.type not in ("comment", "{", "}", ";"):
                    pending = []
    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    return {"endpoints": endpoints, "warnings": warns}


EMITTERS = {"endpoint": emit_endpoints}


def main(provider_dir, root):
    cfg = yaml.safe_load(open(os.path.join(provider_dir, "provider.yaml")))
    lang = load_language(cfg["language"])
    query = Query(lang, open(os.path.join(provider_dir, cfg["query"])).read())
    parser = Parser(lang)
    suffixes = tuple(cfg.get("files") or [".ts"])
    skip_suffixes = tuple(cfg.get("skip-files") or [])

    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(suffixes) and not (skip_suffixes and fn.endswith(skip_suffixes)):
                files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    files.sort()

    emits = cfg.get("emits") or []
    if len(emits) != 1 or emits[0] not in EMITTERS:
        raise SystemExit(f"tsq: emits must name exactly one of {sorted(EMITTERS)} (got {emits})")
    print(json.dumps(EMITTERS[emits[0]](cfg, query, parser, files, root), indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
