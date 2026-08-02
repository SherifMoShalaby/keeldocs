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

SKIP = {"node_modules", ".git", ".keeldocs", "golden", "docs", "dist", "coverage", "build",
        "__pycache__", ".venv", "venv"}
CODE_EXT = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".prisma", ".py", ".go", ".java", ".dart")
EXAMPLE = re.compile(r"^\.env\.(example|schema|sample)$")
# JS + Python + Go (os.Getenv/LookupEnv) + Java (System.getenv) read forms;
# value-blindness holds: only the NAME is ever captured
READS = re.compile(
    r"(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]*)"
    r"|\benv\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']\s*\)"
    r"|os\.environ(?:\.get)?\s*[\[\(]\s*[\"']([A-Z][A-Z0-9_]*)[\"']"
    r"|os\.getenv\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']"
    r"|os\.(?:Getenv|LookupEnv)\(\s*\"([A-Z][A-Z0-9_]*)\""
    r"|System\.getenv\(\s*\"([A-Z][A-Z0-9_]*)\""
    r"|String\.fromEnvironment\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']"
    r"|Platform\.environment\[\s*[\"']([A-Z][A-Z0-9_]*)[\"']")
DECL = re.compile(r"^([A-Z][A-Z0-9_]*)\s*=")


def scan_example(path):
    """[(name, line)] declared in a .env.example-style file. Path-free."""
    found = []
    for i, raw in enumerate(open(path, encoding="utf-8", errors="replace")):
        m = DECL.match(raw.strip())
        if m:
            found.append([m.group(1), i + 1])
    return found


def scan_code(path):
    """[(name, line)] read from source. Path-free."""
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    found = []
    for i, line in enumerate(text.split("\n")):
        for m in READS.finditer(line):
            found.append([next(g for g in m.groups() if g), i + 1])
    return found


def load_handoff():
    """The engine's per-file scan cache, if it supplied one (D9).

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
    vars_ = {}

    def add(name, file, line, kind):
        v = vars_.setdefault(name, {"name": name, "read_in_code": False,
                                    "declared_in_example": False, "sources": []})
        v["read_in_code"] |= kind == "code"
        v["declared_in_example"] |= kind == "example"
        v["sources"].append({"file": file, "line": line, "kind": kind})

    known, digests = load_handoff()
    fresh = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            # The FILENAME decides which scanner runs, so it is part of the key:
            # a `.env.example` and a `.ts` file with identical bytes are two
            # completely different scans. Nothing else here depends on anything
            # outside this file - no filesystem probing, no cross-file
            # resolution, no run-wide counters - so content plus branch is the
            # whole of it, and the stored findings are path-free.
            kind = "example" if EXAMPLE.match(fn) else "code" if fn.endswith(CODE_EXT) else None
            if kind is None:
                continue
            d = digests.get(rel)
            key = f"{d}|{kind}" if d else None
            found = known.get(key) if key else None
            if found is not None and not all(
                    isinstance(x, list) and len(x) == 2 for x in found):
                found = None   # unreadable entry -> scan it again, never crash
            if found is None:
                found = scan_example(full) if kind == "example" else scan_code(full)
                if found is None:      # unreadable: a real state, not a cacheable one
                    continue
                if key:
                    fresh[key] = found
            for name, line in found:
                add(name, rel, line, kind)

    out = sorted(vars_.values(), key=lambda v: v["name"])
    for v in out:
        v["sources"].sort(key=lambda s: (s["file"], s["line"]))
    payload = {"vars": out}
    # engine plumbing, stripped before anything sees it as a fact
    if fresh:
        payload["_parsed"] = fresh
    print(json.dumps(payload, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
