#!/usr/bin/env python3
"""config-surface / env-readers provider (keeldocs).

Emits the env-var SURFACE: names and where they are read/declared.
STRUCTURAL VALUE-BLINDNESS (ADR-013): this extractor has no value field in its
output schema and never opens .env - only *.example/*.schema/*.sample key names.

Detected read forms:  process.env.NAME | import.meta.env.NAME | env("NAME") | env('NAME')
Declared forms:       NAME=... lines in .env.example / .env.schema / .env.sample

Output: {"vars":[{"name","read_in_code","declared_in_example","sources":[{file,line,kind}]}]}
Deterministic: sorted by name, sources sorted by (file, line).
"""
import json, os, re, sys

SKIP = {"node_modules", ".git", ".keeldocs", "golden", "docs", "dist", "coverage", "build"}
CODE_EXT = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".prisma")
EXAMPLE = re.compile(r"^\.env\.(example|schema|sample)$")
READS = re.compile(r"(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]*)|\benv\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']\s*\)")
DECL = re.compile(r"^([A-Z][A-Z0-9_]*)\s*=")


def main(root):
    vars_ = {}

    def add(name, file, line, kind):
        v = vars_.setdefault(name, {"name": name, "read_in_code": False,
                                    "declared_in_example": False, "sources": []})
        v["read_in_code"] |= kind == "code"
        v["declared_in_example"] |= kind == "example"
        v["sources"].append({"file": file, "line": line, "kind": kind})

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            if EXAMPLE.match(fn):
                for i, raw in enumerate(open(os.path.join(dirpath, fn), encoding="utf-8", errors="replace")):
                    m = DECL.match(raw.strip())
                    if m:
                        add(m.group(1), rel, i + 1, "example")
            elif fn.endswith(CODE_EXT):
                try:
                    text = open(os.path.join(dirpath, fn), encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                for i, line in enumerate(text.split("\n")):
                    for m in READS.finditer(line):
                        add(m.group(1) or m.group(2), rel, i + 1, "code")

    out = sorted(vars_.values(), key=lambda v: v["name"])
    for v in out:
        v["sources"].sort(key=lambda s: (s["file"], s["line"]))
    print(json.dumps({"vars": out}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
