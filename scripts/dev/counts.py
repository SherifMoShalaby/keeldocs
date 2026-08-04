#!/usr/bin/env python3
"""Ground truth for every number the tracking documents quote.

These counts were hand-maintained and rotted continuously: in a single day the
provider count was wrong (35 vs 34), the finding-class count was wrong (8 vs 7),
and the unit-test count was stale in four places across three files while the
number itself moved 151 -> 172. A project whose thesis is that hand-maintained
documentation lies should not hand-maintain its own counts.

Prints them; `scripts/harness.py` asserts the documents agree.
"""
import json, os, re, subprocess, sys

# scripts/dev/counts.py -> three levels up is the repo root
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def counts():
    out = {}
    out["providers"] = int(subprocess.run(
        ["node", "-e", 'import("./src/registry.js").then(m=>console.log(m.REGISTRY.length))'],
        cwd=ROOT, capture_output=True, text=True).stdout.strip() or 0)
    out["capabilities"] = len([d for d in os.listdir(os.path.join(ROOT, "providers"))
                               if os.path.isdir(os.path.join(ROOT, "providers", d)) and not d.startswith("_")])
    src = open(os.path.join(ROOT, "src", "newcmd.js"), encoding="utf-8").read()
    out["recipes"] = len(re.search(r"const TYPES = \[(.*?)\]", src, re.S).group(1).split(","))
    out["skills"] = len([d for d in os.listdir(os.path.join(ROOT, "skills"))
                         if os.path.isfile(os.path.join(ROOT, "skills", d, "SKILL.md"))])
    lies = open(os.path.join(ROOT, "src", "lies.js"), encoding="utf-8").read()
    out["finding_classes"] = len(set(re.findall(r'"[a-z][a-z-]*-claim"', lies)))
    harness = open(os.path.join(ROOT, "scripts", "harness.py"), encoding="utf-8").read()
    i = harness.find("MATRIX = [")
    out["goldens"] = harness[i:harness.find("\ndef ", i)].count('"golden"')
    adrs = open(os.path.join(ROOT, "docs", "design", "03-adrs.md"), encoding="utf-8").read()
    out["adrs"] = len(set(re.findall(r"ADR-(\d{3})", adrs)))
    out["fixtures"] = len([d for d in os.listdir(os.path.join(ROOT, "fixtures"))
                           if os.path.isdir(os.path.join(ROOT, "fixtures", d))])
    return out


if __name__ == "__main__":
    c = counts()
    if "--json" in sys.argv:
        print(json.dumps(c, indent=1, sort_keys=True))
    else:
        for k in sorted(c):
            print(f"  {k:18} {c[k]}")
