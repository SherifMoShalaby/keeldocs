#!/usr/bin/env python3
"""Count public repositories carrying committed keeldocs anchors.

The v1.0 gate in ROADMAP section 3 is ">=500 public repos with committed
anchors", and before this script there was no instrument for it at all - the gate
could not be checked, only asserted.

**Network: yes, deliberately.** This script calls the GitHub API, and that is why
it lives in `scripts/dev/` and is unreachable from `check`. It also reads the
wall clock, to date its own log. The `check` path may do neither: it is a pure
function of the tree, and `--ci` uses the HEAD commit time rather than `now()`.
Nothing here is imported by anything under `src/`.

WHAT CHANGED, AND THE FAILURE MODE IT FIXES
-------------------------------------------
This script used to return one verdict, `UNMEASURABLE`, for three different
states of the world, which is the same defect the engine keeps repairing: an
answer nobody can act on. Worse, it printed a *cause* it had not measured -
"code search does not index SherifMoShalaby/keeldocs" - and ROADMAP.md quoted
that cause as fact in two places.

The cause was unmeasured because the control was broken in three separate ways,
each of which alone would have made it unable to pass:

  1. It scoped its control with `repo:`. Measured 2026-08-08: **every**
     `repo:`-scoped query on this endpoint returns `total_count: 0` with
     `incomplete_results: true`, including `addEventListener repo:facebook/react`
     and `license repo:sindresorhus/is-odd`. The control returned the same 0 for
     repositories that are unquestionably indexed, so it could never have passed
     for anyone, and its failure said nothing about this repository.
  2. It sent the marker **unquoted** (`repo:X keeldocs:gen`) while the
     measurement sent it **quoted** (`"keeldocs:gen" in:file`). A control that
     runs a different query than the measurement does not control the
     measurement. Unquoted, `keeldocs:gen` parses as a search qualifier.
  3. It discarded `incomplete_results`. The API's own flag for "this number is
     not a count" was read on the measurement path and ignored on the control
     path, and a 0 carrying that flag was treated as evidence.

THE THREE VERDICTS
------------------
  FLOOR  - the instrument is proven working and found N other repositories.
           Still a floor, never a total: code search indexes default branches
           with lag and its own eligibility rules, caps result pages, and cannot
           see private repositories or non-default branches.
  ZERO   - the instrument is proven working and found none. This is a real,
           actionable finding, and until now it was indistinguishable from
           blindness.
  BLIND  - the instrument's own control failed. The answer is unknown, and
           `floor` is null rather than 0. `blind_reason` names which control
           failed and how, from an enumerated list.

THE CONTROL IS THE LOAD-BEARING PART
------------------------------------
Two probes, each ground-truthed from a source that is **not** the search index,
so neither can be satisfied by the index agreeing with itself:

  SELF    - the measurement query is its own control. This repository provably
            carries the marker on its public default branch: `git grep` proves
            it locally, and the GitHub *contents* API - a different API from the
            search index - proves the same bytes are on the default branch of
            the public repo. So a working index MUST return this repository. If
            it does not, a 0 for everyone else is not a count.
  WITNESS - a generated-region marker written by a different tool
            (`ALL-CONTRIBUTORS-LIST:START`), proven present at probe time by the
            contents API, then searched with the *same query shape* the
            measurement uses. It is deliberately the same shape as our own
            marker - a colon-bearing token inside an HTML comment, committed
            into documentation by a generator - so it exercises the tokenisation
            hazard that broke the old control. It answers the question SELF
            cannot: when SELF is invisible, is the index broken, or is it working
            and simply not reaching us?

Every probe resolves to one of `PROBE_OUTCOMES` and every verdict is derived
from a declared row of `RULES`. An outcome outside that list raises rather than
falling through to a silent pass - the same guard `src/disclosure.js` puts on an
unclassified report key, for the same reason.

THE LOG
-------
Each run appends one record to `adoption-log.jsonl`, so the answer is a series
rather than a claim and a future reader can see when the instrument last worked.
Appending is the default; `--no-log` is for dry runs. Do not hand-edit the file -
it is the instrument's own record of what it saw.

Exit codes: 0 measured (FLOOR or ZERO) - 2 blind, retry later - 3 the instrument
itself needs repair before its answer means anything.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOG_PATH = os.path.join(ROOT, "scripts", "dev", "adoption-log.jsonl")

MARKER = "keeldocs:gen"           # the generated-region marker; present in any managed doc
FALLBACK_SELF = "SherifMoShalaby/keeldocs"
PAGE = 100                        # the API's maximum
MAX_PAGES = 10                    # search caps at 1000 results; 10 pages reaches it

# A marker of the same SHAPE as ours, written by a different tool, whose presence
# is proven at probe time from the contents API rather than believed from here.
WITNESS_TOKEN = "ALL-CONTRIBUTORS-LIST:START"
WITNESS_REPO = "all-contributors/all-contributors"
WITNESS_PATH = "README.md"

# Enumerated, because a probe outcome that is not on this list must be an error
# and never a silence.
PROBE_OUTCOMES = (
    "SEEN",                  # ground truth says it exists, and search returned it
    "BLIND",                 # ground truth says it exists, a COMPLETED search did not return it
    "INCOMPLETE",            # the API flagged the result set incomplete: no conclusion
    "UNAVAILABLE",           # transport, auth or rate limit: no conclusion
    "GROUND_TRUTH_MISSING",  # the thing being probed for is not there; the control is invalid
)

VERDICTS = ("FLOOR", "ZERO", "BLIND")

# (self outcome, witness outcome or None for "any") -> verdict, blind_reason, exit.
# Read top to bottom; the first row whose pattern matches wins.
RULES = (
    ("SEEN", None, "MEASURED", None, 0),
    ("GROUND_TRUTH_MISSING", None, "BLIND", "control_invalid", 3),
    ("UNAVAILABLE", None, "BLIND", "search_unavailable", 2),
    ("INCOMPLETE", None, "BLIND", "search_incomplete", 2),
    ("BLIND", "SEEN", "BLIND", "self_not_indexed", 2),
    ("BLIND", "GROUND_TRUTH_MISSING", "BLIND", "control_invalid", 3),
    ("BLIND", "BLIND", "BLIND", "shape_unproven", 3),
    ("BLIND", "INCOMPLETE", "BLIND", "search_incomplete", 2),
    ("BLIND", "UNAVAILABLE", "BLIND", "search_unavailable", 2),
)

BLIND_REASONS = {
    "control_invalid": (
        "the control probes for something that is not there, so it cannot validate "
        "anything - repair the instrument before believing any number it prints"),
    "search_unavailable": (
        "code search could not be reached (transport, auth or rate limit), so no "
        "query ran to completion"),
    "search_incomplete": (
        "code search flagged its own result set incomplete, so the number it "
        "returned is not a count"),
    "self_not_indexed": (
        "code search works - it finds a marker of the same shape written by another "
        "tool - but it does not reach this repository, which provably carries the "
        "marker on its public default branch, so 0 adopters and 0 indexed are "
        "indistinguishable"),
    "shape_unproven": (
        "a completed search cannot find a marker the contents API proves is "
        "committed on a public default branch, so the query shape no longer works "
        "and neither would a count taken with it"),
}


class Unavailable(Exception):
    """The API could not be reached, or did not answer. Retry later."""


class NotFound(Unavailable):
    """The API answered, and what we probe for is not there.

    A subclass so a caller that only cares about "no answer" still catches it,
    but a distinct type because the two demand opposite actions: `Unavailable`
    means try again, `NotFound` means the control points at something that does
    not exist and the instrument needs repairing. Collapsing them would put a
    small copy of this script's original defect back in the error path.
    """


# --------------------------------------------------------------------------
# ground truth: git and the contents API, never the search index
# --------------------------------------------------------------------------

def git(*args):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def self_repo():
    """Which repository are we the control for? Ask the remote, do not assume."""
    m = re.search(r"github\.com[:/]+([^/]+/[^/.]+)", git("remote", "get-url", "origin"))
    return m.group(1) if m else FALLBACK_SELF


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise Unavailable(f"gh failed: {r.stderr.strip()[:200]}")
    try:
        return json.loads(r.stdout or "{}")
    except json.JSONDecodeError as e:
        raise Unavailable(f"gh returned unparseable output: {e}")


def raw_file(repo, path):
    """Bytes of a file on a repo's default branch, read from the CONTENTS API.

    This is the whole point of the control: it is a different API from the search
    index, so it cannot be satisfied by the index agreeing with itself.
    """
    r = subprocess.run(
        ["gh", "api", f"repos/{repo}/contents/{path}", "-H", "Accept: application/vnd.github.raw"],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        err = r.stderr.strip()[:200]
        if "HTTP 404" in err:
            raise NotFound(f"{repo}/{path} is not on the default branch (HTTP 404)")
        raise Unavailable(f"contents API failed for {repo}/{path}: {err}")
    return r.stdout


def search_page(q, page):
    return gh("api", "-X", "GET", "search/code",
              "-f", f"q={q}", "-f", f"per_page={PAGE}", "-f", f"page={page}")


def search_all(q):
    """Every repository the index returns for `q`, plus whether it finished.

    Returns (repos, total, complete). `complete` is false when the API flagged
    the result set incomplete OR when we stopped before enumerating every hit -
    in both cases an absence from `repos` proves nothing.
    """
    repos, total, seen, page = set(), 0, 0, 1
    while page <= MAX_PAGES:
        res = search_page(q, page)
        if res.get("incomplete_results"):
            return repos, res.get("total_count", 0), False
        total = res.get("total_count", 0)
        items = res.get("items", [])
        seen += len(items)
        repos.update(i["repository"]["full_name"] for i in items)
        if not items or seen >= total:
            return repos, total, True
        page += 1
    return repos, total, seen >= total


# --------------------------------------------------------------------------
# probes
# --------------------------------------------------------------------------

def probe_self(repo):
    """Does the index return a repository that PROVABLY carries the marker?

    Ground truth in two independent steps, neither of them the search index: the
    marker is in a tracked file here, and the same path on the public default
    branch carries it too. Only then is the search index asked.
    """
    detail = {"repo": repo, "query": f'"{MARKER}" in:file'}
    tracked = git("grep", "-l", MARKER, "--", "docs/")
    if not tracked:
        detail["ground_truth"] = "no tracked doc under docs/ carries the marker"
        return "GROUND_TRUTH_MISSING", detail, None
    path = tracked.splitlines()[0]
    detail["ground_truth_path"] = path
    try:
        published = raw_file(repo, path)
    except NotFound as e:
        detail["ground_truth"] = (
            f"{e} - it is tracked here but not published, so commit and push "
            f"before this probe can validate anything")
        return "GROUND_TRUTH_MISSING", detail, None
    except Unavailable as e:
        detail["ground_truth"] = str(e)
        return "UNAVAILABLE", detail, None
    if MARKER not in published:
        detail["ground_truth"] = (
            f"{path} carries the marker locally but the copy on {repo}'s default "
            f"branch does not - commit and push before this probe means anything")
        return "GROUND_TRUTH_MISSING", detail, None
    detail["ground_truth"] = f"contents API confirms the marker in {repo}:{path}"

    try:
        repos, total, complete = search_all(detail["query"])
    except Unavailable as e:
        detail["search"] = str(e)
        return "UNAVAILABLE", detail, None
    detail["total_count"] = total
    detail["complete"] = complete
    if not complete:
        return "INCOMPLETE", detail, None
    if repo in repos:
        return "SEEN", detail, repos
    return "BLIND", detail, repos


def probe_witness():
    """Does the measurement's query SHAPE work at all, on a marker like ours?"""
    detail = {"token": WITNESS_TOKEN, "repo": WITNESS_REPO,
              "query": f'"{WITNESS_TOKEN}" in:file'}
    try:
        body = raw_file(WITNESS_REPO, WITNESS_PATH)
    except NotFound as e:
        detail["ground_truth"] = (
            f"{e} - the witness moved or was deleted, so this control must be "
            f"repointed at a marker that exists before it validates anything")
        return "GROUND_TRUTH_MISSING", detail
    except Unavailable as e:
        detail["ground_truth"] = str(e)
        return "UNAVAILABLE", detail
    if WITNESS_TOKEN not in body:
        detail["ground_truth"] = (
            f"{WITNESS_REPO}/{WITNESS_PATH} no longer contains {WITNESS_TOKEN} - "
            f"this control is stale and must be repointed at a marker that exists")
        return "GROUND_TRUTH_MISSING", detail
    detail["ground_truth"] = f"contents API confirms {WITNESS_TOKEN} in {WITNESS_REPO}/{WITNESS_PATH}"
    try:
        res = search_page(detail["query"], 1)
    except Unavailable as e:
        detail["search"] = str(e)
        return "UNAVAILABLE", detail
    detail["total_count"] = res.get("total_count", 0)
    detail["complete"] = not res.get("incomplete_results")
    if not detail["complete"]:
        return "INCOMPLETE", detail
    return ("SEEN" if detail["total_count"] > 0 else "BLIND"), detail


