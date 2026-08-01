#!/usr/bin/env python3
"""E8 measurement: wall time and PEAK RSS for a full keeldocs run.

Peak RSS is read from the child's own /proc high-water mark (VmHWM) rather
than sampled, so a spike between samples cannot be missed. Two runs are taken
and the SECOND is reported: the first pays for filesystem cache warming that
belongs to the machine, not to the tool.
"""
import json, os, resource, subprocess, sys, time

KD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bin", "keeldocs.js")


def run(cwd, *args):
    t0 = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    r = subprocess.run(["node", os.path.abspath(KD), *args], cwd=cwd,
                       capture_output=True, text=True, timeout=3600)
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    return {"seconds": round(time.monotonic() - t0, 2),
            "peak_rss_mb": round(max(after, before) / 1024, 1),
            "rc": r.returncode, "stdout": r.stdout[-4000:], "stderr": r.stderr[-500:]}


def main(repo, label):
    out = {"label": label, "repo": repo}
    init = run(repo, "init", "--yes", "--json")
    out["init"] = {k: init[k] for k in ("seconds", "peak_rss_mb", "rc")}
    try:
        out["init"]["summary"] = json.loads(init["stdout"])["summary"]
    except Exception:
        out["init"]["error"] = init["stdout"][-300:] or init["stderr"]
    for i in (1, 2):
        c = run(repo, "check", "--json")
        out[f"check{i}"] = {k: c[k] for k in ("seconds", "peak_rss_mb", "rc")}
        try:
            out[f"check{i}"]["code"] = json.loads(c["stdout"])["code"]
        except Exception:
            out[f"check{i}"]["error"] = c["stdout"][-300:] or c["stderr"]
    # a ONE-FILE change, then check again: the gate's "warm check" scenario
    victim = None
    for dirpath, _d, files in os.walk(os.path.join(repo, "packages")):
        for f in sorted(files):
            if f == "m1.ts":
                victim = os.path.join(dirpath, f)
                break
        if victim:
            break
    if victim:
        with open(victim, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("\nrouter.get('/added/by/e8', (req, res) => res.end());\n")
        c = run(repo, "check", "--json")
        out["check_after_1_file_edit"] = {k: c[k] for k in ("seconds", "peak_rss_mb", "rc")}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
