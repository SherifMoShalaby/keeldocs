#!/usr/bin/env python3
"""Kustomize base workload extractor (variant topology, N3).

Bases are plain manifests, so extraction is a static parse. Overlays exist
precisely to differ per environment - this provider reads BASES only and
emits each overlay as a named gap, because silently rendering one overlay
would publish a variant as "the" architecture. Patches are not applied for
the same reason. Deterministic: sorted dirs, sorted emission.
"""
import json, os, sys
import yaml

SKIP = {".git", ".keeldocs", "golden", "node_modules"}
WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"}


def main(root):
    services, gaps = [], []
    kdirs = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        for cand in ("kustomization.yaml", "kustomization.yml"):
            if cand in filenames:
                kdirs.append((dirpath, cand))
                break
    for cdir, cfile in sorted(kdirs):
        rel = os.path.relpath(os.path.join(cdir, cfile), root).replace(os.sep, "/")
        try:
            k = yaml.safe_load(open(os.path.join(cdir, cfile), encoding="utf-8")) or {}
        except yaml.YAMLError:
            gaps.append({"file": rel, "reason": "unparseable kustomization"})
            continue
        if k.get("bases") or k.get("patches") or k.get("patchesStrategicMerge"):
            gaps.append({"file": rel, "reason": "overlay (bases/patches) - variant not rendered, base only"})
            continue
        for res in sorted(k.get("resources") or []):
            path = os.path.normpath(os.path.join(cdir, res))
            if not os.path.isfile(path):
                gaps.append({"file": rel, "reason": f"resource not in repo: {res[:40]}"})
                continue
            try:
                docs = [d for d in yaml.safe_load_all(open(path, encoding="utf-8")) if isinstance(d, dict)]
            except yaml.YAMLError:
                gaps.append({"file": os.path.relpath(path, root).replace(os.sep, "/"),
                             "reason": "unparseable manifest"})
                continue
            for doc in docs:
                kind = doc.get("kind")
                if kind not in WORKLOADS and kind != "Service":
                    continue
                name = str((doc.get("metadata") or {}).get("name") or res)
                spec = doc.get("spec") or {}
                pod = (spec.get("template") or {}).get("spec") or {}
                image = next((str(c.get("image")) for c in (pod.get("containers") or [])
                              if isinstance(c, dict) and c.get("image")), None)
                ports = [str(p.get("port") or p.get("targetPort") or "")
                         for p in (spec.get("ports") or []) if isinstance(p, dict)]
                services.append({"name": name, "kind": "owned" if kind in WORKLOADS else "external",
                                 "image": image,
                                 "build": os.path.relpath(cdir, root).replace(os.sep, "/") if kind in WORKLOADS else None,
                                 "ports": sorted(x for x in ports if x), "depends_on": []})
    merged = {}
    for s in sorted(services, key=lambda s: (s["name"], s["kind"])):
        prev = merged.get(s["name"])
        if prev is None or (prev["kind"] == "external" and s["kind"] == "owned"):
            merged[s["name"]] = s
        elif prev["kind"] != s["kind"]:
            prev["ports"] = sorted(set(prev["ports"]) | set(s["ports"]))
    out = [merged[k] for k in sorted(merged)]
    seen, uniq = set(), []
    for g in sorted(gaps, key=lambda g: (g["file"], g["reason"])):
        key = (g["file"], g["reason"])
        if key not in seen:
            seen.add(key)
            uniq.append(g)
    print(json.dumps({"services": out, "file": None, "warnings": uniq}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