# --------------------------------------------------------------------------
# classification - a pure function, so every branch is testable without a network
# --------------------------------------------------------------------------

def classify(self_outcome, witness_outcome, others):
    """(verdict, blind_reason, floor, exit_code) from two enumerated outcomes.

    An outcome outside PROBE_OUTCOMES raises. A pair that matches no rule raises.
    Neither may fall through to a verdict: an unclassified state reported as an
    answer is the failure this whole script is being repaired for.
    """
    for name, outcome in (("self", self_outcome), ("witness", witness_outcome)):
        if outcome not in PROBE_OUTCOMES:
            raise AssertionError(
                f"unclassified {name} probe outcome {outcome!r}; add it to "
                f"PROBE_OUTCOMES and give it a row in RULES")
    for want_self, want_witness, verdict, reason, code in RULES:
        if want_self != self_outcome:
            continue
        if want_witness is not None and want_witness != witness_outcome:
            continue
        if verdict == "MEASURED":
            n = len(others or ())
            return ("FLOOR" if n else "ZERO"), None, n, code
        return verdict, reason, None, code
    raise AssertionError(
        f"no rule for (self={self_outcome!r}, witness={witness_outcome!r}); "
        f"RULES must cover every pair or the verdict is a guess")


# --------------------------------------------------------------------------
# self-test - proves each verdict is reachable and the guard is not decorative
# --------------------------------------------------------------------------

