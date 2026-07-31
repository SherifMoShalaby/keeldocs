#!/usr/bin/env python3
"""E5 - re-anchoring corpus rerun at power (audit item 9 / ADR-007 v0.2 note).

Replays 12 months of a real repo's history in monthly steps. For each
consecutive commit pair (A, B): extract symbols at both with the SHIPPED
ts-imports extractor, build `ds` identities exactly as the engine does,
compute orphans (ids in A missing in B), the real git rename map (-M60),
and run every orphan through the SHIPPED rankSymbolCandidates. Measures:
candidate recall, auto-fire rate, and the structural invariants of every
auto case for the <0.5% false-rebind gate.
"""
import json, os, subprocess, sys
from datetime import datetime, timedelta

ENGINE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LABEL = "corpus"
EXTRACT = os.path.join(ENGINE, "providers", "module-graph", "ts-imports", "extract_symbols.py")

def sh(cwd, *a):
    r = subprocess.run(a, cwd=cwd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"{a[:3]} rc={r.returncode}: {r.stderr[-300:]}")
    return r.stdout

def suffix(kind):
    if "function" in kind: return "()."
    if any(k in kind for k in ("class", "interface", "type", "enum", "namespace")): return "#"
    return "."

def symbols_at(repo, sha, workdir):
    sh(repo, "git", "worktree", "add", "--detach", "--force", workdir, sha)
    try:
        raw = json.loads(sh(ENGINE, sys.executable, EXTRACT, workdir))
        return {f"ds {LABEL} . {s['path']}/{s['name']}{suffix(s['kind'])}": s["nameless"]
                for s in raw["symbols"]}
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", workdir], cwd=repo, capture_output=True)

def main(repo, months=12, step_days=30, label="hono"):
    head_date = sh(repo, "git", "log", "-1", "--format=%cI").strip()
    end = datetime.fromisoformat(head_date)
    shas = []
    steps = (months * 30) // step_days
    for m in range(steps, -1, -1):
        before = (end - timedelta(days=step_days * m)).isoformat()
        sha = sh(repo, "git", "rev-list", "-1", f"--before={before}", "HEAD").strip()
        if sha and (not shas or shas[-1] != sha):
            shas.append(sha)
    print(f"{len(shas)} sampled commits over {months} months", file=sys.stderr)

    cases, cache = [], {}
    survived = total_base = 0
    for a, b in zip(shas, shas[1:]):
        for sha in (a, b):
            if sha not in cache:
                cache[sha] = symbols_at(repo, sha, f"/tmp/e5-wt-{sha[:8]}")
        A, B = cache[a], cache[b]
        survived += len(set(A) & set(B)); total_base += len(A)
        orphans = sorted(set(A) - set(B))
        if not orphans:
            continue
        name_status = sh(repo, "git", "diff", "--name-status", "-M60", a, b)
        cases.append({"pair": f"{a[:8]}..{b[:8]}", "orphans": orphans,
                      "base": A, "now": B, "nameStatus": name_status})

    with open("/tmp/e5-cases.json", "w") as f:
        json.dump({"cases": cases}, f)
    ranked = json.loads(sh(ENGINE, "node", os.path.join(ENGINE, "experiments", "e5-reanchor", "rank.mjs"),
                           "/tmp/e5-cases.json"))

    total = len(ranked)
    with_cands = [r for r in ranked if r["ranked"]]
    autos = [r for r in ranked if r["ranked"] and r["ranked"][0].get("auto")]
    print(json.dumps({
        "corpus": LABEL, "sampled_commits": len(shas),
        "survival": round(survived / total_base, 4) if total_base else None,
        "pairs": len(cases), "orphans": total,
        "with_candidates": len(with_cands),
        "candidate_recall": round(len(with_cands) / total, 3) if total else None,
        "auto_fired": len(autos),
        "auto_rate": round(len(autos) / total, 3) if total else None,
    }, indent=1))
    print("\n== every AUTO case (manual verification set) ==")
    for r in autos:
        print(json.dumps({"pair": r["pair"], "missing": r["missing"],
                          "to": r["ranked"][0]["id"], "signals": r["ranked"][0]["signals"]}))
    print("\n== proposal-grade sample (first 15 non-auto with candidates) ==")
    for r in [x for x in with_cands if not x["ranked"][0].get("auto")][:15]:
        print(json.dumps({"pair": r["pair"], "missing": r["missing"],
                          "top": r["ranked"][0]["id"], "signals": r["ranked"][0]["signals"]}))

if __name__ == "__main__":
    LABEL = sys.argv[4] if len(sys.argv) > 4 else "corpus"
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 12,
         int(sys.argv[3]) if len(sys.argv) > 3 else 30)
