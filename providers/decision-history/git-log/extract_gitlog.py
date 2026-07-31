#!/usr/bin/env python3
"""decision-history / git-log provider (keeldocs).

Per-file churn over a bounded window, feeding init's hotspot x fan-in doc-plan
ranking (D5). Determinism contract: the window is anchored to HEAD's COMMITTER
TIME, never the wall clock - output is a pure function of the SHA (same
discipline as `check --ci` snooze expiry). Author identities are counted,
never emitted (names/emails are PII; a count carries the signal).

Honesty guards:
- root must BE the git toplevel: running inside a subdirectory of some outer
  repo (e.g. a fixture) would report the outer repo's history as the
  project's - that is a lie, so it emits zero files + a warning instead.
- shallow clones yield whatever history exists; per-SHA-and-clone determinism
  still holds and CI double-runs agree.

Output: {"head", "window_days", "files":[{path, commits, last, authors}]}
sorted by path; "last" = ISO committer date of the newest commit touching it.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

WINDOW_DAYS = 180
MAX_COMMITS = 1000
SKIP_PREFIXES = (".keeldocs/",)


def git(root, *args):
    r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=60)
    return r.stdout.strip() if r.returncode == 0 else None


def main(root):
    root = os.path.realpath(root)
    top = git(root, "rev-parse", "--show-toplevel")
    if top is None or os.path.realpath(top) != root:
        print(json.dumps({"head": None, "window_days": WINDOW_DAYS, "files": [],
                          "warnings": [{"kind": "not-a-git-root"}]}, indent=1))
        return
    head = git(root, "rev-parse", "HEAD")
    head_time = git(root, "log", "-1", "--format=%cI")
    if not head or not head_time:
        print(json.dumps({"head": None, "window_days": WINDOW_DAYS, "files": [],
                          "warnings": [{"kind": "empty-history"}]}, indent=1))
        return
    since = (datetime.fromisoformat(head_time) - timedelta(days=WINDOW_DAYS)).isoformat()

    # one \x01-prefixed header per commit, then its file list
    log = git(root, "log", f"--since={since}", f"--max-count={MAX_COMMITS}",
              "--no-renames", "--name-only", "--format=%x01%cI%x00%aE") or ""
    files = {}
    date, author = None, None
    for line in log.split("\n"):
        if line.startswith("\x01"):
            date, author = line[1:].split("\x00", 1)
            continue
        p = line.strip()
        if not p or date is None or p.startswith(SKIP_PREFIXES):
            continue
        f = files.setdefault(p, {"path": p, "commits": 0, "last": date, "authors": set()})
        f["commits"] += 1
        f["authors"].add(author)
        if date > f["last"]:
            f["last"] = date
    out = []
    for p in sorted(files):
        f = files[p]
        out.append({"path": p, "commits": f["commits"], "last": f["last"],
                    "authors": len(f["authors"])})
    print(json.dumps({"head": head, "window_days": WINDOW_DAYS, "files": out,
                      "warnings": []}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
