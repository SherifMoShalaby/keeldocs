#!/usr/bin/env python3
"""db-policies / sql-policies provider (keeldocs).

Static CREATE POLICY parsing - the roadmap's "ships regardless" slice of the
RLS story (live-Postgres via tbls stays off the critical path). Replays
migration files IN ORDER (sorted paths; timestamped names sort chronologically)
applying CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY, and
emits the FINAL policy state - a dropped-and-replaced policy reports only its
replacement. Value-blind and execution-free: no database, no env, no DSN.

PATTERN-tier honesty: SQL is parsed with anchored scans + a balanced-paren
walker (RE2-class patterns only - no backtracking blowups), which covers
conventional migration SQL. Exotic quoting (dollar-quoted policy bodies) is
out of scope and simply not matched - never guessed.

Output: {"policies":[{schema,table,name,command,permissive,roles,using,
with_check,file}], "rls":[{schema,table,enabled,file}]} - both sorted; db
keys are always schema-qualified (ADR-007), default schema "public".
"""
import json
import os
import re
import sys

MIGRATION_DIRS = ("supabase/migrations", "migrations", "db/migrations", "sql")
CREATE_RE = re.compile(r"\bcreate\s+policy\s+(\"[^\"]+\"|[A-Za-z_][\w$]*)\s+on\s+([\w.\"]+)", re.I)
DROP_RE = re.compile(r"\bdrop\s+policy\s+(?:if\s+exists\s+)?(\"[^\"]+\"|[A-Za-z_][\w$]*)\s+on\s+([\w.\"]+)", re.I)
RLS_RE = re.compile(r"\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w.\"]+)\s+(enable|disable|force|no\s+force)\s+row\s+level\s+security", re.I)
AS_RE = re.compile(r"\bas\s+(permissive|restrictive)\b", re.I)
FOR_RE = re.compile(r"\bfor\s+(all|select|insert|update|delete)\b", re.I)
TO_RE = re.compile(r"\bto\s+([\w\",\s]+?)(?=\busing\b|\bwith\s+check\b|$)", re.I)
USING_RE = re.compile(r"\busing\s*\(", re.I)
CHECK_RE = re.compile(r"\bwith\s+check\s*\(", re.I)


def ident(raw):
    return raw.strip().strip('"')


def qualify(table_raw):
    parts = [ident(p) for p in table_raw.split(".")]
    return (parts[0], parts[1]) if len(parts) == 2 else ("public", parts[0])


def norm_ws(s):
    return " ".join(s.split())


def balanced(text, open_idx):
    """text[open_idx] == '(' -> contents inside the balanced parens, respecting '...' strings."""
    depth, i, in_str = 0, open_idx, False
    while i < len(text):
        c = text[i]
        if in_str:
            in_str = c != "'"
        elif c == "'":
            in_str = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i], i
        i += 1
    return None, len(text)


def statements(sql):
    """Split on ';' outside single-quoted strings; drop -- comments first."""
    lines = []
    for ln in sql.split("\n"):
        out, in_str = [], False
        i = 0
        while i < len(ln):
            c = ln[i]
            if in_str:
                out.append(c)
                in_str = c != "'"
            elif c == "'":
                out.append(c)
                in_str = True
            elif c == "-" and ln[i:i + 2] == "--":
                break
            else:
                out.append(c)
            i += 1
        lines.append("".join(out))
    text = "\n".join(lines)
    stmts, buf, in_str = [], [], False
    for c in text:
        if in_str:
            buf.append(c)
            in_str = c != "'"
        elif c == "'":
            buf.append(c)
            in_str = True
        elif c == ";":
            stmts.append("".join(buf))
            buf = []
        else:
            buf.append(c)
    if "".join(buf).strip():
        stmts.append("".join(buf))
    return stmts


def parse_policy(stmt, m):
    name, (schema, table) = ident(m.group(1)), qualify(m.group(2))
    rest = stmt[m.end():]
    asm = AS_RE.search(rest)
    form = FOR_RE.search(rest)
    tom = TO_RE.search(rest)
    using = check = None
    um = USING_RE.search(rest)
    if um:
        using, _ = balanced(rest, um.end() - 1)
    cm = CHECK_RE.search(rest)
    if cm:
        check, _ = balanced(rest, cm.end() - 1)
    roles = sorted(ident(r) for r in tom.group(1).split(",") if r.strip()) if tom else ["public"]
    return {
        "schema": schema, "table": table, "name": name,
        "command": (form.group(1).upper() if form else "ALL"),
        "permissive": (asm.group(1).lower() != "restrictive") if asm else True,
        "roles": roles,
        "using": norm_ws(using) if using is not None else None,
        "with_check": norm_ws(check) if check is not None else None,
    }


def main(root):
    files = []
    for d in MIGRATION_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for fn in sorted(filenames):
                if fn.endswith(".sql"):
                    files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    files.sort()

    policies, rls = {}, {}
    for rel in files:
        try:
            sql = open(os.path.join(root, rel), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for stmt in statements(sql):
            cm = CREATE_RE.search(stmt)
            if cm:
                p = parse_policy(stmt, cm)
                p["file"] = rel
                policies[(p["schema"], p["table"], p["name"])] = p
                continue
            dm = DROP_RE.search(stmt)
            if dm:
                name, (schema, table) = ident(dm.group(1)), qualify(dm.group(2))
                policies.pop((schema, table, name), None)
                continue
            rm = RLS_RE.search(stmt)
            if rm:
                (schema, table), verb = qualify(rm.group(1)), rm.group(2).lower()
                if verb in ("enable", "disable"):
                    rls[(schema, table)] = {"schema": schema, "table": table,
                                            "enabled": verb == "enable", "file": rel}

    print(json.dumps({
        "policies": [policies[k] for k in sorted(policies)],
        "rls": [rls[k] for k in sorted(rls)],
    }, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
