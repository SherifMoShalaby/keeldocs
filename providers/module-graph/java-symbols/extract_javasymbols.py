#!/usr/bin/env python3
"""java module-graph + symbols (doc 11 N2 follow-up; py-imports template).

- modules: one per PACKAGE DIR; imports resolve INTERNALLY when the imported
  package is declared by some file in the repo (dir-to-dir edges, so fan-in
  ranks real coupling); externals keep their specifier.
- symbols: public/protected classes, interfaces, enums, and methods per FILE,
  with normalized sigs + nameless shapes (ADR-007 / S2 matching aids).
  Methods are named Class.method; test files are skipped.
Deterministic: sorted walks and emission, no clock, no network.
"""
import json, os, re, sys

from tree_sitter import Language, Parser
import tree_sitter_java as tsjava

EXCLUDE = {"target", "build", ".git", ".keeldocs", "golden", "node_modules", "vendor"}
lang = Language(tsjava.language())
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


def visible(node):
    mods = next((c for c in node.children if c.type == "modifiers"), None)
    if mods is None:
        return False  # package-private: not public surface
    t = mods.text.decode()
    return "public" in t or "protected" in t


def main(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(".java") and not (fn.endswith("Test.java") or fn.endswith("Tests.java")):
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                files.append(rel)

    parsed = {}       # rel -> tree
    decl_pkg = {}     # rel -> declared java package
    pkg_dir = {}      # java package -> dir rel (first seen, sorted order)
    for rel in files:
        tree = parser.parse(open(os.path.join(root, rel), "rb").read())
        parsed[rel] = tree
        for n in tree.root_node.children:
            if n.type == "package_declaration":
                jpkg = squish(n.text.decode())[len("package"):].strip(" ;")
                decl_pkg[rel] = jpkg
                pkg_dir.setdefault(jpkg, os.path.dirname(rel) or ".")
                break

    pkgs = workspace_packages()
    dirs = {}         # dir rel -> set of resolved targets
    symbols = []

    def add_symbol(rel, name, kind, sig):
        symbols.append({"path": rel, "name": name, "package": pkg_for(rel, pkgs),
                        "kind": kind, "sigs": [sig],
                        "nameless": [sig.replace(name, "§", 1)]})

    for rel in files:
        rdir = os.path.dirname(rel) or "."
        dirs.setdefault(rdir, set())
        for n in parsed[rel].root_node.children:
            if n.type == "import_declaration":
                spec = squish(n.text.decode())[len("import"):].strip(" ;")
                spec = re.sub(r"^static\s+", "", spec)
                base = spec[:-2] if spec.endswith(".*") else spec.rsplit(".", 1)[0]
                tgt = pkg_dir.get(base)
                if tgt is not None and tgt != rdir:
                    dirs[rdir].add(tgt)
                elif tgt is None:
                    dirs[rdir].add(spec)  # external specifier, kept honest
            if n.type in ("class_declaration", "interface_declaration", "enum_declaration"):
                name_n = n.child_by_field_name("name")
                if name_n is None or not visible(n):
                    continue
                cls = name_n.text.decode()
                kind = n.type.replace("_declaration", "")
                add_symbol(rel, cls, kind, f"{kind} {cls}")
                body = n.child_by_field_name("body")
                for m in (body.children if body is not None else []):
                    if m.type == "method_declaration" and visible(m):
                        mn = m.child_by_field_name("name").text.decode()
                        params = m.child_by_field_name("parameters")
                        rtype = m.child_by_field_name("type")
                        sig = squish(f"{rtype.text.decode() if rtype else 'void'} {cls}.{mn}"
                                     f"{params.text.decode() if params else '()'}")
                        add_symbol(rel, f"{cls}.{mn}", "function method", sig)

    modules = [{"path": d, "package": pkg_for(d, pkgs),
                "imports": [{"specifier": s, "resolved": s} for s in sorted(v)]}
               for d, v in sorted(dirs.items())]
    symbols.sort(key=lambda s: (s["path"], s["name"]))
    print(json.dumps({"modules": modules, "symbols": symbols, "warnings": []}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
