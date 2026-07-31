#!/usr/bin/env python3
"""services-topology / compose provider (keeldocs).
Static parse of docker-compose.yml - never executed, never resolved against env.
Node modeling per the design: a service WITH build: is an OWNED service; an
image-only entry is an EXTERNAL dependency (postgres:16 is not your architecture).
Unresolvable ${VAR} interpolations are preserved verbatim, never guessed.
Output: {"services":[{"name","kind","image","build","ports","depends_on"}]} sorted.
"""
import json, os, sys
import yaml

CANDIDATES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]

def port_str(p):
    # short syntax arrives as str/int; long syntax as a mapping - render both
    # deterministically, never Python's dict repr
    if isinstance(p, dict):
        pub, tgt = p.get("published"), p.get("target")
        if tgt is not None:
            return f"{pub}:{tgt}" if pub is not None else str(tgt)
        return json.dumps(p, sort_keys=True)
    return str(p)

def main(root):
    path = next((os.path.join(root, c) for c in CANDIDATES if os.path.exists(os.path.join(root, c))), None)
    if not path:
        print(json.dumps({"services": []}))
        return
    doc = yaml.safe_load(open(path)) or {}
    out = []
    for name, spec in sorted((doc.get("services") or {}).items()):
        spec = spec or {}
        build = spec.get("build")
        if isinstance(build, dict):
            build = build.get("context", ".")
        dep = spec.get("depends_on") or []
        if isinstance(dep, dict):
            dep = list(dep.keys())
        out.append({
            "name": name,
            "kind": "owned" if build is not None else "external",
            "image": spec.get("image"),
            "build": build,
            "ports": sorted(port_str(p) for p in (spec.get("ports") or [])),
            "depends_on": sorted(dep),
        })
    print(json.dumps({"services": out, "file": os.path.relpath(path, root)}, indent=1))

if __name__ == "__main__":
    main(sys.argv[1])