def self_test():
    """Drive classify() over every enumerated pair. No network, no clock."""
    failures = []

    def expect(label, got, want):
        if got != want:
            failures.append(f"{label}: got {got}, want {want}")

    # Every verdict is reachable, and ZERO is distinguishable from BLIND.
    expect("floor", classify("SEEN", "SEEN", ["a/b", "c/d"]), ("FLOOR", None, 2, 0))
    expect("zero", classify("SEEN", "SEEN", []), ("ZERO", None, 0, 0))
    expect("zero-witness-irrelevant", classify("SEEN", "UNAVAILABLE", []), ("ZERO", None, 0, 0))
    expect("blind-not-indexed", classify("BLIND", "SEEN", []), ("BLIND", "self_not_indexed", None, 2))
    expect("blind-shape", classify("BLIND", "BLIND", []), ("BLIND", "shape_unproven", None, 3))
    expect("blind-transport", classify("UNAVAILABLE", "SEEN", []), ("BLIND", "search_unavailable", None, 2))
    expect("blind-incomplete", classify("INCOMPLETE", "SEEN", []), ("BLIND", "search_incomplete", None, 2))
    expect("blind-control", classify("GROUND_TRUTH_MISSING", "SEEN", []),
           ("BLIND", "control_invalid", None, 3))

    # BLIND never carries a number: a floor of 0 read off a blind index is the
    # exact confusion this script exists to prevent.
    for s in ("BLIND", "INCOMPLETE", "UNAVAILABLE", "GROUND_TRUTH_MISSING"):
        for w in PROBE_OUTCOMES:
            verdict, reason, floor, code = classify(s, w, ["x/y"])
            if verdict != "BLIND" or floor is not None or reason not in BLIND_REASONS:
                failures.append(f"({s},{w}) leaked a non-blind answer: "
                                f"{verdict} {reason} floor={floor}")
            if code not in (2, 3):
                failures.append(f"({s},{w}) exited {code}, which reads as measured")

    # Every enumerated pair is classified, and no other pair is.
    for s in PROBE_OUTCOMES:
        for w in PROBE_OUTCOMES:
            try:
                classify(s, w, [])
            except AssertionError as e:
                failures.append(f"({s},{w}) unclassified: {e}")
    # The guard must fire, and it must be the GUARD that fires rather than the
    # no-rule fallback underneath it. Both raise AssertionError, so a test that
    # only catches the type cannot tell them apart and passes with the guard
    # deleted - which is what this test did until a mutation proved it vacuous.
    # The pair below is why the guard is not redundant with the fallback:
    # `("SEEN", None, ...)` matches ANY witness, so without the guard an
    # unclassified witness outcome returns a confident ZERO. Measured, guard
    # removed: classify("SEEN", "GARBAGE", []) -> ('ZERO', None, 0, 0).
    probes = 0
    for bad in ("OK", "", None, "seen", "SEEN "):
        for label, call in (("self", lambda b=bad: classify(b, "SEEN", [])),
                            ("witness", lambda b=bad: classify("SEEN", b, [])),
                            ("witness-under-blind", lambda b=bad: classify("BLIND", b, []))):
            probes += 1
            try:
                got = call()
                failures.append(f"guard did not fire on {label}={bad!r}: returned {got}")
            except AssertionError as e:
                if "PROBE_OUTCOMES" not in str(e):
                    failures.append(
                        f"{label}={bad!r} raised the no-rule fallback, not the guard: {e}")

    for f in failures:
        print(f"FAIL {f}")
    n = len(PROBE_OUTCOMES) ** 2
    print(f"self-test: {'FAILED' if failures else 'ok'} - {n} enumerated pairs "
          f"classified, {len(VERDICTS)} verdicts reachable, guard fires on "
          f"{probes} unclassified outcomes")
    return 1 if failures else 0


