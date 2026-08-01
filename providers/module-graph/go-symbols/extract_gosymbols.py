#!/usr/bin/env python3
"""go module-graph + symbols (doc 11 N2 follow-up; py-imports is the template).

- modules: one per PACKAGE DIR (Go's unit); imports resolved dir-to-dir for
  internal packages (spec under the go.mod module path), externals kept as
  specifiers - so fan-in ranks real internal coupling.
- symbols: EXPORTED (capitalized) funcs, methods, and types per FILE, with
  normalized sigs and nameless shapes (ADR-007 / S2 matching aids).
- package identity from the declared ${facts:workspace-layout} read
  (KEELDOCS_FACTS_WORKSPACE_LAYOUT); standalone runs degrade to null.
Deterministic: sorted walks and emission, no clock, no network.
"""
import json, os, re, sys

from tree_sitter import Language, Parser
import tree_sitter_go as tsgo

EXCLUDE = {"vendor", ".git", ".keeldocs", "golden", "node_modules", "testdata"}
lang = Language(tsgo.language())
parser = Parser(lang)


def workspace_packages():
    p = os.environ.get("KEELDOCS_FACTS_WORKSPACE_LAYOUT")
    if not p or not os.path.exists(p):
        return None
    pkgs = []
    for line in open(p, encoding="utf-8"):
        try:
            f = json.loads(line)
            if f.get("payload", {}).get("type") == "package":
                pkgs.append(f["payload"]["attrs"])
        except ValueError:
            continue
    return pkgs or None


def pkg_for(path, pkgs):
    if pkgs is None:
        return None
    best = None
    for a in pkgs:
        if a["path"] == "." or path == a["path"] or path.startswith(a["path"] + "/"):
            if best is None or len(a["path"]) > len(best["path"]):
                best = a
    return best["name"] if best else None


def squish(s):
    return re.sub(r"\s+", " ", s).strip()


def main(root):
    module_path = None
    gm = os.path.join(root, "go.mod")
    if os.path.exists(gm):
        for line in open(gm, encoding="utf-8"):
            if line.startswith("module "):
                module_path = line.split()[1].strip()
                break

    pkgs = workspace_packages()
    dirs = {}     # dir rel -> set of resolved import targets
    symbols = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE and not d.startswith("."))
        for fn in sorted(filenames):
            if not fn.endswith(".go") or fn.endswith("_test.go"):
                continue
            abs_ = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_, root).replace(os.sep, "/")
            rdir = os.path.dirname(rel) or "."
            dirs.setdefault(rdir, set())
            tree = parser.parse(open(abs_, "rb").read())
            for n in tree.root_node.children:
                if n.type == "import_declaration":
                    for lit in (c for c in n.children[1].children if c.type == "import_spec") \
                            if n.child_count > 1 and n.children[1].type == "import_spec_list" \
                            else ([n.children[1]] if n.child_count > 1 and n.children[1].type == "import_spec" else []):
                        pathnode = lit.child_by_field_name("path")
                        if pathnode is None:
                            continue
                        spec = pathnode.text.decode()[1:-1]
                        if module_path and (spec == module_path or spec.startswith(module_path + "/")):
                            tgt = spec[len(module_path):].lstrip("/") or "."
                        else:
                            tgt = spec  # external stays a specifier
                        if tgt != rdir:
                            dirs[rdir].add(tgt)
                if n.type in ("function_declaration", "method_declaration"):
                    name_n = n.child_by_field_name("name")
                    if name_n is None:
                        continue
                    name = name_n.text.decode()
                    if not name[:1].isupper():
                        continue  # exported only (the Go __all__)
                    recv = n.child_by_field_name("receiver")
                    if recv is not None:
                        rt = re.sub(r"[^A-Za-z0-9_]", "", recv.text.decode().split()[-1])
                        name = f"{rt}.{name}"
                    params = n.child_by_field_name("parameters")
                    result = n.child_by_field_name("result")
                    sig = squish(f"func {name}{params.text.decode() if params else '()'}"
                                 + (f" {result.text.decode()}" if result else ""))
                    symbols.append({"path": rel, "name": name, "package": pkg_for(rel, pkgs),
                                    "kind": "function", "sigs": [sig],
                                    "nameless": [sig.replace(f"func {name}", "func §", 1)]})
                if n.type == "type_declaration":
                    for spec in (c for c in n.children if c.type == "type_spec"):
                        name_n = spec.child_by_field_name("name")
                        tnode = spec.child_by_field_name("type")
                        if name_n is None or not name_n.text.decode()[:1].isupper():
                            continue
                        name = name_n.text.decode()
                        shape = tnode.type.replace("_type", "") if tnode is not None else "alias"
                        fields = ""
                        if tnode is not None and tnode.type in ("struct_type", "interface_type"):
                            inner = squish(tnode.text.decode())
                            fields = f" {inner[:120]}"
                        sig = squish(f"type {name} {shape}{fields}")
                        symbols.append({"path": rel, "name": name, "package": pkg_for(rel, pkgs),
                                        "kind": f"type {shape}", "sigs": [sig],
                                        "nameless": [sig.replace(f"type {name} ", "type § ", 1)]})

    modules = [{"path": d, "package": pkg_for(d if d != "." else "", pkgs),
                "imports": [{"specifier": s, "resolved": s} for s in sorted(v)]}
               for d, v in sorted(dirs.items())]
    symbols.sort(key=lambda s: (s["path"], s["name"]))
    print(json.dumps({"modules": modules, "symbols": symbols, "warnings": []}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
