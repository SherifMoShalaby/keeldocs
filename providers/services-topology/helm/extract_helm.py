#!/usr/bin/env python3
"""Helm chart workload extractor (variant topology, N3).

Reads every chart's templates and resolves {{ .Values.x.y }} against the
chart's OWN values.yaml (plus subchart defaults), never a guessed
environment. Rules:
- a template whose `kind` is a workload (Deployment/StatefulSet/DaemonSet/
  CronJob/Job) or a Service becomes a topology node
- names/images resolve only from declared values; anything still
  unresolved is preserved as an explicit <unknown:...> token AND emitted
  as an extraction-gap - never guessed, never silently dropped
- control-flow blocks ({{- if }}, range, include, tpl) are gaps: their
  bodies may or may not exist in a given install, and pretending
  otherwise is exactly the silently-chosen variant the design forbids
Deterministic: sorted charts, sorted templates, sorted emission.
"""
import json, os, re, sys
import yaml

SKIP = {".git", ".keeldocs", "golden", "node_modules", "charts_cache"}
WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job", "ReplicaSet"}
SUB = re.compile(r"\{\{-?\s*([^}]*?)\s*-?\}\}")
VALUE_REF = re.compile(r"^\.Values\.([A-Za-z0-9_.\[\]]+)$")
CHART_REF = re.compile(r"^\.Chart\.(Name|Version)$")


def dig(values, dotted):
    cur = values
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur if isinstance(cur, (str, int, float, bool)) else None


def render(text, values, chart, gaps, rel):
    """Substitute declared values; mark everything else explicitly unknown."""
    control = False

    def repl(m):
        nonlocal control
        expr = m.group(1).strip()
        vm = VALUE_REF.match(expr)
        if vm:
            got = dig(values, vm.group(1))
            if got is not None:
                return str(got)
            gaps.append({"file": rel, "reason": f"undeclared value .Values.{vm.group(1)}"})
            return f"<unknown:.Values.{vm.group(1)}>"
        cm = CHART_REF.match(expr)
        if cm:
            return str(chart.get(cm.group(1).lower(), f"<unknown:.Chart.{cm.group(1)}>"))
        if expr.split(" ")[0] in ("if", "end", "else", "range", "with", "define", "include", "template", "tpl", "toYaml", "printf"):
            control = True
            return ""
        gaps.append({"file": rel, "reason": f"unresolved template expression: {expr[:40]}"})
        return f"<unknown:{expr[:40]}>"

    out = SUB.sub(repl, text)
    if control:
        gaps.append({"file": rel, "reason": "template control flow - the rendered set is install-dependent"})
    return out


def docs_of(text):
    try:
        return [d for d in yaml.safe_load_all(text) if isinstance(d, dict)]
    except yaml.YAMLError:
        return None


def main(root):
    services, gaps = [], []
    charts = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
        if "Chart.yaml" in filenames or "Chart.yml" in filenames:
            charts.append(dirpath)
    for cdir in sorted(charts):
        rel_chart = os.path.relpath(cdir, root).replace(os.sep, "/")
        cfile = os.path.join(cdir, "Chart.yaml" if os.path.exists(os.path.join(cdir, "Chart.yaml")) else "Chart.yml")
        try:
            chart = yaml.safe_load(open(cfile, encoding="utf-8")) or {}
        except yaml.YAMLError:
            gaps.append({"file": f"{rel_chart}/Chart.yaml", "reason": "unparseable Chart.yaml"})
            continue
        vpath = os.path.join(cdir, "values.yaml")
        values = {}
        if os.path.exists(vpath):
            try:
                values = yaml.safe_load(open(vpath, encoding="utf-8")) or {}
            except yaml.YAMLError:
                gaps.append({"file": f"{rel_chart}/values.yaml", "reason": "unparseable values.yaml"})
        tdir = os.path.join(cdir, "templates")
        if not os.path.isdir(tdir):
            continue
        for fn in sorted(os.listdir(tdir)):
            if not fn.endswith((".yaml", ".yml")) or fn.startswith("_"):
                continue
            rel = f"{rel_chart}/templates/{fn}"
            text = open(os.path.join(tdir, fn), encoding="utf-8", errors="replace").read()
            rendered = render(text, values, chart, gaps, rel)
            docs = docs_of(rendered)
            if docs is None:
                gaps.append({"file": rel, "reason": "template did not render to parseable YAML"})
                continue
            for doc in docs:
                kind = doc.get("kind")
                if kind not in WORKLOADS and kind != "Service":
                    continue
                meta = doc.get("metadata") or {}
                name = str(meta.get("name") or fn.rsplit(".", 1)[0])
                image = None
                spec = doc.get("spec") or {}
                pod = ((spec.get("template") or {}).get("spec")
                       or ((spec.get("jobTemplate") or {}).get("spec") or {}).get("template", {}).get("spec")
                       or {})
                for c in (pod.get("containers") or []):
                    if isinstance(c, dict) and c.get("image"):
                        image = str(c["image"])
                        break
                ports = []
                for p in (spec.get("ports") or []):
                    if isinstance(p, dict):
                        ports.append(str(p.get("port") or p.get("targetPort") or ""))
                services.append({
                    "name": name, "kind": "owned" if kind in WORKLOADS else "external",
                    "image": image, "build": rel_chart if kind in WORKLOADS else None,
                    "ports": sorted(x for x in ports if x), "depends_on": [],
                })
    # a chart Service and its Deployment describe ONE node; keep the workload
    merged = {}
    for s in sorted(services, key=lambda s: (s["name"], s["kind"])):
        prev = merged.get(s["name"])
        if prev is None or (prev["kind"] == "external" and s["kind"] == "owned"):
            merged[s["name"]] = s
        elif prev["kind"] == s["kind"] == "owned":
            continue
        else:
            prev["ports"] = sorted(set(prev["ports"]) | set(s["ports"]))
    out = [merged[k] for k in sorted(merged)]
    seen, uniq = set(), []
    for g in sorted(gaps, key=lambda g: (g["file"], g["reason"])):
        k = (g["file"], g["reason"])
        if k not in seen:
            seen.add(k)
            uniq.append(g)
    print(json.dumps({"services": out, "file": None, "warnings": uniq}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
