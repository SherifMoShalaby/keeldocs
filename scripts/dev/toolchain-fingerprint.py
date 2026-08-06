#!/usr/bin/env python3
"""Does a candidate upgrade signal move where `providerSetHash` did not?

KEEL-10 wants a signal that tells a user "the engine changed under you" so a
pile of `stale` after an upgrade is not indistinguishable from their own code
drifting. The field the ticket names cannot do it: `providerSetHash` is
`sha256(sorted(id@semver) + "|engine:" + major)`, every provider's `semver` is
hand-maintained and nobody bumps it, and the engine term is the major version,
which is `0` for the whole 0.x line. It is byte-identical at every release this
project has made.

The candidate replaces a DECLARATION with the CONTENT it is supposed to stand
for: every committed byte that decides what comes out of extraction - provider
manifests, extractor sources, the pinned extractor runtime (the tree-sitter
grammar versions that decide what every extractor parses), and the engine
modules that turn provider output into facts. It is a pure function of the tree,
which is the constraint that matters: no clock, no network, nothing the `check`
path is forbidden to touch.

Run it with no arguments to reproduce the table in ROADMAP section 3. Pass refs
to compare others. It reads git objects and never checks anything out, so it is
safe to run on a dirty tree - though `HEAD` then means HEAD, not the worktree.

The result to look for is NOT "it moves more often". A signal that fires on
every release regardless of whether any fact could have changed is R1, noise
death, wearing a different hat. What makes this one usable is that it
discriminates: silent across an upgrade that could not move a fact, loud across
one that could.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REFS = ["v0.2.0", "v0.3.0", "v0.4.0", "HEAD"]

# The engine modules that decide what a fact IS. Deliberately not src/drift.js
# or src/check.js: those COMPARE facts, and a change to how a comparison is
# reported is not a change to what the tree says. Deliberately including
# src/hash.js and src/jcs.js, which decide a fact's hash and therefore whether
# an unchanged fact still matches its recorded value.
ENGINE = ("src/facts.js", "src/hash.js", "src/jcs.js", "src/resolve.js",
          "src/scope.js", "src/providers.js")
EXTRACTOR_SUFFIXES = (".py", ".scm", ".mjs", ".js", ".sql")


def git(*args, binary=False):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def tree(ref):
    out = git("ls-tree", "-r", "--name-only", ref)
    if out is None:
        sys.exit(f"no such ref: {ref}")
    return [line for line in out.split("\n") if line]


def blob(ref, path):
    return git("cat-file", "-p", f"{ref}:{path}", binary=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()[:16]


def provider_set_hash(ref):
    """What ships today, recomputed from the ref's own manifests."""
    ids = []
    for path in tree(ref):
        if not re.fullmatch(r"providers/[^/]+/[^/]+/provider\.yaml", path):
            continue
        body = (blob(ref, path) or b"").decode("utf-8", "replace")
        if re.search(r"^status:\s*stub\b", body, re.M):
            continue  # the loader skips it, so the fingerprint must too
        pid = re.search(r"^id:\s*(\S+)", body, re.M)
        semver = re.search(r"^semver:\s*(\S+)", body, re.M)
        if pid and semver:
            ids.append(f"{pid.group(1)}@{semver.group(1)}")
    pkg = json.loads((blob(ref, "package.json") or b"{}").decode())
    major = pkg.get("version", "0.0.0").split(".")[0]
    return digest((",".join(sorted(ids)) + f"|engine:{major}").encode()), len(ids)


def toolchain_fingerprint(ref):
    parts, counted = [], {"manifest": 0, "extractor": 0, "runtime": 0, "engine": 0}
    for path in sorted(tree(ref)):
        if path.startswith("providers/"):
            if path.endswith("provider.yaml"):
                kind = "manifest"
            elif path.endswith("requirements.txt"):
                kind = "runtime"
            elif path.endswith(EXTRACTOR_SUFFIXES):
                kind = "extractor"
            else:
                continue
        elif path in ENGINE:
            kind = "engine"
        else:
            continue
        data = blob(ref, path)
        if data is None:
            continue
        counted[kind] += 1
        parts.append(f"{path}:{digest(data)}")
    # Path AND content, so a rename or a deletion moves it too - a provider
    # removed from the tree changes what comes out just as surely as one edited.
    return digest("\n".join(parts).encode()), counted


def main(refs):
    rows = []
    print(f"{'ref':<10} {'providerSetHash':<18} {'n':>3}  {'toolchain':<18}  files")
    for ref in refs:
        psh, n = provider_set_hash(ref)
        fp, counted = toolchain_fingerprint(ref)
        rows.append((ref, psh, fp))
        print(f"{ref:<10} {psh:<18} {n:>3}  {fp:<18}  "
              + " ".join(f"{k}={v}" for k, v in counted.items()))

    print()
    print(f"providerSetHash: {len({r[1] for r in rows})} distinct value(s) across {len(rows)} refs")
    print(f"toolchain      : {len({r[2] for r in rows})} distinct value(s) across {len(rows)} refs")
    print()
    for prev, cur in zip(rows, rows[1:]):
        changed = git("diff", "--name-only", f"{prev[0]}..{cur[0]}", "--",
                      "providers/", *ENGINE) or ""
        relevant = len([l for l in changed.split("\n") if l])
        print(f"  {prev[0]:>7} -> {cur[0]:<7} "
              f"providerSetHash {'moved' if prev[1] != cur[1] else ' same'}   "
              f"toolchain {'moved' if prev[2] != cur[2] else ' same'}   "
              f"({relevant} extraction-relevant file(s) changed)")
    print()
    print("A row where the toolchain moved and 0 files changed, or did not move")
    print("and some did, is a defect in this script - the two columns are the")
    print("same question asked twice.")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT_REFS)
