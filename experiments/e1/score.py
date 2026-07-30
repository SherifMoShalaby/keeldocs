#!/usr/bin/env python3
"""Score extracted endpoints vs ground truth on (repo, file, method, normalized path)."""
import json, re, sys


def norm(path):
    p = "/" + path.strip().strip("/")
    p = re.sub(r"//+", "/", p)
    p = re.sub(r"\{([^}]+)\}", r"{p}", p)      # {id} -> {p}
    p = re.sub(r":(\w+)", r"{p}", p)           # :id  -> {p}
    return p if p != "" else "/"


def key(repo, e):
    return (repo, e["file"].replace("\\", "/"), e["method"].upper(), norm(e["path"]))


def score(truth_entries, extracted_by_repo, scope=None):
    tset = {key(t["repo"], t) for t in truth_entries}
    eset = set()
    edetail = {}
    for repo, ends in extracted_by_repo.items():
        for e in ends:
            if scope and not scope(repo, e):
                continue
            k = key(repo, e)
            eset.add(k)
            edetail[k] = e
    tp = tset & eset
    misses = sorted(tset - eset)
    fps = sorted(eset - tset)
    return {
        "truth": len(tset), "extracted": len(eset), "tp": len(tp),
        "recall": round(len(tp) / len(tset), 4) if tset else None,
        "precision": round(len(tp) / len(eset), 4) if eset else None,
        "misses": [list(m) for m in misses],
        "false_positives": [list(f) for f in fps],
    }


if __name__ == "__main__":
    cfg = json.load(open(sys.argv[1]))
    truth = json.load(open(cfg["truth"]))["endpoints"]
    ext = {}
    for repo, f in cfg["extracted"].items():
        ext[repo] = json.load(open(f))["endpoints"]
    scope = None
    if "line_scope" in cfg:
        ls = cfg["line_scope"]  # {repo: {file: [lo, hi]}}

        def scope(repo, e):
            rules = ls.get(repo)
            if not rules:
                return True
            rng = rules.get(e["file"])
            if not rng:
                return True
            return "line" not in e or (rng[0] <= e["line"] <= rng[1])
    print(json.dumps(score(truth, ext, scope), indent=1))
