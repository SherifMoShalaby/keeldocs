#!/usr/bin/env python3
"""PostgREST surface extractor (E9 round-3 gap).

For a Supabase app the REST API is not written anywhere - it is DERIVED. Every
table in an exposed schema is reachable at /rest/v1/<relation>, and every
function at /rest/v1/rpc/<name>. Nothing in the repo registers those routes, so
a doc that names one correctly was, until this provider, reported as a lie.

This is a pure function of two inputs, both already in hand:

  1. the CATALOG, read through the declared ${facts:db-schema} cross-capability
     read (provider contract 9) - so the expensive replay runs exactly once
  2. supabase/config.toml [api], which decides whether the API is on at all
     and which schemas it exposes (default: public)

What it deliberately does NOT claim:

  * PUT. PostgREST supports single-row upsert via PUT, but only for tables with
    a primary key, and the catalog facts carry no key information. An endpoint
    we cannot verify is one we do not emit.
  * Views and materialized views. A real exposed surface, not modeled in this
    version - sql-replay names each one as a `view-unmodeled` gap so the hole
    reads as a hole.
  * Procedures. CALL-able through PostgREST, but the invocation shape differs
    enough that guessing would be worse than a named gap.
  * Authorization. The endpoint EXISTS; whether a given role gets rows is
    decided by RLS, which is the db-policies capability's job, not this one.

Non-public exposed schemas are addressed by the Accept-Profile/Content-Profile
header, NOT by a path segment - so two exposed schemas holding the same
relation name genuinely collide on one path. That is reported, never guessed.
"""
import json, os, re, sys

REST = "/rest/v1"
TABLE_VERBS = ("DELETE", "GET", "PATCH", "POST")
# functions PostgREST cannot expose however they are declared
UNEXPOSED_RETURNS = {"trigger", "event_trigger"}


def read_facts():
    """Declared cross-capability read: the engine hands us db-schema's resolved
    fact file. Absent (standalone run, or no catalog extracted) -> None, which
    the caller distinguishes from an empty catalog."""
    path = os.environ.get("KEELDOCS_FACTS_DB_SCHEMA")
    if not path or not os.path.exists(path):
        return None
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a malformed line is skipped, never fatal
    return out


def read_api_config(root, warnings):
    """supabase/config.toml [api]: `enabled` and `schemas`. Missing file is the
    normal case and means the platform defaults - the REST API on, public
    exposed. A file we cannot parse is named, never silently defaulted."""
    path = os.path.join(root, "supabase", "config.toml")
    if not os.path.exists(path):
        return True, ["public"]
    try:
        raw = open(path, encoding="utf-8").read()
    except OSError:
        warnings.append({"kind": "config-unreadable", "file": "supabase/config.toml"})
        return True, ["public"]
    try:
        import tomllib
        api = tomllib.loads(raw).get("api") or {}
        enabled = api.get("enabled", True)
        schemas = api.get("schemas") or ["public"]
        if isinstance(enabled, bool) and isinstance(schemas, list) \
                and all(isinstance(s, str) for s in schemas):
            return enabled, schemas
    except Exception:
        pass
    # fallback scanner over the [api] table only - flat keys, one line each
    enabled, schemas = True, ["public"]
    section = None
    seen = False
    for line in raw.splitlines():
        line = line.split("#", 1)[0].strip()
        m = re.match(r"^\[([^\]]+)\]$", line)
        if m:
            section = m.group(1).strip()
            continue
        if section != "api":
            continue
        m = re.match(r"^enabled\s*=\s*(true|false)\s*$", line)
        if m:
            enabled, seen = m.group(1) == "true", True
        m = re.match(r"^schemas\s*=\s*\[(.*)\]\s*$", line)
        if m:
            found = re.findall(r"""["']([^"']+)["']""", m.group(1))
            if found:
                schemas, seen = found, True
    if not seen:
        warnings.append({"kind": "config-unparsed", "file": "supabase/config.toml"})
    return enabled, schemas


