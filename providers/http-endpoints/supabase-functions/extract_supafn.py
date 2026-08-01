#!/usr/bin/env python3
"""Supabase Edge Functions endpoint extractor (E9 field gap).

Each supabase/functions/<name>/ directory (underscore-prefixed shared dirs
excluded) is invocable at POST /functions/v1/<name> - the platform's
convention, so the walk IS the extraction. Deterministic, sorted, no clock.
"""
import json, os, sys


def main(root):
    base = os.path.join(root, "supabase", "functions")
    endpoints = []
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            d = os.path.join(base, name)
            if not os.path.isdir(d) or name.startswith(("_", ".")):
                continue
            entry = next((f for f in ("index.ts", "index.js", "index.tsx")
                          if os.path.exists(os.path.join(d, f))), None)
            if entry is None:
                continue
            endpoints.append({"file": f"supabase/functions/{name}/{entry}",
                              "method": "POST", "path": f"/functions/v1/{name}"})
    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    print(json.dumps({"endpoints": endpoints, "warnings": []}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
