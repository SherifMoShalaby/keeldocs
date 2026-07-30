#!/usr/bin/env python3
"""E2/E3 analysis over extracted snapshots."""
import difflib
import json
import os
import random
import subprocess

BASE = "/home/user/undrift-validation/e23"
DATES = ["2025-08-01", "2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01",
         "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01",
         "2026-06-01", "2026-07-01", "2026-07-30"]
random.seed(42)


def load(repo):
    snaps = []
    for d in DATES:
        with open(f"{BASE}/snapshots/{repo}/{d}.json") as f:
            snaps.append(json.load(f)["symbols"])
    shas = {}
    for line in open(f"{BASE}/snapshots/{repo}/shas.txt"):
        d, s = line.split()
        shas[d] = s
    # rename maps between consecutive snapshots
    rmaps = []
    for i in range(len(DATES) - 1):
        a, b = shas[DATES[i]], shas[DATES[i + 1]]
        fn = f"{BASE}/snapshots/{repo}/renames_{a[:8]}_{b[:8]}.txt"
        m = {}
        if os.path.exists(fn):
            for line in open(fn):
                parts = line.rstrip("\n").split("\t")
                if parts[0].startswith("R") and len(parts) == 3:
                    m[parts[1]] = parts[2]
        rmaps.append(m)
    return snaps, shas, rmaps


def map_key(key, rmap):
    path, name = key.split("::", 1)
    return (rmap.get(path, path)) + "::" + name


def analyze(repo):
    snaps, shas, rmaps = load(repo)
    out = {"repo": repo}

    # ---- E2a: month-over-month churn ----
    churn_series = []
    changed_cases = []
    for i in range(12):
        A, B = snaps[i], snaps[i + 1]
        matched = changed = 0
        for key, sym in A.items():
            k2 = key if key in B else map_key(key, rmaps[i])
            if k2 in B:
                matched += 1
                if B[k2]["hash"] != sym["hash"]:
                    changed += 1
                    changed_cases.append({
                        "pair": f"{DATES[i]}..{DATES[i+1]}", "i": i,
                        "key": key, "key2": k2,
                        "old_sigs": sym["sigs"], "new_sigs": B[k2]["sigs"],
                        "shaA": shas[DATES[i]], "shaB": shas[DATES[i + 1]]})
        churn_series.append({"pair": f"{DATES[i]}..{DATES[i+1]}",
                             "matched": matched, "changed": changed,
                             "pct": round(100 * changed / matched, 2) if matched else 0})
    out["churn_series"] = churn_series
    out["changed_total"] = len(changed_cases)

    # ---- E2c: survival month-0 -> month-12 ----
    A, Z = snaps[0], snaps[12]
    s0 = s1 = 0
    orphans = []
    for key, sym in A.items():
        if key in Z:
            s0 += 1
            continue
        # chain rename maps across all 12 intervals
        path, name = key.split("::", 1)
        p = path
        for m in rmaps:
            p = m.get(p, p)
        k2 = p + "::" + name
        if k2 in Z:
            s1 += 1
        else:
            # hint: does the name exist anywhere at m12?
            elsewhere = [k for k in Z if k.endswith("::" + name)]
            orphans.append({"key": key, "chained_path": p,
                            "name_elsewhere_at_m12": elsewhere[:3]})
    out["survival"] = {"m0": len(A), "s0": s0, "s1": s1,
                       "orphans": len(orphans),
                       "pct": round(100 * (s0 + s1) / len(A), 2)}
    out["orphan_list"] = orphans

    # ---- E3: rename candidate mining (S2) ----
    e3 = []
    for i in range(12):
        A, B = snaps[i], snaps[i + 1]
        removed, added = [], []
        for key, sym in A.items():
            k2 = key if key in B else map_key(key, rmaps[i])
            if k2 not in B:
                removed.append((key, sym))
        mapped_from_A = set()
        for key in A:
            mapped_from_A.add(key if key in B else map_key(key, rmaps[i]))
        for key, sym in B.items():
            if key not in mapped_from_A:
                added.append((key, sym))
        for rkey, rsym in removed:
            rpath = rkey.split("::")[0]
            mpath = rmaps[i].get(rpath, rpath)
            cands = []
            for akey, asym in added:
                apath = akey.split("::")[0]
                if asym["name"] == rsym["name"]:
                    continue
                if asym["nameless"] != rsym["nameless"]:
                    continue
                file_agree = apath in (rpath, mpath)
                if not file_agree:
                    continue  # S2 mining scope: same or git-renamed file
                bsim = None
                if rsym["body"] and asym["body"]:
                    bsim = round(difflib.SequenceMatcher(
                        None, rsym["body"], asym["body"]).ratio(), 3)
                nsim = round(difflib.SequenceMatcher(
                    None, rsym["name"], asym["name"]).ratio(), 3)
                cands.append({"key": akey, "name": asym["name"],
                              "body_sim": bsim, "name_sim": nsim,
                              "sigs": asym["sigs"]})
            if cands:
                cands.sort(key=lambda c: (-(c["body_sim"] or 0),
                                          -c["name_sim"]))
                e3.append({"pair": f"{DATES[i]}..{DATES[i+1]}", "i": i,
                           "removed": rkey, "removed_sigs": rsym["sigs"],
                           "shaA": shas[DATES[i]], "shaB": shas[DATES[i + 1]],
                           "n_candidates": len(cands), "candidates": cands})
    out["e3_candidates"] = e3
    return out, changed_cases