def split_qualified(name):
    """Catalog facts are schema-qualified (public.orders). A DECLARED provider's
    model name (prisma `User`) is not, and is not a PostgREST relation - the dot
    is the discriminator, so no name-shape guessing is needed."""
    if "." not in name:
        return None, None
    schema, _, rel = name.partition(".")
    return schema, rel


def main(root):
    warnings = []
    facts = read_facts()
    if facts is None:
        # a chain exists but no catalog reached us: a real hole, named as one.
        # No chain (dashboard-managed project, no --live) is not a hole.
        if os.path.isdir(os.path.join(root, "supabase", "migrations")):
            warnings.append({"kind": "db-schema-facts-unavailable", "file": None})
        print(json.dumps({"endpoints": [], "warnings": warnings}, indent=1))
        return

    enabled, schemas = read_api_config(root, warnings)
    if not enabled:
        warnings.append({"kind": "rest-api-disabled", "file": "supabase/config.toml"})
        print(json.dumps({"endpoints": [], "warnings": warnings}, indent=1))
        return
    exposed = list(dict.fromkeys(schemas))  # config order, de-duplicated
    rank = {s: i for i, s in enumerate(exposed)}

    # relation/function name -> {schema: [fact ids]}. Grouping BEFORE choosing
    # keeps the winner a function of config order rather than of fact-file
    # order, which is sorted by id and would otherwise hand `api` the path
    # simply for sorting ahead of `public`.
    tables, functions, gettable = {}, {}, set()

    for f in facts:
        payload = f.get("payload") or {}
        attrs = payload.get("attrs") or {}
        kind = payload.get("type")
        schema, rel = split_qualified(attrs.get("name") or "")
        if not schema or schema not in rank:
            continue
        if kind == "table":
            tables.setdefault(rel, {}).setdefault(schema, []).append(f.get("id"))
        elif kind == "function":
            if attrs.get("kind") == "procedure":
                warnings.append({"kind": "procedure-unmodeled", "file": attrs.get("name")})
                continue
            if (attrs.get("returns") or "").lower() in UNEXPOSED_RETURNS:
                continue
            functions.setdefault(rel, {}).setdefault(schema, []).append(f.get("id"))
            # PostgREST allows GET on non-volatile functions only. Overloads are
            # resolved per request, so one stable overload makes GET reachable.
            if (attrs.get("volatility") or "volatile") != "volatile":
                gettable.add((schema, rel))

    def winner(by_schema):
        """Exposed schemas share one path space - the profile header, not the
        URL, picks between them - so config order decides and the collision is
        REPORTED. Overloads of one function collapse to one path; the lowest
        fact id is the stable receipt."""
        schema = min(by_schema, key=lambda s: rank[s])
        return schema, sorted(by_schema[schema])[0], len(by_schema) > 1

    endpoints, ambiguous = [], set()
    for rel, by_schema in tables.items():
        schema, fact_id, collided = winner(by_schema)
        if collided:
            ambiguous.add(rel)
        for verb in TABLE_VERBS:
            endpoints.append({"method": verb, "path": f"{REST}/{rel}",
                              "kind": "postgrest-catalog", "derived_from": fact_id})
    for name, by_schema in functions.items():
        schema, fact_id, collided = winner(by_schema)
        if collided:
            ambiguous.add(name)
        methods = ["GET", "POST"] if (schema, name) in gettable else ["POST"]
        for verb in methods:
            endpoints.append({"method": verb, "path": f"{REST}/rpc/{name}",
                              "kind": "postgrest-catalog", "derived_from": fact_id})

    for rel in sorted(ambiguous):
        warnings.append({"kind": "schema-profile-ambiguous", "file": rel})

    endpoints.sort(key=lambda e: (e["path"], e["method"]))
    warnings.sort(key=lambda w: (w["kind"], w["file"] or ""))
    print(json.dumps({"endpoints": endpoints, "warnings": warnings}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
