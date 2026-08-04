#!/usr/bin/env python3
"""Count public repositories carrying committed keeldocs anchors.

The v1.0 gate in ROADMAP §3 is ">=500 public repos with committed anchors", and
before this script there was no instrument for it at all - the gate could not be
checked, only asserted.

The number this produces is a FLOOR, never a total. GitHub code search indexes
default branches of public repositories with lag and its own eligibility rules,
caps result pages, and can report `incomplete_results`. A repo using keeldocs
privately, on a non-default branch, or simply not yet indexed is invisible here.

More importantly: **it refuses to report a number when it cannot tell zero from
blind.** A search index that has not reached keeldocs' own repository - which is
known to carry anchors, because this script checks that in git - returns 0 for
every adopter too. Printing that 0 as an adoption figure would be reporting an
artifact of the index as a measurement, which is the exact failure this project
exists to argue against. When the control fails the verdict is UNMEASURABLE.

Network: yes, deliberately, and this is why it lives in scripts/dev/ and is
never reachable from `check`. The check path is a pure function of the tree.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MARKER = "keeldocs:gen"          # the generated-region marker; present in any managed doc
SELF = "SherifMoShalaby/keeldocs"


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"gh failed: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout or "{}")


def search(q, per_page=100):
    return gh("api", "-X", "GET", "search/code", "-f", f"q={q}", "-f", f"per_page={per_page}")


def control_ok():
    """Is the index able to see anchors we KNOW are committed?

    Two conditions, both required: the marker really is in a tracked file here
    (git, not the network), and code search can find this repository at all.
    """
    tracked = subprocess.run(["git", "grep", "-l", MARKER, "--", "docs/"],
                             cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if not tracked:
        return False, "no committed doc in this repo carries the marker - nothing to validate against"
    try:
        seen = search(f"repo:{SELF} {MARKER}", per_page=1).get("total_count", 0)
    except RuntimeError as e:
        return False, f"code search unavailable: {e}"
    if not seen:
        return False, (f"code search does not index {SELF}, which carries the marker in "
                       f"{tracked.splitlines()[0]} - so 0 adopters and 0 indexed are indistinguishable")
    return True, "index reaches a repository known to carry the marker"


def main():
    ok, why = control_ok()
    if not ok:
        out = {"verdict": "UNMEASURABLE", "reason": why, "floor": None}
        print(json.dumps(out, indent=1) if "--json" in sys.argv else
              f"adoption: UNMEASURABLE\n  {why}\n\n  Not reported as 0: a blind index and no adopters\n"
              f"  produce the same number, and only one of them is a fact.")
        return 2
    res = search(f'"{MARKER}" in:file')
    repos = sorted({i["repository"]["full_name"] for i in res.get("items", [])})
    others = [r for r in repos if r != SELF]
    out = {"verdict": "FLOOR", "floor": len(others), "self_excluded": SELF in repos,
           "incomplete_results": res.get("incomplete_results"), "repos": others}
    print(json.dumps(out, indent=1) if "--json" in sys.argv else
          f"adoption floor: {len(others)} public repo(s) with committed anchors, excluding keeldocs itself\n"
          f"  a floor, not a total: code search indexes default branches with lag and caps pages\n"
          + "".join(f"  {r}\n" for r in others[:20]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