# --------------------------------------------------------------------------

def append_log(record):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")


def render(rec):
    v = rec["verdict"]
    if v == "BLIND":
        return (f"adoption: BLIND ({rec['blind_reason']})\n"
                f"  {BLIND_REASONS[rec['blind_reason']]}\n\n"
                f"  self    {rec['probes']['self']['outcome']:<20} "
                f"{rec['probes']['self']['detail'].get('ground_truth', '')}\n"
                f"  witness {rec['probes']['witness']['outcome']:<20} "
                f"{rec['probes']['witness']['detail'].get('ground_truth', '')}\n\n"
                f"  Not reported as 0: a blind index and no adopters produce the\n"
                f"  same number, and only one of them is a fact.")
    if v == "ZERO":
        return ("adoption: ZERO public repos with committed anchors, excluding keeldocs itself\n"
                "  This is a measurement, not a blind spot: the index returned this\n"
                "  repository, which is known to carry the marker, so it would have\n"
                "  returned an adopter had there been one it can see.\n"
                "  Still not a total - the index cannot see private repos, non-default\n"
                "  branches, or anything it has not reached yet.")
    return (f"adoption floor: {rec['floor']} public repo(s) with committed anchors, "
            f"excluding keeldocs itself\n"
            f"  a floor, not a total: code search indexes default branches with lag "
            f"and caps pages\n"
            + "".join(f"  {r}\n" for r in rec["repos"][:20]))


def main(argv):
    ap = argparse.ArgumentParser(description="Count public repos carrying committed keeldocs anchors.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-log", action="store_true", help="do not append to adoption-log.jsonl")
    ap.add_argument("--self-test", action="store_true",
                    help="prove every verdict is reachable and the guard fires; offline")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    me = self_repo()
    s_outcome, s_detail, repos = probe_self(me)
    w_outcome, w_detail = probe_witness()
    others = sorted(r for r in (repos or set()) if r != me)
    verdict, reason, floor, code = classify(s_outcome, w_outcome, others)

    rec = {
        "utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "verdict": verdict,
        "blind_reason": reason,
        "floor": floor,
        "repos": others if verdict != "BLIND" else [],
        "self_repo": me,
        "marker": MARKER,
        "probes": {"self": {"outcome": s_outcome, "detail": s_detail},
                   "witness": {"outcome": w_outcome, "detail": w_detail}},
        "instrument": {"commit": git("rev-parse", "--short", "HEAD"),
                       "dirty": bool(git("status", "--porcelain", "--", __file__))},
        "exit": code,
    }
    if not args.no_log:
        append_log(rec)
    print(json.dumps(rec, indent=1, sort_keys=True) if args.json else render(rec))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
