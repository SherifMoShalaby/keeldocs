#!/usr/bin/env python3
"""R7 breaking-agent-API drill.

R7's de-risk line in `docs/design/08-risks-experiments.md` ends with "one
deliberate breaking-change drill <=1 week fix", and the matching v1.0 gate in
ROADMAP Section 3 used to read "Survived one breaking agent-API change" with the
status "Not yet exercised". As written, both waited for the ecosystem to break
something. This is the active form: break it here, on purpose, and measure
whether the adapter layer absorbs it.

What R7's mitigation actually claims is narrow and testable: "adapters <=300
LOC, path-maps only". That is a claim that a change on the agent's side is
absorbed by editing DATA in `adapters/<agent>/manifest.yaml`, never CODE in
`src/skillscmd.js`. So the drill:

  1. models each agent as a CONTRACT - the four things it can unilaterally
     change about the Agent Skills surface keeldocs installs into;
  2. runs a CONTROL first, asserting the shipped manifests conform to today's
     contracts, because an instrument whose control has never passed measures
     nothing (`scripts/dev/adoption.py` is the standing lesson here);
  3. for each break class: mutates one field of one contract, runs the REAL
     installer from a copy of the shipped tree, and requires the unfixed tree to
     FAIL that contract - a break the current code already satisfies is not a
     break, and the class is reported VACUOUS rather than passed;
  4. applies the fix, re-runs, requires a PASS;
  5. hashes both package trees and computes which files differ. The class is
     ABSORBED only if that set is exactly the one manifest. "Adapters-only" is
     therefore measured from the trees, not asserted by construction.

No network, no agent binaries, no clock: this is not the `check` path, but it
runs offline and deterministically anyway so it can sit in the harness. Every
break class is a MODEL of an agent, not an agent. What that does and does not
license is written down in RESULTS.md and in the ROADMAP gate; read it before
quoting this drill for anything.

Usage:
    python3 experiments/r7-break-drill/drill.py            # human-readable
    python3 experiments/r7-break-drill/drill.py --json     # one JSON object
    python3 experiments/r7-break-drill/drill.py --record   # also append ledger

Exit codes: 0 every class ABSORBED, 1 any class UNABSORBED or VACUOUS,
2 the control failed (the drill measured nothing).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LEDGER = os.path.join(HERE, "ledger.jsonl")

# What gets copied to stand in for an installed package. This is the subset of
# package.json files[] the installer reads; if one goes missing the install
# fails loudly rather than the drill quietly measuring a smaller thing.
PKG_DIRS = ("bin", "src", "providers", "skills", "adapters", "spec")
PKG_FILES = ("AGENTS.md", "package.json")

# The drill's model of the three first-class agents as of 2026-08-08. `rejects`
# is the frontmatter keys the agent refuses; `listing_cap` is the ceiling on the
# whole skills listing it loads. Cursor's cap has never been measured - 8000 is
# Codex's published number applied for want of a better one, which is exactly
# why the number belongs in a manifest where it can be corrected per agent.
BASELINE = {
    "claude-code": {"skills_dir": ".claude/skills", "rejects": [], "listing_cap": 8000,
                    "requires_agents_md": False},
    "codex": {"skills_dir": ".agents/skills",
              "rejects": ["disable-model-invocation", "user-invocable"],
              "listing_cap": 8000, "requires_agents_md": True},
    "cursor": {"skills_dir": ".cursor/skills",
               "rejects": ["disable-model-invocation", "user-invocable"],
               "listing_cap": 8000, "requires_agents_md": True},
}

# Each class names one thing an agent can change without asking anyone, the
# manifest edit that should absorb it, and why the unfixed tree ought to fail.
# `fix` is applied to adapters/<agent>/manifest.yaml as key -> literal line value.
BREAKS = [
    {
        "id": "skills-dir-moved",
        "agent": "claude-code",
        "why": "the agent relocates its discovery directory in a minor release",
        "mutate": {"skills_dir": ".claude/agent-skills"},
        "fix": {"skills_dir": ".claude/agent-skills"},
    },
    {
        "id": "frontmatter-key-rejected",
        "agent": "claude-code",
        "why": "the agent starts rejecting a frontmatter key it used to accept; "
               "`disable-model-invocation` is emitted to this agent by four skills today",
        "mutate": {"rejects": ["disable-model-invocation"]},
        "fix": {"strip_fields": "[disable-model-invocation]"},
    },
    {
        "id": "listing-cap-lowered",
        "agent": "codex",
        "why": "the agent lowers the ceiling on the whole skills listing below what "
               "keeldocs ships, so an unchanged install silently overruns it",
        "mutate": {"listing_cap": 1200},
        "fix": {"listing_cap": "1200"},
    },
    {
        "id": "native-discovery-dropped",
        "agent": "claude-code",
        "why": "the agent drops native skill discovery and falls back to AGENTS.md",
        "mutate": {"requires_agents_md": True},
        "fix": {"agents_md_block": "true"},
    },
]


def source_listing():
    """The listing length, measured from skills/ independently of the installer.

    The installer's own number is a claim; this is the drill's measurement of
    the same thing, and the two are required to agree. Same rule as
    `src/skillscmd.js`: the length of the `name:` and `description:` frontmatter
    lines, which is what an agent's listing carries.
    """
    total = 0
    skills_root = os.path.join(ROOT, "skills")
    for name in sorted(os.listdir(skills_root)):
        path = os.path.join(skills_root, name, "SKILL.md")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        fm = text.split("---")[1]
        for line in fm.strip("\n").split("\n"):
            key = line.split(":")[0].strip()
            if key in ("name", "description"):
                total += len(line)
    return total


def make_pkg(dest):
    os.makedirs(dest, exist_ok=True)
    for d in PKG_DIRS:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(dest, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for f in PKG_FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(dest, f))
    return dest


def tree_hashes(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            with open(p, "rb") as fh:
                out[rel] = hashlib.sha256(fh.read()).hexdigest()
    return out


def edit_manifest(pkg, agent, fix):
    """Set each key in `fix` on adapters/<agent>/manifest.yaml, appending if absent.

    Deliberately a dumb line edit: the manifests are flat `key: value` by
    contract (`loadManifest` in src/skillscmd.js parses nothing else), and an
    edit that needed a YAML library would mean the manifest had stopped being a
    path-map, which is itself the thing under test.
    """
    path = os.path.join(pkg, "adapters", agent, "manifest.yaml")
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    for key, value in fix.items():
        for i, line in enumerate(lines):
            if line.split("#")[0].strip().startswith(key + ":"):
                lines[i] = f"{key}: {value}"
                break
        else:
            lines.append(f"{key}: {value}")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    return f"adapters/{agent}/manifest.yaml"


def run_install(pkg, agent, proj):
    os.makedirs(proj, exist_ok=True)
    cli = os.path.join(pkg, "bin", "keeldocs.js")
    r = subprocess.run([shutil.which("node") or "node", cli, "skills", "install",
                        "--agent", agent, "--json"],
                       cwd=proj, capture_output=True, text=True, timeout=120)
    line = next((l for l in r.stdout.splitlines() if l.startswith("{")), None)
    if line is None:
        raise AssertionError(f"skills install --agent {agent}: no JSON envelope "
                             f"(rc={r.returncode}) {r.stderr[-300:]}")
    return json.loads(line)


def installed_skills(proj):
    """Every SKILL.md under the project, as repo-relative posix paths.

    Walked from the project root rather than read off the envelope, so an
    install into the wrong directory is visible instead of being reported away.
    """
    found = []
    for dirpath, dirnames, filenames in os.walk(proj):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            if fn == "SKILL.md":
                rel = os.path.relpath(os.path.join(dirpath, fn), proj)
                found.append(rel.replace(os.sep, "/"))
    return sorted(found)


def validate(contract, proj, env, listing):
    """Conformance of an install against one agent contract. Returns [] or reasons."""
    bad = []
    over_cap = listing > contract["listing_cap"]
    found = installed_skills(proj)
    agents_md = os.path.join(proj, "AGENTS.md")

    # The receipt must name the agent's own budget whatever the outcome. A run
    # that reports `1539/8000` to an agent whose ceiling is 1200 has told the
    # truth about the listing and lied about the headroom.
    if env["data"].get("listing") != listing:
        bad.append(f"envelope reports listing {env['data'].get('listing')}, "
                   f"measured {listing}")
    if env["data"].get("cap") != contract["listing_cap"]:
        bad.append(f"envelope declares cap {env['data'].get('cap')}, "
                   f"agent's cap is {contract['listing_cap']}")

    if over_cap:
        # Conformance here is a clean refusal. Installing anyway hands the agent
        # a listing it will truncate, and truncation picks which skills exist by
        # byte offset - the failure is silent on both sides.
        if env.get("ok"):
            bad.append(f"listing {listing} exceeds the agent's {contract['listing_cap']} "
                       f"cap and the install reported {env['code']} instead of refusing")
        if found:
            bad.append(f"over the agent's cap, yet {len(found)} SKILL.md are on disk "
                       f"({found[0]}) - the agent loads a truncated set and says nothing")
        if os.path.isfile(agents_md):
            bad.append("over the agent's cap, yet AGENTS.md was written")
        return bad

    if not env.get("ok"):
        bad.append(f"install refused ({env['code']}) inside the agent's cap: {env['summary']}")
    if not found:
        bad.append("no SKILL.md was installed anywhere")
    prefix = contract["skills_dir"] + "/"
    for rel in found:
        if not rel.startswith(prefix):
            bad.append(f"the agent reads {contract['skills_dir']}/, installed at {rel}")
        elif rel[len(prefix):].count("/") != 1:
            bad.append(f"{rel} is not <skills_dir>/<name>/SKILL.md")
        with open(os.path.join(proj, *rel.split("/")), encoding="utf-8") as fh:
            fm = fh.read().split("---")[1]
        for key in contract["rejects"]:
            if re.search(rf"^{re.escape(key)}\s*:", fm, re.M):
                bad.append(f"{rel} carries `{key}:`, a key this agent rejects")

    if contract["requires_agents_md"]:
        if not os.path.isfile(agents_md):
            bad.append("the agent needs the AGENTS.md fallback block; none was written")
        else:
            with open(agents_md, encoding="utf-8") as fh:
                if "keeldocs - agent instructions" not in fh.read():
                    bad.append("AGENTS.md exists without the keeldocs block")
    return bad


def run_control(tmp, listing):
    """Every shipped manifest against today's contract. If this fails, stop."""
    pkg = make_pkg(os.path.join(tmp, "pkg-control"))
    results = {}
    for agent, contract in BASELINE.items():
        proj = os.path.join(tmp, f"proj-control-{agent}")
        env = run_install(pkg, agent, proj)
        results[agent] = validate(contract, proj, env, listing)
    return results


