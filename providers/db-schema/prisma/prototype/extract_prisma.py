#!/usr/bin/env python3
"""Prisma schema extractor: models, fields (name/type/modifiers/attributes), @relation details."""
import json, re, sys


def parse(text):
    models, enums = [], []
    cur = None
    kind = None
    for raw in text.splitlines():
        # string-aware comment stripping (E1 finding 2026-07-30: naive split("//")
        # truncated URL defaults like @default("https://...") at "https:")
        cut, inq = len(raw), False
        i = 0
        while i < len(raw) - 1:
            ch = raw[i]
            if ch == '"' and (i == 0 or raw[i-1] != "\\"):
                inq = not inq
            elif not inq and ch == "/" and raw[i+1] == "/":
                cut = i
                break
            i += 1
        line = raw[:cut].rstrip()
        s = line.strip()
        if not s:
            continue
        m = re.match(r"(model|enum)\s+(\w+)\s*{", s)
        if m:
            kind = m.group(1)
            cur = {"name": m.group(2), "fields": [] if kind == "model" else None,
                   "values": [] if kind == "enum" else None, "block_attrs": []}
            continue
        if s == "}":
            if cur:
                (models if kind == "model" else enums).append(cur)
            cur, kind = None, None
            continue
        if cur is None:
            continue
        if kind == "enum":
            if not s.startswith("@@"):
                cur["values"].append(s.split()[0])
            continue
        if s.startswith("@@"):
            cur["block_attrs"].append(s)
            continue
        fm = re.match(r"(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$", s)
        if not fm:
            continue
        name, ftype, is_list, is_opt, attrs = fm.groups()
        field = {"name": name, "type": ftype, "list": bool(is_list),
                 "optional": bool(is_opt), "attrs": attrs.strip()}
        rel = re.search(r"@relation\(([^)]*)\)", attrs or "")
        if rel is not None:
            body = rel.group(1)
            r = {"raw": body}
            nm = re.match(r'\s*"([^"]+)"', body)
            if nm:
                r["name"] = nm.group(1)
            fields_m = re.search(r"fields:\s*\[([^\]]*)\]", body)
            refs_m = re.search(r"references:\s*\[([^\]]*)\]", body)
            if fields_m:
                r["fields"] = [x.strip() for x in fields_m.group(1).split(",") if x.strip()]
            if refs_m:
                r["references"] = [x.strip() for x in refs_m.group(1).split(",") if x.strip()]
            field["relation"] = r
        field["is_relation_field"] = rel is not None or (
            ftype[0].isupper() and ftype not in
            ("String", "Int", "Float", "Boolean", "DateTime", "Json", "Bytes", "BigInt", "Decimal"))
        cur["fields"].append(field)
    return {"models": models, "enums": enums}


if __name__ == "__main__":
    print(json.dumps(parse(open(sys.argv[1]).read()), indent=1))
