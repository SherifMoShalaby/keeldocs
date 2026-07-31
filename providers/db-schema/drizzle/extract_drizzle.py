#!/usr/bin/env python3
"""drizzle snapshot extractor (doc 11 N1).

Reads drizzle-kit's committed migration state - meta/_journal.json + the
LATEST NNNN_snapshot.json (schema state after the whole chain, replay
semantics for free) - and emits the prisma-normalizer shape {models, enums}.
Type spellings stay drizzle-verbatim ("serial", "varchar(120)"): honesty
about the source is what makes prisma-vs-drizzle a REAL resolver conflict
instead of a silently-normalized coincidence.

Deterministic: sorted walks, sorted emission, no clock, no network.
"""
import json, os, sys

SKIP = {"node_modules", ".git", "dist", ".keeldocs", "golden", "coverage", "__pycache__"}


def find_meta_dirs(root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        if os.path.basename(dirpath) == "meta" and "_journal.json" in filenames:
            hits.append(dirpath)
    return sorted(hits)


def main(root):
    warnings = []
    metas = find_meta_dirs(root)
    if not metas:
        print(json.dumps({"models": [], "enums": [], "warnings": []}))
        return
    for ignored in metas[1:]:
        warnings.append({"kind": "chain-ignored",
                         "file": os.path.relpath(ignored, root).replace(os.sep, "/")})
    meta = metas[0]
    try:
        journal = json.load(open(os.path.join(meta, "_journal.json"), encoding="utf-8"))
        idx = max(e["idx"] for e in journal["entries"])
        snap_path = os.path.join(meta, "%04d_snapshot.json" % idx)
        snap = json.load(open(snap_path, encoding="utf-8"))
    except (OSError, ValueError, KeyError) as e:
        warnings.append({"kind": "snapshot-unreadable",
                         "file": os.path.relpath(meta, root).replace(os.sep, "/")})
        print(json.dumps({"models": [], "enums": [], "warnings": warnings}))
        return

    enums = [{"name": v["name"], "values": v.get("values", [])}
             for v in snap.get("enums", {}).values()]
    enums.sort(key=lambda e: e["name"])
    enum_names = {e["name"] for e in enums}

    models = []
    for t in snap.get("tables", {}).values():
        fields = []
        for c in t.get("columns", {}).values():
            attrs = []
            if c.get("primaryKey"):
                attrs.append("primary key")
            if c.get("default") is not None:
                attrs.append("default %s" % c["default"])
            fields.append({
                "name": c["name"], "type": c["type"],
                "optional": not c.get("notNull", False), "list": False,
                "is_relation_field": c["type"] in enum_names,  # enum cross-check path
                "attrs": " ".join(attrs),
            })
        for fk in sorted(t.get("foreignKeys", {}).values(), key=lambda f: f["name"]):
            fields.append({
                # prisma-style: the relation OBJECT field is distinct from the
                # scalar FK column(s); name it after the target, deterministic
                "name": fk.get("tableTo", "").lower() or fk["name"],
                "type": fk.get("tableTo", ""),
                "is_relation_field": True,
                "relation": {"fields": fk.get("columnsFrom", []),
                             "references": fk.get("columnsTo", [])},
            })
        models.append({"name": t["name"], "fields": fields})
    models.sort(key=lambda m: m["name"])

    print(json.dumps({"models": models, "enums": enums, "warnings": warnings}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