def run_break(tmp, brk, listing):
    agent = brk["agent"]
    contract = dict(BASELINE[agent])
    contract.update(brk["mutate"])

    before = make_pkg(os.path.join(tmp, f"pkg-{brk['id']}-before"))
    proj_before = os.path.join(tmp, f"proj-{brk['id']}-before")
    env_before = run_install(before, agent, proj_before)
    reasons_before = validate(contract, proj_before, env_before, listing)

    after = make_pkg(os.path.join(tmp, f"pkg-{brk['id']}-after"))
    touched_intent = edit_manifest(after, agent, brk["fix"])
    proj_after = os.path.join(tmp, f"proj-{brk['id']}-after")
    env_after = run_install(after, agent, proj_after)
    reasons_after = validate(contract, proj_after, env_after, listing)

    h1, h2 = tree_hashes(before), tree_hashes(after)
    changed = sorted(set(h1) ^ set(h2)) + sorted(
        k for k in set(h1) & set(h2) if h1[k] != h2[k])
    changed = sorted(set(changed))

    if not reasons_before:
        verdict = "VACUOUS"
    elif reasons_after:
        verdict = "UNABSORBED"
    elif changed != [touched_intent]:
        verdict = "UNABSORBED"
    else:
        verdict = "ABSORBED"

    return {
        "id": brk["id"], "agent": agent, "why": brk["why"], "verdict": verdict,
        "breaks_before_fix": reasons_before,
        "still_broken_after_fix": reasons_after,
        "files_changed_by_fix": changed,
        "fix": {k: str(v) for k, v in brk["fix"].items()},
    }


