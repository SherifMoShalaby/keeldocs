#!/usr/bin/env python3
"""db-schema / tbls-live provider (keeldocs) - live Postgres via tbls, wrapped
not rebuilt (design non-goal 4). OPT-IN ONLY: the engine runs this provider
solely under `--live`, never in default or CI checks - network must not enter
the pure-function path.

Credential discipline (ADR-013):
- The DSN arrives as KEELDOCS_DSN (the engine resolves the user's env-NAMED
  variable from keeldocs.toml [live] dsn-env) and is passed to tbls via the
  TBLS_DSN environment variable - NEVER argv (process listings), NEVER stdout,
  NEVER provenance. This wrapper cannot print it: it never reads it into any
  output structure.
- Catalog only: `tbls out -t json` reads information_schema/pg_catalog; no row
  data exists in tbls's output format.

Test seam: KEELDOCS_TBLS_JSON points at a canned tbls schema.json; the
normalization below is IDENTICAL for canned and live input, so the harness
exercises the full path deterministically with no database and no network.

Output: {"tables":[{name "<schema>.<table>", schema, table, columns:[{name,
type, nullable, default, comment}], relations:[{field, target}], comment}],
"source": "canned"|"live"} - tables/relations sorted; column order preserved
(ordinal order is semantic, ADR-008).
"""
import json
import os
import subprocess
import sys


def load_schema():
    canned = os.environ.get("KEELDOCS_TBLS_JSON")
    if canned:
        return json.load(open(canned, encoding="utf-8")), "canned"
    dsn = os.environ.get("KEELDOCS_DSN")
    if not dsn:
        raise SystemExit("tbls-live: KEELDOCS_DSN not set (engine resolves [live] dsn-env)")
    r = subprocess.run(["tbls", "out", "-t", "json"],
                       env={**os.environ, "TBLS_DSN": dsn},
                       capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        # stderr may embed the DSN in tbls's own error - keep only the first line, scrubbed
        first = (r.stderr or "tbls failed").split("\n")[0]
        scrubbed = first.replace(dsn, "<dsn>")
        raise SystemExit(f"tbls-live: tbls exited {r.returncode}: {scrubbed[:160]}")
    return json.loads(r.stdout), "live"


def main(_root):
    doc, source = load_schema()
    rels_by_child = {}
    for rel in doc.get("relations") or []:
        child = rel.get("table")
        cols = rel.get("columns") or []
        parent = rel.get("parent_table")
        if child and parent and cols:
            rels_by_child.setdefault(child, []).append({"field": cols[0], "target": parent})

    tables = []
    for t in doc.get("tables") or []:
        ttype = (t.get("type") or "").upper()
        if "TABLE" not in ttype:  # views/materialized views are not ERD surface (v0.2)
            continue
        name = t.get("name") or ""
        schema, _, table = name.rpartition(".")
        schema = schema or "public"
        cols = [{"name": c.get("name"), "type": c.get("type"),
                 "nullable": bool(c.get("nullable")),
                 "default": c.get("default"), "comment": c.get("comment") or None}
                for c in (t.get("columns") or [])]
        tables.append({"name": f"{schema}.{table}", "schema": schema, "table": table,
                       "columns": cols,
                       "relations": sorted(rels_by_child.get(name, []),
                                           key=lambda r: (r["field"], r["target"])),
                       "comment": t.get("comment") or None})
    tables.sort(key=lambda t: t["name"])
    print(json.dumps({"tables": tables, "source": source}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