def diff_excerpt(repo, shaA, shaB, path, path2, needle, ctx=1200):
    paths = [path] if path == path2 else [path, path2]
    cmd = ["git", "-C", f"{BASE}/repos/{repo}", "diff", "-M60%",
           shaA, shaB, "--"] + paths
    try:
        txt = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=60).stdout
    except Exception as e:
        return f"(diff failed: {e})"
    # find hunk lines mentioning the symbol name
    lines = txt.splitlines()
    hits = [j for j, l in enumerate(lines)
            if needle in l and (l.startswith("+") or l.startswith("-"))]
    if not hits:
        return "\n".join(lines[:40])
    j = hits[0]
    return "\n".join(lines[max(0, j - 8):j + 18])


def main():
    results = {}
    all_changed = {}
    for repo in ["hono", "zod"]:
        results[repo], all_changed[repo] = analyze(repo)

    with open(f"{BASE}/work/raw_analysis.json", "w") as f:
        json.dump(results, f, indent=1)

    # ---- drift sample for manual judging: ~13 per repo, spread over months
    with open(f"{BASE}/work/drift_sample.md", "w") as f:
        for repo in ["hono", "zod"]:
            cases = all_changed[repo]
            by_month = {}
            for c in cases:
                by_month.setdefault(c["i"], []).append(c)
            sample = []
            months = sorted(by_month)
            # round-robin across months until 13
            while len(sample) < 13 and any(by_month.values()):
                for m in months:
                    if by_month[m] and len(sample) < 13:
                        sample.append(by_month[m].pop(
                            random.randrange(len(by_month[m]))))
            f.write(f"\n\n# {repo}: {len(sample)} sampled of "
                    f"{len(cases)} hash-changed cases\n")
            for n, c in enumerate(sample):
                f.write(f"\n## {repo}-D{n}: {c['key']} ({c['pair']})\n")
                f.write("OLD SIGS:\n" +
                        "\n".join("  " + s[:400] for s in c["old_sigs"]) + "\n")
                f.write("NEW SIGS:\n" +
                        "\n".join("  " + s[:400] for s in c["new_sigs"]) + "\n")
                p1 = c["key"].split("::")[0]
                p2 = c["key2"].split("::")[0]
                ex = diff_excerpt(repo, c["shaA"], c["shaB"], p1, p2,
                                  c["key"].split("::")[1])
                f.write("DIFF EXCERPT:\n```\n" + ex[:2500] + "\n```\n")

    # ---- E3 candidates for judging (up to 30 total) ----
    with open(f"{BASE}/work/e3_candidates.md", "w") as f:
        total = 0
        for repo in ["hono", "zod"]:
            for n, c in enumerate(results[repo]["e3_candidates"]):
                if total >= 30:
                    break
                total += 1
                f.write(f"\n## {repo}-R{n}: removed {c['removed']} "
                        f"({c['pair']}) n_cand={c['n_candidates']}\n")
                f.write("removed sigs: " +
                        " || ".join(s[:300] for s in c["removed_sigs"]) + "\n")
                for cd in c["candidates"][:3]:
                    f.write(f"  cand: {cd['key']} body_sim={cd['body_sim']} "
                            f"name_sim={cd['name_sim']}\n")
                p1 = c["removed"].split("::")[0]
                p2 = c["candidates"][0]["key"].split("::")[0]
                ex = diff_excerpt(repo, c["shaA"], c["shaB"], p1, p2,
                                  c["removed"].split("::")[1])
                f.write("DIFF EXCERPT:\n```\n" + ex[:2500] + "\n```\n")

    # ---- orphan sample ----
    with open(f"{BASE}/work/orphans.md", "w") as f:
        for repo in ["hono", "zod"]:
            ol = results[repo]["orphan_list"]
            samp = random.sample(ol, min(5, len(ol)))
            f.write(f"\n# {repo}: {len(ol)} orphans, sampled {len(samp)}\n")
            for o in samp:
                f.write(json.dumps(o) + "\n")

    for repo in ["hono", "zod"]:
        r = results[repo]
        print(repo, "churn:", [c["pct"] for c in r["churn_series"]])
        print(repo, "survival:", r["survival"])
        print(repo, "changed cases:", r["changed_total"],
              "| e3 candidates:", len(r["e3_candidates"]))


if __name__ == "__main__":
    main()