def main():
    ap = argparse.ArgumentParser(description="R7 breaking-agent-API drill")
    ap.add_argument("--json", action="store_true", help="emit one JSON object")
    ap.add_argument("--record", action="store_true",
                    help="append the run to ledger.jsonl (never on a harness run)")
    args = ap.parse_args()

    listing = source_listing()
    tmp = tempfile.mkdtemp(prefix="keeldocs-r7-drill-")
    try:
        control = run_control(tmp, listing)
        if any(control.values()):
            out = {"drill": "r7-break-drill", "verdict": "CONTROL_FAILED",
                   "listing": listing, "control": control, "classes": []}
            code = 2
        else:
            classes = [run_break(tmp, b, listing) for b in BREAKS]
            verdicts = {c["verdict"] for c in classes}
            out = {"drill": "r7-break-drill",
                   "verdict": "ABSORBED" if verdicts == {"ABSORBED"} else "FAILED",
                   "listing": listing, "control": control, "classes": classes}
            code = 0 if verdicts == {"ABSORBED"} else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # The commit the drill ran against, so the ledger line means something later.
    # Read from git, never from a version string that can be stale. `dirty` is
    # not decoration: the drill runs against the WORKING TREE, so a ledger line
    # naming a commit whose tree was modified is a receipt for code that was
    # never that commit.
    rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                         capture_output=True, text=True)
    st = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                        capture_output=True, text=True)
    out["commit"] = rev.stdout.strip() if rev.returncode == 0 else None
    out["dirty"] = bool(st.stdout.strip()) if st.returncode == 0 else None

    if args.record:
        with open(LEDGER, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(out, sort_keys=True) + "\n")

    if args.json:
        print(json.dumps(out, indent=2, sort_keys=True))
    else:
        print(f"R7 breaking-agent-API drill - {out['verdict']} "
              f"(listing {listing} chars, commit {out['commit']})")
        for agent, reasons in sorted(out["control"].items()):
            print(f"  control {agent:<12} {'OK' if not reasons else 'FAILED: ' + reasons[0]}")
        for c in out["classes"]:
            print(f"  {c['verdict']:<11} {c['id']} ({c['agent']})")
            for r in c["breaks_before_fix"]:
                print(f"      broke: {r}")
            for r in c["still_broken_after_fix"]:
                print(f"      STILL BROKEN after the manifest fix: {r}")
            print(f"      fix touched: {', '.join(c['files_changed_by_fix']) or 'nothing'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
