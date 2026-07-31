#!/usr/bin/env python3
"""keeldocs fixture harness - the contribution test bed and CI determinism gate.

For every registered provider fixture:
  1. run the extractor TWICE and require byte-identical stdout (determinism gate)
  2. compare canonicalized output to the committed golden fact file

Also smoke-tests the CLI envelope contract (exit codes + JSON shape).
Exit 0 = all green; 1 = mismatch/failure. No network, no clock, no LLM - by design.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MATRIX = [
    {
        "name": "nestjs-basic / http-endpoints",
        "cmd": [sys.executable, "providers/http-endpoints/nestjs/prototype/extract_nestjs.py",
                "fixtures/nestjs-basic"],
        "golden": "fixtures/nestjs-basic/golden/http-endpoints.json",
    },
    {
        "name": "express-mounts / http-endpoints",
        "cmd": [sys.executable, "providers/http-endpoints/express/prototype/extract_express.py",
                "fixtures/express-mounts"],
        "golden": "fixtures/express-mounts/golden/http-endpoints.json",
    },
    {
        "name": "init-scenario / config-surface",
        "cmd": [sys.executable, "providers/config-surface/env-readers/extract_env.py",
                "fixtures/init-scenario"],
        "golden": "fixtures/init-scenario/golden/env-readers.json",
    },
    {
        "name": "prisma-basic / db-schema",
        "cmd": [sys.executable, "providers/db-schema/prisma/prototype/extract_prisma.py",
                "fixtures/prisma-basic/prisma/schema.prisma"],
        "golden": "fixtures/prisma-basic/golden/db-schema.json",
    },
    {
        "name": "compose-scenario / workspace-layout",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/compose-scenario"],
        "golden": "fixtures/compose-scenario/golden/workspace-layout.json",
    },
    {
        "name": "compose-scenario / services-topology",
        "cmd": [sys.executable, "providers/services-topology/compose/extract_compose.py",
                "fixtures/compose-scenario"],
        "golden": "fixtures/compose-scenario/golden/services-topology.json",
    },
    {
        "name": "symbols-scenario / module-graph",
        "cmd": [sys.executable, "providers/module-graph/ts-imports/extract_symbols.py",
                "fixtures/symbols-scenario"],
        "golden": "fixtures/symbols-scenario/golden/module-graph.json",
    },
    {
        # fixtures are subdirs of THIS repo, not git toplevels - the provider
        # must refuse to report the outer repo's history as the fixture's
        "name": "init-scenario / decision-history (not-a-git-root honesty)",
        "cmd": [sys.executable, "providers/decision-history/git-log/extract_gitlog.py",
                "fixtures/init-scenario"],
        "golden": "fixtures/init-scenario/golden/decision-history.json",
    },
]


def canonical(text):
    return json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))


def run(cmd):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"extractor failed rc={r.returncode}: {r.stderr[-500:]}")
    return r.stdout


def main():
    failures = []
    for case in MATRIX:
        try:
            out1, out2 = run(case["cmd"]), run(case["cmd"])
            if out1 != out2:
                failures.append(f"{case['name']}: NONDETERMINISTIC (two runs differ)")
                continue
            golden = open(os.path.join(ROOT, case["golden"])).read()
            if canonical(out1) != canonical(golden):
                failures.append(f"{case['name']}: output != golden "
                                f"(run `{' '.join(case['cmd'][1:])}` and diff vs {case['golden']})")
                continue
            print(f"  PASS  {case['name']} (deterministic, matches golden)")
        except Exception as e:  # noqa: BLE001 - harness reports, never hides
            failures.append(f"{case['name']}: {e}")

    # ---- check integration: drift-scenario must reproduce the golden report ----
    def run_check(fixture, extra=()):
        return subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "check", "--json", *extra],
                              cwd=os.path.join(ROOT, "fixtures", fixture),
                              capture_output=True, text=True, timeout=180)

    try:
        r1, r2 = run_check("drift-scenario"), run_check("drift-scenario")
        env = json.loads(r1.stdout)
        assert r1.returncode == 1, f"expected exit 1, got {r1.returncode}"
        assert env["code"] == "DRIFT_FOUND" and len(env["summary"]) <= 300
        assert len(r1.stdout) <= 8192, "envelope exceeds 8KB cap"
        if r1.stdout != r2.stdout:
            raise AssertionError("NONDETERMINISTIC envelope (two runs differ)")
        out_dir = os.path.join(ROOT, "fixtures", "drift-scenario", ".keeldocs", "out")
        report_file = [f for f in os.listdir(out_dir) if f.startswith("check-")][0]
        report = json.load(open(os.path.join(out_dir, report_file)))
        report["meta"]["head"] = None  # volatile across commits
        golden = json.load(open(os.path.join(ROOT, "fixtures", "drift-scenario", "golden", "check-report.json")))
        if canonical(json.dumps(report)) != canonical(json.dumps(golden)):
            raise AssertionError("full report != golden/check-report.json (regenerate deliberately if behavior changed)")
        print("  PASS  check integration: drift-scenario (exit 1, all 6 states, matches golden)")
    except Exception as e:
        failures.append(f"check integration drift-scenario: {e}")

    try:
        r = run_check("express-mounts")
        env = json.loads(r.stdout)
        assert r.returncode == 0 and env["code"] == "CLEAN", f"rc={r.returncode} code={env.get('code')}"
        print("  PASS  check integration: express-mounts (clean repo, exit 0)")
    except Exception as e:
        failures.append(f"check integration express-mounts: {e}")

    # ---- init integration: wow loop end-to-end, born-clean, deterministic ----
    import shutil, tempfile
    def run_init_copy():
        tmp = tempfile.mkdtemp(prefix="keeldocs-init-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "init", "--yes", "--json"],
                           cwd=dst, capture_output=True, text=True, timeout=180)
        return tmp, dst, r

    try:
        tmp1, dst1, r1 = run_init_copy()
        env = json.loads(r1.stdout)
        assert r1.returncode == 0 and env["code"] == "INITIALIZED", f"rc={r1.returncode} code={env.get('code')}"
        # generated docs match goldens byte-for-byte
        for rel, golden in [("docs/reference/endpoints.md", "golden/docs/endpoints.md"),
                            ("docs/architecture/data-model.md", "golden/docs/data-model.md"),
                            ("docs/reference/configuration.md", "golden/docs/configuration.md")]:
            got = open(os.path.join(dst1, rel)).read()
            want = open(os.path.join(ROOT, "fixtures", "init-scenario", golden)).read()
            assert got == want, f"{rel} differs from {golden}"
        # init report matches golden (volatile head stripped)
        rep = json.load(open(os.path.join(dst1, ".keeldocs", "out", "init-nogit.json")))
        rep["meta"]["head"] = None
        gold = json.load(open(os.path.join(ROOT, "fixtures", "init-scenario", "golden", "init-report.json")))
        assert canonical(json.dumps(rep)) == canonical(json.dumps(gold)), "init report != golden"
        assert len(rep["lies"]["findings"]) == 4 and rep["coverage"]["after"]["pct"] == 100
        # born-clean invariant: check immediately after init is CLEAN, exit 0
        rc = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "check", "--json"],
                            cwd=dst1, capture_output=True, text=True, timeout=180)
        cenv = json.loads(rc.stdout)
        assert rc.returncode == 0 and cenv["code"] == "CLEAN", "born-clean invariant violated"
        # idempotence: second init in same tree writes nothing, skips both docs
        r1b = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "init", "--yes", "--json"],
                             cwd=dst1, capture_output=True, text=True, timeout=180)
        env1b = json.loads(r1b.stdout)
        assert env1b["data"]["docs"]["written"] == [] and len(env1b["data"]["docs"]["skipped"]) == 3
        # determinism: a second fresh copy produces byte-identical docs
        tmp2, dst2, _ = run_init_copy()
        for rel in ["docs/reference/endpoints.md", "docs/architecture/data-model.md", "docs/reference/configuration.md"]:
            assert open(os.path.join(dst1, rel)).read() == open(os.path.join(dst2, rel)).read(), \
                f"NONDETERMINISTIC init output: {rel}"
        shutil.rmtree(tmp1); shutil.rmtree(tmp2)
        print("  PASS  init integration: init-scenario (4 lies w/ receipts, born-clean, idempotent, deterministic)")
    except Exception as e:
        failures.append(f"init integration: {e}")

    # ---- sync integration: the full retention loop ----
    # Journal writes are CI-guarded by design; the harness explicitly clears CI to
    # simulate the local interactive decisions these steps represent.
    local_env = {**os.environ, "CI": ""}
    KD = os.path.join(ROOT, "bin", "keeldocs.js")
    def kd(cwd, *a, env=None):
        return subprocess.run(["node", KD, *a], cwd=cwd, capture_output=True, text=True,
                              timeout=180, env=env or os.environ)
    try:
        import shutil, tempfile, re as _re
        tmp = tempfile.mkdtemp(prefix="keeldocs-sync-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        assert kd(dst, "init", "--yes", "--json").returncode == 0
        # mutate: new endpoint + new schema column
        app = os.path.join(dst, "app.js")
        src = open(app).read().replace("app.post('/items', (req, res) => res.status(201).end());",
            "app.post('/items', (req, res) => res.status(201).end());\napp.get('/archive', (req, res) => res.json([]));")
        open(app, "w").write(src)
        sch = os.path.join(dst, "prisma", "schema.prisma")
        # NB: read fully BEFORE opening for write - open(x,"w").write(open(x).read())
        # truncates before reading (this exact bug ate the schema in an earlier run)
        sch_src = open(sch).read().replace("  status Status @default(ACTIVE)",
            "  status Status @default(ACTIVE)\n  createdAt DateTime @default(now())")
        open(sch, "w").write(sch_src)
        r = kd(dst, "check", "--json")
        assert r.returncode == 1 and json.loads(r.stdout)["data"]["counts"]["stale"] == 3, "expected 3 stale after mutation"
        r = kd(dst, "sync", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert r.returncode == 1 and env_["code"] == "PROPOSALS" and len(env_["data"]["proposals"]) == 3
        assert all(p["kind"] == "regenerate" for p in env_["data"]["proposals"])
        r = kd(dst, "sync", "--apply-all", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "APPLIED" and len(env_["data"]["applied"]) == 3
        r = kd(dst, "check", "--json")
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "CLEAN", "loop must close: sync -> clean"
        # tamper -> restore
        dm = os.path.join(dst, "docs", "architecture", "data-model.md")
        dm_src = open(dm).read().replace("| name | String |  |", "| name | Text |  |")
        open(dm, "w").write(dm_src)
        r = kd(dst, "sync", "--apply", "db.item.columns", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["applied"][0]["action"] == "restore"
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        # tamper again -> reject -> held (human edit stands; check goes quiet, exit 0)
        dm_src = open(dm).read().replace("| name | String |  |", "| name | Text |  |")
        open(dm, "w").write(dm_src)
        r = kd(dst, "sync", "--reject", "db.item.columns", "--json", env=local_env)
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "DECISION_RECORDED"
        r = kd(dst, "check", "--json")
        c = json.loads(r.stdout)["data"]["counts"]
        assert r.returncode == 0 and c.get("held") == 1 and c["driftTotal"] == 0, "rejection must hold the proposal"
        r = kd(dst, "sync", "--json", env=local_env)
        assert json.loads(r.stdout)["code"] == "NOTHING_TO_SYNC"
        # rebind on a drift-scenario copy
        dst2 = os.path.join(tmp, "rebind")
        shutil.copytree(os.path.join(ROOT, "fixtures", "drift-scenario"), dst2,
                        ignore=shutil.ignore_patterns("golden"))
        r = kd(dst2, "sync", "--apply", "api.create-item", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["applied"][0]["to"] == "fact:http-endpoints/POST /orders"
        assert "binds=fact:http-endpoints/POST /orders " in open(os.path.join(dst2, "docs", "api.md")).read()
        c = json.loads(kd(dst2, "check", "--json").stdout)["data"]["counts"]
        assert c["clean"] == 4 and c["driftTotal"] == 2, "rebound anchor now clean; unrelated drift untouched"
        shutil.rmtree(tmp)
        print("  PASS  sync integration: retention loop (drift->apply->clean), restore, reject->held, rebind")
    except Exception as e:
        failures.append(f"sync integration: {e}")

    # ---- new + slot-write/approve integration: the honesty loop ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-new-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        assert kd(dst, "init", "--yes", "--json").returncode == 0
        # slot-write: good prose accepted, labeled, hash recorded; check stays CLEAN
        good = "The service exposes `/items` for listing and creation and `/health` for liveness."
        r = subprocess.run(["node", KD, "slot-write", "docs/reference/endpoints.md", "api.inventory.overview", "--json"],
                           cwd=dst, input=good, capture_output=True, text=True, env=local_env)
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "SLOT_WRITTEN", r.stdout[:200]
        doc = open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
        assert "Inferred draft" in doc and "hash=h1:" in doc.split("api.inventory.overview")[1][:120]
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", "slot draft must be born clean"
        # bad prose rejected by named gates, file untouched
        bad = "We handle 3 requests via `GhostRouter`."
        r = subprocess.run(["node", KD, "slot-write", "docs/architecture/data-model.md", "db.overview", "--json"],
                           cwd=dst, input=bad, capture_output=True, text=True, env=local_env)
        gates = json.loads(r.stdout)["data"]["gates"]
        assert r.returncode == 1 and any("unresolved-citations" in g for g in gates) and any("numbers-in-prose" in g for g in gates)
        # fill db slot, then facts change -> slot stale -> reprose proposal -> re-prose -> approve -> CLEAN
        ok2 = "Each `Item` carries a `Status` lifecycle."
        r = subprocess.run(["node", KD, "slot-write", "docs/architecture/data-model.md", "db.overview", "--json"],
                           cwd=dst, input=ok2, capture_output=True, text=True, env=local_env)
        assert json.loads(r.stdout)["code"] == "SLOT_WRITTEN"
        # prose-stability: rewording without fact change is rejected
        r = subprocess.run(["node", KD, "slot-write", "docs/architecture/data-model.md", "db.overview", "--json"],
                           cwd=dst, input="Reworded `Item` prose.", capture_output=True, text=True, env=local_env)
        assert r.returncode == 1 and json.loads(r.stdout)["data"]["gate"] == "prose-stability"
        sch = os.path.join(dst, "prisma", "schema.prisma")
        sch_src = open(sch).read().replace("  name   String", "  name   String\n  note   String?")
        open(sch, "w").write(sch_src)
        r = kd(dst, "check", "--json")
        states = {t["id"]: t["state"] for t in json.loads(r.stdout)["data"]["top"]}
        assert states.get("db.overview") == "stale", f"filled slot must go stale on fact change: {states}"
        r = kd(dst, "sync", "--json", env=local_env)
        props = {p["id"]: p["kind"] for p in json.loads(r.stdout)["data"]["proposals"]}
        assert props.get("db.overview") == "reprose", f"stale slot must yield a reprose proposal: {props}"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        r = subprocess.run(["node", KD, "slot-write", "docs/architecture/data-model.md", "db.overview", "--json"],
                           cwd=dst, input="Each `Item` carries a `Status` lifecycle and an optional `note`.",
                           capture_output=True, text=True, env=local_env)
        assert json.loads(r.stdout)["code"] == "SLOT_WRITTEN", r.stdout[:200]
        r = subprocess.run(["node", KD, "approve", "docs/architecture/data-model.md", "db.overview", "--by", "harness", "--json"],
                           cwd=dst, capture_output=True, text=True, env=local_env)
        assert json.loads(r.stdout)["code"] == "APPROVED"
        assert "Reviewed by harness" in open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", "honesty loop must close clean"
        # slot-write refused in CI
        r = subprocess.run(["node", KD, "slot-write", "docs/architecture/data-model.md", "db.overview", "--json"],
                           cwd=dst, input="x", capture_output=True, text=True, env={**os.environ, "CI": "true"})
        assert r.returncode == 2 and "disabled in CI" in json.loads(r.stdout)["summary"]
        # new: adr numbering + NOT_AVAILABLE honesty + EXISTS never-overwrite
        r = kd(dst, "new", "adr", "--title", "Use keeldocs for living docs", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["path"] == "docs/decisions/0001-use-keeldocs-for-living-docs.md"
        r = kd(dst, "new", "adr", "--title", "Second decision", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["number"] == "0002"
        assert json.loads(kd(dst, "new", "system-map", "--json").stdout)["code"] == "NOT_AVAILABLE"
        assert json.loads(kd(dst, "new", "erd", "--json").stdout)["code"] == "EXISTS"
        assert json.loads(kd(dst, "new", "config-reference", "--json").stdout)["code"] == "EXISTS"
        shutil.rmtree(tmp)
        print("  PASS  new/slot-write/approve integration: honesty loop (gates, stability, stale->reprose->attest->clean, CI guard)")
    except Exception as e:
        failures.append(f"new/slot-write integration: {e}")

    # ---- system-map integration: workspace+compose -> owned/external topology ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-sysmap-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "compose-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        # exactly one starter doc: the system map (no endpoints/db/config facts here)
        assert env_["data"]["docs"]["written"] == ["docs/architecture/system-map.md"]
        # coverage counts OWNED services only (2/2): packages + external images excluded
        cov = env_["data"]["coverage"]["after"]
        assert cov["total"] == 2 and cov["pct"] == 100, cov
        assert env_["data"]["lies"] == [] and env_["data"]["liesSuppressed"] >= 1  # prose "npm workspace" suppressed
        got = open(os.path.join(dst, "docs", "architecture", "system-map.md")).read()
        want = open(os.path.join(ROOT, "fixtures", "compose-scenario", "golden", "docs", "system-map.md")).read()
        assert got == want, "system-map.md differs from golden"
        assert "${PG_TAG}" in got, "unresolvable compose interpolation must be preserved verbatim"
        rep = json.load(open(os.path.join(dst, ".keeldocs", "out", "init-nogit.json")))
        rep["meta"]["head"] = None
        gold = json.load(open(os.path.join(ROOT, "fixtures", "compose-scenario", "golden", "init-report.json")))
        assert canonical(json.dumps(rep)) == canonical(json.dumps(gold)), "init report != golden"
        # born clean
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean invariant violated"
        # drift loop: add a service -> ONLY the two service-bound regions go stale
        cf = os.path.join(dst, "docker-compose.yml")
        cf_src = open(cf).read().replace("  redis:", "  mailhog:\n    image: mailhog/mailhog\n  redis:")
        open(cf, "w").write(cf_src)
        r = kd(dst, "check", "--json")
        top = {t["id"]: t["state"] for t in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and top == {"sys.map.diagram": "stale", "sys.map.services": "stale"}, top
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "mailhog" in open(os.path.join(dst, "docs", "architecture", "system-map.md")).read()
        # new: EXISTS on the initialized repo; erd honestly NOT_AVAILABLE (no db facts)
        assert json.loads(kd(dst, "new", "system-map", "--json").stdout)["code"] == "EXISTS"
        assert json.loads(kd(dst, "new", "erd", "--json").stdout)["code"] == "NOT_AVAILABLE"
        shutil.rmtree(tmp)
        print("  PASS  system-map integration: owned/external topology, born-clean, drift loop, verbatim ${VAR}")
    except Exception as e:
        failures.append(f"system-map integration: {e}")

    # ---- symbol identity + S1b re-anchoring: the ADR-007 loop on `ds` anchors ----
    try:
        import shutil, tempfile
        # in place: the ds-bound anchor resolves and is clean
        r = run_check("symbols-scenario")
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "CLEAN", r.stdout[:200]
        # copy: move login() from auth.ts to util.ts (cross-file consolidation, S1b's case)
        tmp = tempfile.mkdtemp(prefix="keeldocs-sym-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "symbols-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        auth = os.path.join(dst, "src", "auth.ts")
        a_src = open(auth).read()
        fn = a_src[a_src.index("export function login"):a_src.index("export function parseToken")]
        open(auth, "w").write(a_src.replace(fn, ""))
        util = os.path.join(dst, "src", "util.ts")
        u_src = open(util).read()
        open(util, "w").write(u_src + "\n" + fn)
        moved = "ds symbols-scenario-fixture . src/util.ts/login()."
        r = kd(dst, "check", "--json")
        top = json.loads(r.stdout)["data"]["top"]
        assert r.returncode == 1 and top[0]["state"] == "dead" and top[0]["candidates"] == [moved], top
        # S1b is proposal-grade: sync proposes the unique same-name candidate with evidence
        r = kd(dst, "sync", "--json", env=local_env)
        props = json.loads(r.stdout)["data"]["proposals"]
        assert props[0]["kind"] == "rebind" and props[0]["candidate"] == moved, props
        assert kd(dst, "sync", "--apply", "auth.login", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert f"binds={moved}" in open(os.path.join(dst, "docs", "auth.md")).read()
        shutil.rmtree(tmp)
        print("  PASS  symbol identity: ds anchors, overload-impl exclusion, move -> S1b rebind -> clean")
    except Exception as e:
        failures.append(f"symbol identity integration: {e}")

    # ---- keeldocs.toml: provider disable respected; bad config fails loud ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-cfg-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        with open(os.path.join(dst, "keeldocs.toml"), "w") as f:
            f.write('[providers]\ndisable = ["prisma"]\n')
        r = kd(dst, "init", "--json")
        env_ = json.loads(r.stdout)
        caps = env_["data"]["card"]["capabilities"]
        assert "db-schema" not in caps, "disabled provider must not even detect"
        assert "docs/architecture/data-model.md" not in env_["data"]["docs"]["planned"]
        # schema-strict config: a typo'd key is a CONFIG error, never a silent no-op
        with open(os.path.join(dst, "keeldocs.toml"), "w") as f:
            f.write('[providers]\ndisabel = ["prisma"]\n')
        r = kd(dst, "check", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 2 and env_["code"] == "CONFIG" and "disabel" in env_["summary"]
        shutil.rmtree(tmp)
        print("  PASS  keeldocs.toml: provider disable honored, typo'd key fails loud (CONFIG, exit 2)")
    except Exception as e:
        failures.append(f"config integration: {e}")

    # ---- decision-history + plan ranking: hotspot x fan-in on a real git repo ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-hot-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        genv = {**os.environ, "GIT_AUTHOR_DATE": "2026-07-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2026-07-01T00:00:00Z"}
        def g(*a, date=None):
            e = dict(genv)
            if date:
                e["GIT_AUTHOR_DATE"] = e["GIT_COMMITTER_DATE"] = date
            r = subprocess.run(["git", "-C", dst, "-c", "user.name=h", "-c", "user.email=h@x", *a],
                               capture_output=True, text=True, env=e)
            assert r.returncode == 0, r.stderr[-200:]
        g("init", "-q")
        g("add", "-A"); g("commit", "-qm", "c1")
        for i, d in enumerate(["2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"]):
            with open(os.path.join(dst, "app.js"), "a") as f:
                f.write(f"\n// churn {i}\n")
            g("add", "-A"); g("commit", "-qm", f"c{i+2}", date=d)
        # dry-run init: every surface undocumented; app.js churn=3 must rank endpoints first
        r = kd(dst, "init", "--json")
        env_ = json.loads(r.stdout)
        assert env_["code"] == "DRY_RUN", r.stdout[:200]
        plan = env_["data"]["plan"]
        # hottest file (app.js, 3 commits) surfaces first: the env var read there
        # and both endpoints tie at score (3+1); cold prisma surfaces trail
        assert plan and plan[0]["hot"]["commits"] == 3, plan[:3]
        assert all(p["hot"]["commits"] == 3 for p in plan[:3]), plan[:3]
        epi = min(i for i, p in enumerate(plan) if p["surface"].startswith("fact:http-endpoints/"))
        dbi = min(i for i, p in enumerate(plan) if p["surface"].startswith("fact:db-schema/"))
        assert epi < dbi, "churn-hot endpoints must outrank cold schema surfaces"
        assert all(p["hot"]["commits"] >= 0 for p in plan)
        shutil.rmtree(tmp)
        print("  PASS  decision-history: HEAD-anchored churn, hotspot x fan-in plan ranking")
    except Exception as e:
        failures.append(f"decision-history integration: {e}")

    # ---- redaction barrier: secret in facts -> [REDACTED] in docs, still born clean ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-redact-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        sch = os.path.join(dst, "prisma", "schema.prisma")
        sch_src = open(sch).read().replace("  status Status @default(ACTIVE)",
            '  status Status @default(ACTIVE)\n  api_key String @default("AKIAABCDEFGHIJKLMNOP")')
        open(sch, "w").write(sch_src)
        r = subprocess.run(["node", KD, "init", "--yes", "--json"], cwd=dst,
                           capture_output=True, text=True, timeout=180)
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and "SECURITY:" in env_["summary"], "redaction must be loud in the envelope"
        assert any(x["rule"] == "aws-access-key" for x in env_["data"]["redactions"])
        dm = open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        assert "[REDACTED:aws-access-key]" in dm and "AKIAABCDEFGHIJKLMNOP" not in dm
        rc = subprocess.run(["node", KD, "check", "--json"], cwd=dst, capture_output=True, text=True, timeout=180)
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", \
            "redacted docs must be born clean (hashes computed post-redaction)"
        shutil.rmtree(tmp)
        print("  PASS  redaction barrier: secret neutralized, envelope loud, born-clean preserved")
    except Exception as e:
        failures.append(f"redaction barrier: {e}")

    # CLI envelope smoke: usage error must be exit 2 with a parseable envelope
    r = subprocess.run(["node", "bin/keeldocs.js", "bogus-command", "--json"],
                       cwd=ROOT, capture_output=True, text=True)
    try:
        env = json.loads(r.stdout)
        assert r.returncode == 2 and env["v"] == 1 and env["code"] == "USAGE"
        assert len(env["summary"]) <= 300
        print("  PASS  CLI envelope smoke (stub exit 2, valid envelope)")
    except Exception:
        failures.append(f"CLI envelope smoke: rc={r.returncode} stdout={r.stdout[:200]!r}")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  FAIL  {f}")
        sys.exit(1)
    print(f"\nAll green: {len(MATRIX)} extractor + 2 check + init + sync + honesty-loop + system-map integrations + envelope smoke.")


if __name__ == "__main__":
    main()
