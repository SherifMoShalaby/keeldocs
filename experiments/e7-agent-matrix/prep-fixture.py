#!/usr/bin/env python3
"""E7 step 2: build a scratch repo whose committed docs are provably lying.

    python3 experiments/e7-agent-matrix/prep-fixture.py <dest>

Copies fixtures/express-mounts, commits it, runs `keeldocs init --yes` so the
docs are anchored and CLEAN, commits that, and THEN seeds drift: `/api/orders`
becomes `/api/purchase-orders`, and `/api/v1/users/:id` is deleted outright.

The order matters and is the whole point. The docs must be born clean and
committed BEFORE the code moves, because E7 is not testing whether an agent can
read a diff - it is testing whether the agent notices, unprompted, that a
document it can see is now false. A repo where the docs were never true proves
nothing.

Leaves the drift COMMITTED, so nothing depends on the agent inspecting the
working tree.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KD = os.path.join(ROOT, "bin", "keeldocs.js")


def run(cmd, cwd, **kw):
    ok = kw.pop("ok", (0,))
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, **kw)
    if r.returncode not in ok:
        print(r.stdout[-2000:] or r.stderr[-2000:])
        raise SystemExit(f"failed ({r.returncode}): {' '.join(cmd)}")
    return r


def git(cwd, *args):
    return run(["git", "-c", "user.email=e7@keeldocs.dev", "-c", "user.name=e7", *args], cwd)


def main(dest):
    dest = os.path.abspath(dest)
    if os.path.exists(dest):
        raise SystemExit(f"{dest} exists - pick a fresh path, this must start clean")
    shutil.copytree(os.path.join(ROOT, "fixtures", "express-mounts"), dest)
    shutil.rmtree(os.path.join(dest, "golden"), ignore_errors=True)

    git(dest, "init", "-q")
    git(dest, "add", "-A")
    git(dest, "commit", "-qm", "the app, before any documentation exists")

    r = run(["node", KD, "init", "--yes", "--json"], dest)
    print("init:", (r.stdout or "").strip()[:300])
    git(dest, "add", "-A")
    git(dest, "commit", "-qm", "docs: keeldocs starter artifacts (born clean)")

    chk = run(["node", KD, "check", "--json"], dest, ok=(0,))
    if '"code":"CLEAN"' not in chk.stdout:
        raise SystemExit("the fixture did not start CLEAN; E7 would be measuring the wrong thing\n" + chk.stdout[:500])
    print("baseline: CLEAN")

    api = os.path.join(dest, "routes", "api.js")
    s = open(api, encoding="utf-8").read().replace("'/orders'", "'/purchase-orders'")
    open(api, "w", encoding="utf-8", newline="\n").write(s)
    os.remove(os.path.join(dest, "routes", "v1.js"))
    v1line = "const v1 = require('./v1');\n"
    s = open(api, encoding="utf-8").read().replace(v1line, "").replace("router.use('/v1', v1);\n", "")
    open(api, "w", encoding="utf-8", newline="\n").write(s)
    git(dest, "add", "-A")
    git(dest, "commit", "-qm", "refactor: rename the orders routes, drop the v1 surface")

    after = run(["node", KD, "check", "--json"], dest, ok=(0, 1))
    print("after seeding:", after.stdout.strip()[:300])
    if '"code":"DRIFT_FOUND"' not in after.stdout:
        raise SystemExit("seeding produced no drift - E7 would pass vacuously")

    print(f"\nready: {dest}")
    print("The committed docs now describe routes that do not exist. Install one")
    print("agent's skills into it and run the two tests in RUNBOOK.md.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
