#!/usr/bin/env python3
"""E7 step 1: install the keeldocs skills into one agent's discovery directory.

    python3 experiments/e7-agent-matrix/install-skills.py <agent> <target-repo>

<agent> is any directory under adapters/ (claude-code, codex, cursor). Everything
this script does is READ FROM adapters/<agent>/manifest.yaml - the install path,
which frontmatter fields that agent chokes on, and whether it also needs the
AGENTS.md fallback block. That is deliberate: if the manifest and the installer
could disagree, the manifest would be documentation rather than configuration,
and E7 would be testing the installer instead of the adapter contract.

Idempotent. Prints what it wrote. Refuses rather than guesses.
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CAP = 8000  # Codex caps the whole skills listing; ADR-010 budget, harness-gated


def load_manifest(path):
    """Flat `key: value` YAML with # comments and [a, b] lists. Nothing else is
    allowed in these manifests, so nothing else is parsed."""
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            k, v = line.split(":", 1)
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                v = [x.strip() for x in v[1:-1].split(",") if x.strip()]
            elif v in ("true", "false"):
                v = v == "true"
            out[k.strip()] = v
    return out


def split_frontmatter(text):
    if not text.startswith("---"):
        raise SystemExit("SKILL.md without frontmatter - refusing to guess")
    _, fm, body = text.split("---", 2)
    return fm.strip("\n").split("\n"), body


def strip_fields(fm_lines, drop):
    kept, removed = [], []
    for line in fm_lines:
        key = line.split(":", 1)[0].strip() if ":" in line else ""
        if key in drop:
            removed.append(key)
        else:
            kept.append(line)
    return kept, removed


def listing_size(skill_dir):
    """What the agent's skill LISTING costs: name + description only. This is the
    number Codex caps, not the file size."""
    total = 0
    for name in sorted(os.listdir(skill_dir)):
        p = os.path.join(skill_dir, name, "SKILL.md")
        if not os.path.isfile(p):
            continue
        fm, _ = split_frontmatter(open(p, encoding="utf-8").read())
        for line in fm:
            if line.split(":", 1)[0].strip() in ("name", "description"):
                total += len(line)
    return total


def main(agent, target):
    manifest_path = os.path.join(ROOT, "adapters", agent, "manifest.yaml")
    if not os.path.isfile(manifest_path):
        have = sorted(os.listdir(os.path.join(ROOT, "adapters")))
        raise SystemExit(f"no adapter for {agent!r}; have: {', '.join(have)}")
    if not os.path.isdir(target):
        raise SystemExit(f"target repo {target!r} does not exist")

    m = load_manifest(manifest_path)
    dest_root = os.path.join(target, m["skills_dir"])
    drop = set(m.get("strip_fields") or [])
    src_root = os.path.join(ROOT, "skills")

    print(f"agent      : {agent}")
    print(f"skills_dir : {m['skills_dir']}")
    print(f"strip      : {', '.join(sorted(drop)) or '(nothing)'}")

    written = 0
    for name in sorted(os.listdir(src_root)):
        src = os.path.join(src_root, name, "SKILL.md")
        if not os.path.isfile(src):
            continue
        fm, body = split_frontmatter(open(src, encoding="utf-8").read())
        kept, removed = strip_fields(fm, drop)
        dest_dir = os.path.join(dest_root, name)
        os.makedirs(dest_dir, exist_ok=True)
        with open(os.path.join(dest_dir, "SKILL.md"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("---\n" + "\n".join(kept) + "\n---" + body)
        # a skill may ship supporting files; carry them verbatim
        for extra in sorted(os.listdir(os.path.join(src_root, name))):
            if extra == "SKILL.md":
                continue
            s = os.path.join(src_root, name, extra)
            d = os.path.join(dest_dir, extra)
            shutil.copytree(s, d, dirs_exist_ok=True) if os.path.isdir(s) else shutil.copy2(s, d)
        written += 1
        note = f"  (stripped {', '.join(removed)})" if removed else ""
        print(f"  wrote {m['skills_dir']}/{name}/SKILL.md{note}")

    size = listing_size(dest_root)
    verdict = "OK" if size <= CAP else "OVER BUDGET"
    print(f"listing    : {size}/{CAP} chars  {verdict}")
    if size > CAP:
        raise SystemExit("skills listing exceeds the Codex cap - shorten descriptions before running E7")

    if m.get("agents_md_block"):
        block = open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read().strip()
        dest = os.path.join(target, "AGENTS.md")
        existing = open(dest, encoding="utf-8").read() if os.path.isfile(dest) else ""
        if "keeldocs - agent instructions" in existing:
            print("  AGENTS.md already carries the keeldocs block - left alone")
        else:
            with open(dest, "a", encoding="utf-8", newline="\n") as fh:
                fh.write(("\n\n" if existing.strip() else "") + block + "\n")
            print("  appended the keeldocs block to AGENTS.md")
    else:
        print("  AGENTS.md not needed (skills are native for this agent)")

    print(f"\n{written} skills installed into {target}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
