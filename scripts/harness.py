#!/usr/bin/env python3
"""keeldocs fixture harness - the contribution test bed and CI determinism gate.

For every registered provider fixture:
  1. run the extractor TWICE and require byte-identical stdout (determinism gate)
  2. compare canonicalized output to the committed golden fact file

Also smoke-tests the CLI envelope contract (exit codes + JSON shape).
Exit 0 = all green; 1 = mismatch/failure. No network, no clock, no LLM - by design.
"""
import json, os, subprocess, sys, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def W(path, text, mode="w"):
    """Fixture writes pin newline="\\n": Windows text mode would inject CRLF
    into files the engine then reads byte-wise - LF is the contract on every
    OS (same reason .gitattributes carries `* -text`)."""
    with open(path, mode, encoding="utf-8", newline="\n") as f:
        f.write(text)


def rmtree(path):
    """Temp-tree cleanup that survives Windows: git object files are read-only
    there and a plain shutil.rmtree dies with WinError 5. chmod-writable first;
    cleanup failure must never fail a test whose asserts already passed."""
    import shutil, stat
    for dp, _dn, fn in os.walk(path):
        for n in fn:
            try:
                os.chmod(os.path.join(dp, n), stat.S_IWRITE | stat.S_IREAD)
            except OSError:
                pass
    shutil.rmtree(path, ignore_errors=True)

MATRIX = [
    {
        # the .scm tier: NO provider code - one query + provider.yaml through
        # the shared runtime, proven output-equivalent to the retired prototype
        "name": "nestjs-basic / http-endpoints (.scm via tsq runtime)",
        "cmd": [sys.executable, "providers/_runtime/tsq.py",
                "providers/http-endpoints/nestjs", "fixtures/nestjs-basic"],
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
        # R1 replay engine: chain -> ephemeral pglite -> catalog introspection
        # (node-exec provider; E13: 10/10 chains byte-identical to real PG 16)
        "name": "replay-scenario / db-schema (sql-replay via pglite)",
        "cmd": ["node", "providers/db-schema/sql-replay/replay.mjs",
                "fixtures/replay-scenario"],
        "golden": "fixtures/replay-scenario/golden/db-schema-replay.json",
    },
    {
        # E9 round-4: the DERIVED PostgREST surface. Input is the recorded
        # upstream db-schema fact file (what the engine hands the provider via
        # the declared ${facts:db-schema} read) plus supabase/config.toml -
        # exercising exposed-schema config, the profile-header path collision,
        # stable-vs-volatile rpc verbs, trigger functions and procedures.
        "name": "postgrest-scenario / http-endpoints (derived from the catalog)",
        "cmd": [sys.executable, "providers/http-endpoints/supabase-postgrest/extract_postgrest.py",
                "fixtures/postgrest-scenario"],
        "env": {"KEELDOCS_FACTS_DB_SCHEMA":
                "fixtures/postgrest-scenario/golden/db-schema-facts.jsonl"},
        "golden": "fixtures/postgrest-scenario/golden/http-endpoints.json",
    },
    {
        # N1: second static db-schema provider - drizzle snapshot parsing
        "name": "conflict-scenario / db-schema (drizzle snapshot)",
        "cmd": [sys.executable, "providers/db-schema/drizzle/extract_drizzle.py",
                "fixtures/conflict-scenario"],
        "golden": "fixtures/conflict-scenario/golden/db-schema-drizzle.json",
    },
    {
        # N2 java: spring via the .scm tier's new member-association mode
        # (E14: 17/17 on spring-petclinic, zero warnings)
        "name": "java-scenario / http-endpoints (spring via tsq, member mode)",
        "cmd": [sys.executable, "providers/_runtime/tsq.py",
                "providers/http-endpoints/spring", "fixtures/java-scenario"],
        "golden": "fixtures/java-scenario/golden/http-endpoints.json",
    },
    {
        # N2 go: gin group-chain resolver (E14: 15/15 on go-gin-example)
        "name": "go-scenario / http-endpoints (gin group chains)",
        "cmd": [sys.executable, "providers/http-endpoints/gin/extract_gin.py",
                "fixtures/go-scenario"],
        "golden": "fixtures/go-scenario/golden/http-endpoints.json",
    },
    {
        "name": "java-scenario / workspace-layout (maven artifactId identity)",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/java-scenario"],
        "golden": "fixtures/java-scenario/golden/workspace-layout.json",
    },
    {
        "name": "go-scenario / workspace-layout (go.mod module identity)",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/go-scenario"],
        "golden": "fixtures/go-scenario/golden/workspace-layout.json",
    },
    {
        "name": "go-scenario / module-graph (go-symbols: dir modules, exported syms)",
        "cmd": [sys.executable, "providers/module-graph/go-symbols/extract_gosymbols.py",
                "fixtures/go-scenario"],
        "golden": "fixtures/go-scenario/golden/module-graph.json",
    },
    {
        "name": "java-scenario / module-graph (java-symbols: package modules, public syms)",
        "cmd": [sys.executable, "providers/module-graph/java-symbols/extract_javasymbols.py",
                "fixtures/java-scenario"],
        "golden": "fixtures/java-scenario/golden/module-graph.json",
    },
    {
        # owner-requested client-routes capability: both react-router idioms
        # (nested JSX trees + createBrowserRouter objects), gaps never guesses
        "name": "react-scenario / client-routes (react-router, both idioms)",
        "cmd": [sys.executable, "providers/client-routes/react-router/extract_routes.py",
                "fixtures/react-scenario"],
        "golden": "fixtures/react-scenario/golden/client-routes.json",
    },
    {
        # E9 field gaps closed: Next.js file-based routes + supabase edge fns
        "name": "next-scenario / client-routes (app router walk)",
        "cmd": [sys.executable, "providers/client-routes/next-routes/extract_next.py",
                "fixtures/next-scenario"],
        "golden": "fixtures/next-scenario/golden/client-routes.json",
    },
    {
        "name": "next-scenario / http-endpoints (supabase edge functions)",
        "cmd": [sys.executable, "providers/http-endpoints/supabase-functions/extract_supafn.py",
                "fixtures/next-scenario"],
        "golden": "fixtures/next-scenario/golden/http-endpoints.json",
    },
    {
        # breadth batch: Django include() graph (probe: wagtail/bakerydemo)
        "name": "django-scenario / http-endpoints (URLconf include graph)",
        "cmd": [sys.executable, "providers/http-endpoints/django/extract_django.py",
                "fixtures/django-scenario"],
        "golden": "fixtures/django-scenario/golden/http-endpoints.json",
    },
    {
        # breadth batch: Rails routes DSL with RESTful expansion
        "name": "rails-routes-scenario / http-endpoints (routes.rb DSL)",
        "cmd": [sys.executable, "providers/http-endpoints/rails/extract_rails.py",
                "fixtures/rails-routes-scenario"],
        "golden": "fixtures/rails-routes-scenario/golden/http-endpoints.json",
    },
    {
        # breadth batch: ASP.NET attribute controllers + minimal APIs
        "name": "aspnet-scenario / http-endpoints (attributes + minimal APIs)",
        "cmd": [sys.executable, "providers/http-endpoints/aspnet/extract_aspnet.py",
                "fixtures/aspnet-scenario"],
        "golden": "fixtures/aspnet-scenario/golden/http-endpoints.json",
    },
    {
        # breadth batch: flutter identity + dart env reads
        "name": "flutter-scenario / workspace-layout (pubspec identity)",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/flutter-scenario"],
        "golden": "fixtures/flutter-scenario/golden/workspace-layout.json",
    },
    {
        "name": "flutter-scenario / config-surface (dart env forms)",
        "cmd": [sys.executable, "providers/config-surface/env-readers/extract_env.py",
                "fixtures/flutter-scenario"],
        "golden": "fixtures/flutter-scenario/golden/env-readers.json",
    },
    {
        # async-messaging (brief 3.1): five transports, one shared scanner
        # runtime - E15 measured 10/10 declared channels on the labeled
        # fixture corpus with the one computed topic held as a gap
        "name": "messaging-scenario / async-messaging (kafka)",
        "cmd": [sys.executable, "providers/async-messaging/kafka/extract_kafka.py",
                "fixtures/messaging-scenario"],
        "golden": "fixtures/messaging-scenario/golden/async-kafka.json",
    },
    {
        "name": "messaging-scenario / async-messaging (sqs-sns)",
        "cmd": [sys.executable, "providers/async-messaging/sqs-sns/extract_sqs.py",
                "fixtures/messaging-scenario"],
        "golden": "fixtures/messaging-scenario/golden/async-sqs-sns.json",
    },
    {
        "name": "messaging-scenario / async-messaging (rabbitmq)",
        "cmd": [sys.executable, "providers/async-messaging/rabbitmq/extract_rabbit.py",
                "fixtures/messaging-scenario"],
        "golden": "fixtures/messaging-scenario/golden/async-rabbitmq.json",
    },
    {
        "name": "messaging-scenario / async-messaging (redis-pubsub)",
        "cmd": [sys.executable, "providers/async-messaging/redis-pubsub/extract_redis.py",
                "fixtures/messaging-scenario"],
        "golden": "fixtures/messaging-scenario/golden/async-redis-pubsub.json",
    },
    {
        "name": "messaging-scenario / async-messaging (supabase-realtime)",
        "cmd": [sys.executable, "providers/async-messaging/supabase-realtime/extract_supabase_rt.py",
                "fixtures/messaging-scenario"],
        "golden": "fixtures/messaging-scenario/golden/async-supabase-realtime.json",
    },
    {
        # N3 variant topology: helm renders DECLARED values only (undeclared
        # ones become explicit <unknown:> + a gap), kustomize reads bases and
        # names overlays as gaps - the Platform veto on silent variants
        "name": "k8s-scenario / services-topology (helm declared-values render)",
        "cmd": [sys.executable, "providers/services-topology/helm/extract_helm.py",
                "fixtures/k8s-scenario"],
        "golden": "fixtures/k8s-scenario/golden/services-helm.json",
    },
    {
        "name": "k8s-scenario / services-topology (kustomize base)",
        "cmd": [sys.executable, "providers/services-topology/kustomize/extract_kustomize.py",
                "fixtures/k8s-scenario"],
        "golden": "fixtures/k8s-scenario/golden/services-kustomize.json",
    },
    {
        # client-routes breadth: angular + vue nested route records through one
        # shared object walker (lazy targets and computed paths stay gaps)
        "name": "ng-scenario / client-routes (angular nested Routes)",
        "cmd": [sys.executable, "providers/client-routes/angular-router/extract_ng.py",
                "fixtures/ng-scenario"],
        "golden": "fixtures/ng-scenario/golden/client-routes.json",
    },
    {
        "name": "vue-scenario / client-routes (vue-router records)",
        "cmd": [sys.executable, "providers/client-routes/vue-router/extract_vue.py",
                "fixtures/vue-scenario"],
        "golden": "fixtures/vue-scenario/golden/client-routes.json",
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
    {
        # replay semantics: 0002 drops-and-replaces a 0001 policy; only the
        # final state may be emitted
        "name": "rls-scenario / db-policies (migration replay)",
        "cmd": [sys.executable, "providers/db-policies/sql-policies/extract_policies.py",
                "fixtures/rls-scenario"],
        "golden": "fixtures/rls-scenario/golden/db-policies.json",
    },
    {
        # v0.2 Python headline: include_router prefix chains resolved (the
        # Express/E1 mount lesson applied to Python)
        "name": "python-scenario / http-endpoints (fastapi)",
        "cmd": [sys.executable, "providers/http-endpoints/fastapi/extract_fastapi.py",
                "fixtures/python-scenario"],
        "golden": "fixtures/python-scenario/golden/http-endpoints.json",
    },
    {
        # __all__ honored, @overload impl sigs excluded (ADR-007 am. 3, Python form)
        "name": "python-scenario / module-graph (py-imports)",
        "cmd": [sys.executable, "providers/module-graph/py-imports/extract_pysymbols.py",
                "fixtures/python-scenario"],
        "golden": "fixtures/python-scenario/golden/module-graph.json",
    },
    {
        "name": "python-scenario / config-surface (os.environ forms)",
        "cmd": [sys.executable, "providers/config-surface/env-readers/extract_env.py",
                "fixtures/python-scenario"],
        "golden": "fixtures/python-scenario/golden/env-readers.json",
    },
    {
        "name": "python-scenario / workspace-layout (pyproject identity)",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/python-scenario"],
        "golden": "fixtures/python-scenario/golden/workspace-layout.json",
    },
]


def canonical(text):
    return json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))



def why(e):
    """A bare `assert x` carries no message; without the line number a failure
    here is a scavenger hunt. Report where it fired, always."""
    tb = traceback.extract_tb(e.__traceback__)
    where = f" [harness.py:{tb[-1].lineno}]" if tb else ""
    return f"{e}{where}"

def canonical_lines(text):
    """A JSONL fact file compared key-order-insensitively, line by line."""
    return [canonical(l) for l in text.splitlines() if l.strip()]


def run(cmd, env=None):
    # `env` supplies the declared cross-capability reads (provider contract 9)
    # that the engine would otherwise hand the provider - a golden case for a
    # derived surface has to stand the upstream fact file up itself.
    child = None
    if env:
        child = dict(os.environ)
        child.update(env)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120, env=child)
    if r.returncode != 0:
        raise RuntimeError(f"extractor failed rc={r.returncode}: {r.stderr[-500:]}")
    return r.stdout


def main():
    failures = []
    for case in MATRIX:
        try:
            env = case.get("env")
            out1, out2 = run(case["cmd"], env), run(case["cmd"], env)
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
            failures.append(f"{case['name']}: {why(e)}")

    # ---- check integration: drift-scenario must reproduce the golden report ----
    def run_check(fixture, extra=()):
        return subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "check", "--json", *extra],
                              cwd=os.path.join(ROOT, "fixtures", fixture),
                              capture_output=True, text=True, timeout=180)

    try:
        import shutil as _sh
        out_dir = os.path.join(ROOT, "fixtures", "drift-scenario", ".keeldocs", "out")
        # one report per HEAD accumulates here across commits in a working tree;
        # clear first so the file we read is THIS run's (a stale pick once let a
        # stale golden pass locally while every clean CI checkout failed)
        _sh.rmtree(out_dir, ignore_errors=True)
        r1, r2 = run_check("drift-scenario"), run_check("drift-scenario")
        env = json.loads(r1.stdout)
        assert r1.returncode == 1, f"expected exit 1, got {r1.returncode}"
        assert env["code"] == "DRIFT_FOUND" and len(env["summary"]) <= 300
        assert len(r1.stdout) <= 8192, "envelope exceeds 8KB cap"
        if r1.stdout != r2.stdout:
            raise AssertionError("NONDETERMINISTIC envelope (two runs differ)")
        files = [f for f in os.listdir(out_dir) if f.startswith("check-")]
        assert len(files) == 1, f"expected exactly one fresh report, found {files}"
        report_file = files[0]
        report = json.load(open(os.path.join(out_dir, report_file)))
        report["meta"]["head"] = None  # volatile across commits
        report["meta"]["providerSetHash"] = None  # cache identity, not golden identity
        golden = json.load(open(os.path.join(ROOT, "fixtures", "drift-scenario", "golden", "check-report.json")))
        if canonical(json.dumps(report)) != canonical(json.dumps(golden)):
            raise AssertionError("full report != golden/check-report.json (regenerate deliberately if behavior changed)")
        print("  PASS  check integration: drift-scenario (exit 1, all 6 states, matches golden)")
    except Exception as e:
        failures.append(f"check integration drift-scenario: {why(e)}")

    try:
        r = run_check("express-mounts")
        env = json.loads(r.stdout)
        assert r.returncode == 0 and env["code"] == "CLEAN", f"rc={r.returncode} code={env.get('code')}"
        print("  PASS  check integration: express-mounts (clean repo, exit 0)")
    except Exception as e:
        failures.append(f"check integration express-mounts: {why(e)}")

    # ---- ADR-003 resolution: two providers claim the same fact id ----
    # express (app.js) and fastapi (main.py) both emit GET /health. Agreement
    # is CORROBORATION: one fact survives, the total order picks the winner's
    # provenance (lex backstop: express < fastapi), and NO conflict record is
    # manufactured. The disagreement path is unit-tested in tests/resolve.test.js.
    try:
        import shutil as _shr
        pg = os.path.join(ROOT, "fixtures", "polyglot-scenario", ".keeldocs")
        _shr.rmtree(os.path.join(pg, "out"), ignore_errors=True)
        r1, r2 = run_check("polyglot-scenario"), run_check("polyglot-scenario")
        assert r1.stdout == r2.stdout, "NONDETERMINISTIC envelope (two runs differ)"
        env = json.loads(r1.stdout)
        assert r1.returncode == 0 and env["code"] == "CLEAN", r1.stdout[:200]
        files = [f for f in os.listdir(os.path.join(pg, "out")) if f.startswith("check-")]
        assert len(files) == 1, files
        rep = json.load(open(os.path.join(pg, "out", files[0])))
        hp = rep["capabilities"]["http-endpoints"]
        assert hp["providers"] == ["express@0.1.0", "fastapi@0.2.0"], hp
        assert "conflicts" not in rep and "conflicts" not in hp, "agreement must not manufacture conflicts"
        assert rep["coverage"]["total"] == 1, rep["coverage"]  # ONE fact, not two
        cache = open(os.path.join(pg, "cache", "facts", "http-endpoints.jsonl")).read()
        assert cache.count("GET /health") == 1 and '"express@0.1.0"' in cache and "fastapi" not in cache, \
            "total order must keep exactly one fact with the winner's provenance"
        print("  PASS  ADR-003 resolution: same-id claims corroborate to ONE fact, deterministic winner")
    except Exception as e:
        failures.append(f"resolution integration: {why(e)}")

    # ---- N1: the first REAL conflict pair (drizzle vs prisma) + the pin ----
    try:
        import shutil as _shc
        cs = os.path.join(ROOT, "fixtures", "conflict-scenario", ".keeldocs")
        _shc.rmtree(cs, ignore_errors=True)
        r1, r2 = run_check("conflict-scenario"), run_check("conflict-scenario")
        assert r1.stdout == r2.stdout, "NONDETERMINISTIC conflict resolution"
        files = [f for f in os.listdir(os.path.join(cs, "out")) if f.startswith("check-")]
        rep = json.load(open(os.path.join(cs, "out", files[0])))
        card = rep["capabilities"]["db-schema"]
        assert card["providers"] == ["drizzle@0.3.0", "prisma@0.1.0"] and card["conflicts"] == 1, card
        c = rep["conflicts"][0]
        assert c["id"] == "fact:db-schema/Item" and c["winner"] == "drizzle@0.3.0" \
            and c["rule"] == "provider-id" and len(c["claims"]) == 2, c
        cache = open(os.path.join(cs, "cache", "facts", "db-schema.jsonl")).read()
        assert cache.count('"fact:db-schema/') == 3, "union: Item (contested) + User + enum.Status"
        assert '"serial"' in cache, "the drizzle claim's attrs must have won"
        # the PIN (keeldocs.toml [resolve]) flips the winner; rule says so
        W(os.path.join(ROOT, "fixtures", "conflict-scenario", "keeldocs.toml"),
          '[resolve]\npin = ["db-schema:prisma"]\n')
        try:
            _shc.rmtree(os.path.join(cs, "out"), ignore_errors=True)
            r = run_check("conflict-scenario")
            files = [f for f in os.listdir(os.path.join(cs, "out")) if f.startswith("check-")]
            rep = json.load(open(os.path.join(cs, "out", files[0])))
            c = rep["conflicts"][0]
            assert c["winner"] == "prisma@0.1.0" and c["rule"] == "pin", c
            item = next(l for l in open(os.path.join(cs, "cache", "facts", "db-schema.jsonl"))
                        if '"fact:db-schema/Item"' in l)
            assert '"Int"' in item and '"serial"' not in item, "pinned provider's attrs must win Item"
            # a pin naming an unknown shape is a CONFIG error, never a no-op
            W(os.path.join(ROOT, "fixtures", "conflict-scenario", "keeldocs.toml"),
              '[resolve]\npin = ["not a valid pin"]\n')
            r = run_check("conflict-scenario")
            assert r.returncode == 2 and json.loads(r.stdout)["code"] == "CONFIG", r.stdout[:200]
        finally:
            os.remove(os.path.join(ROOT, "fixtures", "conflict-scenario", "keeldocs.toml"))
        print("  PASS  N1 conflict pair: drizzle-vs-prisma conflict recorded, union kept, pin flips winner")
    except Exception as e:
        failures.append(f"conflict integration: {why(e)}")

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
        rep["meta"]["providerSetHash"] = None
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
        rmtree(tmp1); rmtree(tmp2)
        print("  PASS  init integration: init-scenario (4 lies w/ receipts, born-clean, idempotent, deterministic)")
    except Exception as e:
        failures.append(f"init integration: {why(e)}")

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
        W(app, src)
        sch = os.path.join(dst, "prisma", "schema.prisma")
        # NB: read fully BEFORE opening for write - open(x,"w").write(open(x).read())
        # truncates before reading (this exact bug ate the schema in an earlier run)
        sch_src = open(sch).read().replace("  status Status @default(ACTIVE)",
            "  status Status @default(ACTIVE)\n  createdAt DateTime @default(now())")
        W(sch, sch_src)
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
        W(dm, dm_src)
        r = kd(dst, "sync", "--apply", "db.item.columns", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["applied"][0]["action"] == "restore"
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        # tamper again -> reject -> held (human edit stands; check goes quiet, exit 0)
        dm_src = open(dm).read().replace("| name | String |  |", "| name | Text |  |")
        W(dm, dm_src)
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
        rmtree(tmp)
        print("  PASS  sync integration: retention loop (drift->apply->clean), restore, reject->held, rebind")
    except Exception as e:
        failures.append(f"sync integration: {why(e)}")

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
        W(sch, sch_src)
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
        rmtree(tmp)
        print("  PASS  new/slot-write/approve integration: honesty loop (gates, stability, stale->reprose->attest->clean, CI guard)")
    except Exception as e:
        failures.append(f"new/slot-write integration: {why(e)}")

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
        rep["meta"]["providerSetHash"] = None
        gold = json.load(open(os.path.join(ROOT, "fixtures", "compose-scenario", "golden", "init-report.json")))
        assert canonical(json.dumps(rep)) == canonical(json.dumps(gold)), "init report != golden"
        # born clean
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean invariant violated"
        # drift loop: add a service -> ONLY the two service-bound regions go stale
        cf = os.path.join(dst, "docker-compose.yml")
        cf_src = open(cf).read().replace("  redis:", "  mailhog:\n    image: mailhog/mailhog\n  redis:")
        W(cf, cf_src)
        r = kd(dst, "check", "--json")
        top = {t["id"]: t["state"] for t in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and top == {"sys.map.diagram": "stale", "sys.map.services": "stale"}, top
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "mailhog" in open(os.path.join(dst, "docs", "architecture", "system-map.md")).read()
        # new: EXISTS on the initialized repo; erd honestly NOT_AVAILABLE (no db facts)
        assert json.loads(kd(dst, "new", "system-map", "--json").stdout)["code"] == "EXISTS"
        assert json.loads(kd(dst, "new", "erd", "--json").stdout)["code"] == "NOT_AVAILABLE"
        rmtree(tmp)
        print("  PASS  system-map integration: owned/external topology, born-clean, drift loop, verbatim ${VAR}")
    except Exception as e:
        failures.append(f"system-map integration: {why(e)}")

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
        W(auth, a_src.replace(fn, ""))
        util = os.path.join(dst, "src", "util.ts")
        u_src = open(util).read()
        W(util, u_src + "\n" + fn)
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
        rmtree(tmp)
        print("  PASS  symbol identity: ds anchors, overload-impl exclusion, move -> S1b rebind -> clean")
    except Exception as e:
        failures.append(f"symbol identity integration: {why(e)}")

    # ---- keeldocs.toml: provider disable respected; bad config fails loud ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-cfg-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        W(os.path.join(dst, "keeldocs.toml"), '[providers]\ndisable = ["prisma"]\n')
        r = kd(dst, "init", "--json")
        env_ = json.loads(r.stdout)
        caps = env_["data"]["card"]["capabilities"]
        # since R1 the registry always carries sql-replay; with prisma disabled
        # and no migration dirs here, db-schema must be HONESTLY ABSENT (empty
        # card entry), never extracted-by-someone-else
        assert caps["db-schema"] == {"status": "absent", "providers": []}, caps["db-schema"]
        assert "docs/architecture/data-model.md" not in env_["data"]["docs"]["planned"]
        # schema-strict config: a typo'd key is a CONFIG error, never a silent no-op
        W(os.path.join(dst, "keeldocs.toml"), '[providers]\ndisabel = ["prisma"]\n')
        r = kd(dst, "check", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 2 and env_["code"] == "CONFIG" and "disabel" in env_["summary"]
        rmtree(tmp)
        print("  PASS  keeldocs.toml: provider disable honored, typo'd key fails loud (CONFIG, exit 2)")
    except Exception as e:
        failures.append(f"config integration: {why(e)}")

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
        g("init", "-q"); g("config", "core.autocrlf", "false")  # hermetic EOLs: ignore machine autocrlf
        g("add", "-A"); g("commit", "-qm", "c1")
        for i, d in enumerate(["2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"]):
            W(os.path.join(dst, "app.js"), f"\n// churn {i}\n", "a")
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
        rmtree(tmp)
        print("  PASS  decision-history: HEAD-anchored churn, hotspot x fan-in plan ranking")
    except Exception as e:
        failures.append(f"decision-history integration: {why(e)}")

    # ---- RLS static surface: policies render, born clean, drift is surgical ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-rls-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "rls-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        # coverage counts policies as concrete surfaces (rls flags excluded)
        assert env_["data"]["coverage"]["after"]["pct"] == 100, env_["data"]["coverage"]
        # pure-SQL supabase repo since R1: tables come from sql-replay, so the
        # ERD golden carries real catalog types; no prisma -> no config doc
        got = open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        want = open(os.path.join(ROOT, "fixtures", "rls-scenario", "golden", "docs", "data-model.md")).read()
        assert got == want, "data-model.md differs from golden"
        caps = env_["data"]["card"]["capabilities"]
        assert caps["db-schema"]["providers"] == ["sql-replay@0.4.0"], caps["db-schema"]
        dm = open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        assert "notes_all" not in dm, "dropped policy must not survive the replay"
        assert "notes_owner_rw" in dm and "RLS enabled on `public.orders`" in dm
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean invariant violated"
        # a new tightening migration must stale ONLY db.policies
        W(os.path.join(dst, "supabase", "migrations", "0003_restrict.sql"),
          # must be REPLAYABLE sql since R1: the engine executes migrations now,
          # and a policy naming a nonexistent column fails the whole chain
          "drop policy notes_admin_read on notes;\n"
          "create policy notes_admin_read on notes for select to admin using (body is not null);\n")
        r = kd(dst, "check", "--json")
        top = {t["id"]: t["state"] for t in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and top == {"db.policies": "stale"}, top
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        rmtree(tmp)
        print("  PASS  RLS static surface: replay, policy table, born-clean, surgical drift loop")
    except Exception as e:
        failures.append(f"rls integration: {why(e)}")

    # ---- Python end-to-end: FastAPI docs born clean, drift loop, ds symbols ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-py-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "python-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        caps = env_["data"]["card"]["capabilities"]
        assert caps["http-endpoints"]["providers"] == ["fastapi@0.2.0"], caps["http-endpoints"]
        # first multi-provider capability: both symbol providers serve module-graph
        assert sorted(caps["module-graph"]["providers"]) == ["py-imports@0.2.1", "ts-imports@0.2.0"], caps["module-graph"]
        assert env_["data"]["coverage"]["after"] == {} or env_["data"]["coverage"]["after"]["pct"] == 100
        for rel, gold in [("docs/reference/endpoints.md", "endpoints.md"),
                          ("docs/reference/configuration.md", "configuration.md")]:
            got = open(os.path.join(dst, rel)).read()
            want = open(os.path.join(ROOT, "fixtures", "python-scenario", "golden", "docs", gold)).read()
            assert got == want, f"{rel} differs from golden"
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean invariant violated"
        # python ds identities exist with the overload rule applied
        mg = open(os.path.join(dst, ".keeldocs", "cache", "facts", "module-graph.jsonl")).read()
        assert '"ds python-scenario-fixture . app/tokens.py/parse()."' in mg
        assert mg.count("def parse ( ") == 2, "overload impl sig must be excluded"
        # contract 9: the declared ${facts:workspace-layout} read reached the
        # extractor - run it standalone WITH the env var and see real packages
        wl = os.path.join(dst, ".keeldocs", "cache", "facts", "workspace-layout.jsonl")
        r = subprocess.run([sys.executable,
            os.path.join(ROOT, "providers", "module-graph", "py-imports", "extract_pysymbols.py"), dst],
            capture_output=True, text=True, env={**os.environ, "KEELDOCS_FACTS_WORKSPACE_LAYOUT": wl})
        assert r.returncode == 0 and '"package": "python-scenario-fixture"' in r.stdout, \
            "env-delivered fact file must yield real package names"
        r = subprocess.run([sys.executable,
            os.path.join(ROOT, "providers", "module-graph", "py-imports", "extract_pysymbols.py"), dst],
            capture_output=True, text=True, env={k: v for k, v in os.environ.items()
                                                 if k != "KEELDOCS_FACTS_WORKSPACE_LAYOUT"})
        assert '"package": null' in r.stdout, "standalone runs must degrade honestly to null"
        # drift loop: add a route -> endpoints table stale -> sync -> clean
        us = os.path.join(dst, "app", "routers", "users.py")
        u_src = open(us).read()
        W(us, u_src + "\n\n@router.get(\"/users/{uid}\")\ndef get_user(uid: int) -> dict:\n    return {}\n")
        r = kd(dst, "check", "--json")
        top = {t_["id"]: t_["state"] for t_ in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and top == {"api.inventory.table": "stale"}, top
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "/api/v1/users/{uid}" in open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
        rmtree(tmp)
        print("  PASS  python end-to-end: fastapi mounts, ds symbols w/ overload rule, born-clean, drift loop")
    except Exception as e:
        failures.append(f"python integration: {why(e)}")

    # ---- noise instruments: self-caused scoping, one-keystroke apply, throttle ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-noise-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "python-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        genv = {**os.environ, "GIT_AUTHOR_DATE": "2026-07-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2026-07-01T00:00:00Z"}
        def g(*a):
            r = subprocess.run(["git", "-C", dst, "-c", "user.name=h", "-c", "user.email=h@x", *a],
                               capture_output=True, text=True, env=genv)
            assert r.returncode == 0, r.stderr[-200:]
        g("init", "-q"); g("config", "core.autocrlf", "false"); g("add", "-A"); g("commit", "-qm", "base")
        assert kd(dst, "init", "--yes", "--json").returncode == 0
        g("add", "-A"); g("commit", "-qm", "docs")
        # PRE-EXISTING drift, committed before the mark: new env read in items.py
        W(os.path.join(dst, "app", "routers", "items.py"), '\nimport os\nITEMS_FLAG = os.getenv("ITEMS_FLAG")\n', "a")
        g("add", "-A"); g("commit", "-qm", "pre-existing drift")
        g("branch", "mark")
        # SELF-caused drift, uncommitted: a new route in users.py
        W(os.path.join(dst, "app", "routers", "users.py"), '\n\n@router.get("/users/{uid}")\ndef get_user(uid: int) -> dict:\n    return {}\n', "a")
        r = kd(dst, "check", "--json", "--since", "mark")
        env_ = json.loads(r.stdout)
        c = env_["data"]["counts"]
        assert r.returncode == 1 and c["driftTotal"] == 2 and c["selfCaused"] == 1, c
        by = {t_["id"]: t_.get("selfCaused") for t_ in env_["data"]["top"]}
        assert by == {"api.inventory.table": True, "config.reference.table": False}, by
        # sync --self scopes to the one self-caused proposal; one keystroke fixes it
        r = kd(dst, "sync", "--self", "mark", "--json", env=local_env)
        props = [p["id"] for p in json.loads(r.stdout)["data"]["proposals"]]
        assert props == ["api.inventory.table"], props
        r = kd(dst, "sync", "--self", "mark", "--apply-all", "--json", env=local_env)
        assert json.loads(r.stdout)["code"] == "APPLIED"
        r = kd(dst, "check", "--json", "--since", "mark")
        c = json.loads(r.stdout)["data"]["counts"]
        assert c["driftTotal"] == 1 and c["selfCaused"] == 0, c
        # the apply was journaled -> accept-rate signal; then 3 rejections flip quiet
        noise = json.loads(kd(dst, "check", "--json").stdout)["data"]["noise"]
        assert noise["applies30d"] >= 1 and noise["nudgeLevel"] == "normal", noise
        rej = subprocess.run(["node", "-e",
            "import(process.argv[1]).then(j=>{const now=new Date().toISOString();"
            "j.appendDecisions(process.argv[2],[1,2,3].map(i=>({at:now,actor:'h',type:'rejection',target:'r'+i})))})",
            # file:// URL, not a path: import() rejects C:\ paths on Windows
            __import__("pathlib").Path(ROOT, "src", "journal.js").as_uri(), dst],
            capture_output=True, text=True, env=local_env)
        assert rej.returncode == 0, rej.stderr[-200:]
        noise = json.loads(kd(dst, "check", "--json").stdout)["data"]["noise"]
        assert noise["rejections30d"] == 3 and noise["nudgeLevel"] == "quiet", noise
        # --self with no resolvable base fails LOUDLY (no origin here)
        r = kd(dst, "sync", "--self", "--json", env=local_env)
        assert r.returncode == 2 and "no base ref" in json.loads(r.stdout)["summary"]
        rmtree(tmp)
        print("  PASS  noise instruments: self-caused split, sync --self, applied journal, quiet throttle")
    except Exception as e:
        failures.append(f"noise instruments: {why(e)}")

    # ---- re-anchoring pipeline: S1+S2 auto-rebind gate, S2-only stays proposal ----
    try:
        import shutil, tempfile
        genv = {**os.environ, "GIT_AUTHOR_DATE": "2026-07-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2026-07-01T00:00:00Z"}
        def mk_repo():
            tmp = tempfile.mkdtemp(prefix="keeldocs-reanchor-")
            dst = os.path.join(tmp, "repo")
            shutil.copytree(os.path.join(ROOT, "fixtures", "symbols-scenario"), dst,
                            ignore=shutil.ignore_patterns("golden", ".keeldocs"))
            def g(*a):
                r = subprocess.run(["git", "-C", dst, "-c", "user.name=h", "-c", "user.email=h@x", *a],
                                   capture_output=True, text=True, env=genv)
                assert r.returncode == 0, r.stderr[-200:]
            g("init", "-q"); g("config", "core.autocrlf", "false"); g("add", "-A"); g("commit", "-qm", "base")
            return tmp, dst, g
        # CASE 1 - file move: S1 rename + S2 exact + unique => AUTO-rebind in --apply-all
        tmp, dst, g = mk_repo()
        g("mv", "src/auth.ts", "src/identity.ts")
        moved = "ds symbols-scenario-fixture . src/identity.ts/login()."
        r = kd(dst, "sync", "--json", env=local_env)
        props = json.loads(r.stdout)["data"]["proposals"]
        assert props and props[0]["kind"] == "rebind" and props[0]["candidate"] == moved, props
        assert "S1 file-rename" in props[0]["evidence"] and "S2 signature exact" in props[0]["evidence"]
        assert props[0].get("auto") is True and props[0]["signals"] == {"s1": True, "s2": "exact", "s1b": True}, props[0]
        r = kd(dst, "sync", "--apply-all", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert env_["code"] == "APPLIED" and env_["data"]["applied"][0]["action"] == "rebind", env_["data"]
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert f"binds={moved}" in open(os.path.join(dst, "docs", "auth.md")).read()
        jl = open(os.path.join(dst, ".keeldocs", "decisions.jsonl")).read()
        assert '"type":"rebind"' in jl, "auto-rebind must be journaled (the log that makes it reversible)"
        rmtree(tmp)
        # CASE 2 - in-place rename: S2-exact alone is ONE signal => proposal, never auto
        tmp, dst, g = mk_repo()
        a = os.path.join(dst, "src", "auth.ts")
        src_a = open(a).read().replace("export function login(", "export function signIn(")
        W(a, src_a)
        r = kd(dst, "sync", "--json", env=local_env)
        props = json.loads(r.stdout)["data"]["proposals"]
        assert props and props[0]["kind"] == "rebind", props
        assert props[0]["candidate"].endswith("src/auth.ts/signIn()."), props[0]
        assert props[0]["signals"] == {"s2": "exact"} and props[0].get("auto") is None, props[0]
        r = kd(dst, "sync", "--apply-all", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["applied"] == [], "one signal must NOT auto-apply"
        r = kd(dst, "sync", "--apply", "auth.login", "--json", env=local_env)
        assert json.loads(r.stdout)["data"]["applied"][0]["action"] == "rebind"
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        rmtree(tmp)
        print("  PASS  re-anchoring: file-move auto-rebind (S1+S2, journaled), in-place rename stays human-choice")
    except Exception as e:
        failures.append(f"re-anchoring: {why(e)}")

    # ---- live-Postgres via tbls: opt-in, declared-beats-live, CI-guarded ----
    try:
        import shutil, tempfile
        # canned extractor: deterministic double-run + golden (no db, no network)
        cmd = [sys.executable, "providers/db-schema/tbls-live/extract_tbls.py", "."]
        cenv = {**os.environ, "KEELDOCS_TBLS_JSON":
                os.path.join(ROOT, "fixtures", "live-scenario", "tbls-schema.json")}
        o1 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=cenv)
        o2 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=cenv)
        assert o1.returncode == 0 and o1.stdout == o2.stdout, "canned tbls run must be deterministic"
        gold = open(os.path.join(ROOT, "fixtures", "live-scenario", "golden", "db-schema-live.json")).read()
        assert canonical(o1.stdout) == canonical(gold), "canned tbls output != golden"
        tmp = tempfile.mkdtemp(prefix="keeldocs-live-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "live-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        lenv = {**local_env, "KEELDOCS_TBLS_JSON": os.path.join(dst, "tbls-schema.json")}
        # default (no --live): live provider must not run at all
        r = kd(dst, "check", "--json", env=lenv)
        caps = json.loads(kd(dst, "init", "--json", env=lenv).stdout)["data"]["card"]["capabilities"]
        assert caps["db-schema"]["providers"] == ["prisma@0.1.0"], caps["db-schema"]
        # --live: tbls facts land; declared-beats-live skips public.item; view skipped
        r = kd(dst, "init", "--live", "--yes", "--json", env=lenv)
        env_ = json.loads(r.stdout)
        assert r.returncode == 0, r.stdout[:300]
        assert sorted(env_["data"]["card"]["capabilities"]["db-schema"]["providers"]) == \
            ["prisma@0.1.0", "tbls-live@0.2.1"]
        dm = open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        assert "public.orders" in dm and "public.users" in dm and "Item" in dm
        assert "public.item" not in dm, "declared-beats-live must skip the shadowed table"
        assert "order_totals" not in dm, "views are not ERD surface"
        # born clean UNDER --live (live-initialized docs need live checks - documented)
        rc = kd(dst, "check", "--live", "--json", env=lenv)
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", rc.stdout[:300]
        # CI guard: --live refused when CI is set
        r = kd(dst, "check", "--live", "--json", env={**lenv, "CI": "true"})
        assert r.returncode == 2 and "disabled in CI" in json.loads(r.stdout)["summary"]
        # env-named DSN: without the canned seam AND without the named env var, fail loud, name the VAR
        r = kd(dst, "check", "--live", "--json",
               env={k: v for k, v in lenv.items() if k not in ("KEELDOCS_TBLS_JSON", "LIVE_DB_URL")})
        env_ = json.loads(r.stdout)
        assert r.returncode == 2 and "LIVE_DB_URL is not set" in env_["summary"], env_["summary"]
        rmtree(tmp)
        print("  PASS  live-Postgres (tbls): opt-in only, declared-beats-live, CI guard, env-named DSN")
    except Exception as e:
        failures.append(f"live integration: {why(e)}")

    # ---- replay engine end-to-end: pure-SQL repo -> ERD -> drift loop ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-replay-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "replay-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        assert env_["data"]["card"]["capabilities"]["db-schema"]["providers"] == ["sql-replay@0.4.0"]
        dm = open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        assert "public.users" in dm and "public.posts" in dm and "public.orders" in dm, "replayed tables must render"
        assert "order_status" in dm, "replayed enum must render"
        # R4: routines are catalog objects, and the PostgREST surface is DERIVED
        assert "## Database functions" in dm and "public.nearby_pickup_points" in dm, \
            "replayed routines must render"
        ep = open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
        assert "`/rest/v1/orders`" in ep, "every exposed table answers at /rest/v1/<relation>"
        assert "| GET | `/rest/v1/rpc/nearby_pickup_points`" in ep, "a STABLE function is GET-able"
        assert "| POST | `/rest/v1/rpc/claim_order`" in ep, "a VOLATILE function is POST-only"
        assert "| GET | `/rest/v1/rpc/claim_order`" not in ep, "...and must not claim GET"
        assert "/rest/v1/rpc/touch_updated_at" not in ep, "PostgREST never exposes trigger functions"
        assert "postgrest-catalog: `fact:db-schema/public.orders`" in ep, \
            "a derived endpoint names the fact it came from instead of inventing a file"
        rep = json.load(open([os.path.join(dst, ".keeldocs", "out", f)
                              for f in os.listdir(os.path.join(dst, ".keeldocs", "out"))
                              if f.startswith("init-")][0]))
        assert "## Views" in dm and "public.order_totals" in dm, "views are modeled, not a gap"
        assert "PK" in dm, "the ER diagram marks primary keys"
        assert "| PUT | `/rest/v1/orders`" in ep, "a KEYED table answers PUT"
        assert "| PUT | `/rest/v1/event_log`" not in ep, "a table with no primary key does not"
        assert "| GET | `/rest/v1/order_stats`" in ep and \
               "| POST | `/rest/v1/order_stats`" not in ep, "a materialized view is read-only"
        assert "| POST | `/rest/v1/order_totals`" not in ep, "an aggregate view is not auto-updatable"
        assert "| POST | `/rest/v1/open_orders`" in ep, "...but a simple one is, and the catalog says so"
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean invariant violated"
        # the derived surface closes its own drift loop: a new function is a new
        # endpoint AND a new routine row, and sync must repair both
        W(os.path.join(dst, "supabase", "migrations", "0006_rpc.sql"),
          "create function public.cancel_order(p_order_id bigint) returns boolean\n"
          "language sql volatile as $$ select p_order_id > 0 $$;\n")
        assert kd(dst, "check", "--json").returncode == 1, "a new routine must drift the docs"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "| POST | `/rest/v1/rpc/cancel_order`" in \
            open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
        assert "public.cancel_order" in \
            open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        # drift loop: a NEW migration changes the catalog -> db docs stale -> sync -> clean
        W(os.path.join(dst, "supabase", "migrations", "0004_archive.sql"),
          "create table archives (id serial primary key, order_id integer references orders(id));\n")
        r = kd(dst, "check", "--json")
        assert r.returncode == 1, "new migration must drift the ERD"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "public.archives" in open(os.path.join(dst, "docs", "architecture", "data-model.md")).read()
        rmtree(tmp)
        print("  PASS  replay engine: chain -> catalog ERD, born-clean, migration drift loop closes")
    except Exception as e:
        failures.append(f"replay integration: {why(e)}")

    # ---- R4: the derived PostgREST surface, config-driven and honest ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-postgrest-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "postgrest-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "INITIALIZED", r.stdout[:300]
        # the committed golden fact file IS the provider's contract input; if the
        # db-schema payload shape moves, this end-to-end run diverges from it
        live = open(os.path.join(dst, ".keeldocs", "cache", "facts", "db-schema.jsonl")).read()
        recorded = open(os.path.join(ROOT, "fixtures", "postgrest-scenario",
                                     "golden", "db-schema-facts.jsonl")).read()
        assert canonical_lines(live) == canonical_lines(recorded), \
            "postgrest-scenario/golden/db-schema-facts.jsonl is stale - re-record it"
        ep = open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
        for verb in ("GET", "POST", "PATCH", "DELETE"):
            assert f"| {verb} | `/rest/v1/profiles`" in ep, f"exposed tables answer {verb}"
        assert "| PUT | `/rest/v1/profiles`" in ep, "a keyed table answers PUT"
        assert "| PUT | `/rest/v1/ride_events`" not in ep, "a keyless one does not"
        assert "| GET | `/rest/v1/ride_counts`" in ep and \
               "| PATCH | `/rest/v1/ride_counts`" not in ep, "an aggregate view is GET-only"
        assert "| PATCH | `/rest/v1/active_rides`" in ep, "an auto-updatable view is writable"
        assert "| GET | `/rest/v1/rpc/search_rides`" in ep and \
               "| POST | `/rest/v1/rpc/search_rides`" in ep, "a STABLE rpc answers both"
        assert "| GET | `/rest/v1/rpc/claim_ride`" not in ep, "a VOLATILE rpc is POST-only"
        assert "/rest/v1/rpc/rebuild_stats" not in ep, "procedures are named as a gap, never guessed"
        rep = json.load(open([os.path.join(dst, ".keeldocs", "out", f)
                              for f in os.listdir(os.path.join(dst, ".keeldocs", "out"))
                              if f.startswith("init-")][0]))
        kinds = {g["kind"] for g in rep.get("extractionGaps", [])}
        assert "procedure-unmodeled" in kinds and "schema-profile-ambiguous" in kinds, \
            "a CALL-able procedure and a two-schema path collision are reported, not resolved by guessing"
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", "born-clean violated"
        # turning the REST API off in config removes the whole surface
        W(os.path.join(dst, "supabase", "config.toml"),
          open(os.path.join(dst, "supabase", "config.toml")).read().replace(
              "enabled = true", "enabled = false", 1))
        assert kd(dst, "check", "--json").returncode == 1, "disabling the API must drift the inventory"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert "/rest/v1/" not in open(os.path.join(dst, "docs", "reference", "endpoints.md")).read(), \
            "[api] enabled=false means there is no REST surface to document"
        rmtree(tmp)
        print("  PASS  PostgREST surface: derived endpoints, config-driven exposure, gaps named, drift loop closes")
    except Exception as e:
        failures.append(f"postgrest integration: {why(e)}")

    # ---- recipe migration: a doc that predates a section gets it, losslessly ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-upgrade-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "replay-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        assert kd(dst, "init", "--yes", "--json").returncode == 0
        dm_path = os.path.join(dst, "docs", "architecture", "data-model.md")

        def strip_functions_section():
            """Rewind the doc to what an EARLIER recipe would have produced, and
            leave the two kinds of human byte a delete-and-regenerate destroys."""
            t = open(dm_path).read()
            i = t.index("## Database functions")
            j = t.index("<!-- /keeldocs:gen -->", i) + len("<!-- /keeldocs:gen -->\n\n")
            t = t[:i] + t[j:]
            t = t.replace("<!-- /keeldocs:slot -->", "HUMAN SLOT PROSE.\n<!-- /keeldocs:slot -->", 1)
            t = t.replace("<!-- Human notes below this line are never touched by keeldocs. -->",
                          "<!-- Human notes below this line are never touched by keeldocs. -->"
                          "\n\n## Field notes\n\nHUMAN TAIL PROSE.", 1)
            W(dm_path, t)

        strip_functions_section()
        # DISCOVERY, not a verdict: an older doc is not stale, not lying, not
        # drift - check must stay green and still make the fix findable
        r = kd(dst, "check", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "CLEAN", "a doc older than the recipe is NOT drift"
        assert [u["id"] for u in env_["data"]["upgrades"]] == ["db.functions"], env_["data"]
        assert "keeldocs sync --upgrade" in env_["next"], "the fix must be findable from check"

        r = kd(dst, "sync", "--upgrade", "--json")
        assert r.returncode == 1 and json.loads(r.stdout)["code"] == "UPGRADES_AVAILABLE"
        r = kd(dst, "sync", "--upgrade", "--apply-all", "--json")
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "UPGRADED", r.stdout[:300]
        after = open(dm_path).read()
        assert "## Database functions" in after and "public.nearby_pickup_points" in after
        assert "HUMAN SLOT PROSE." in after and "HUMAN TAIL PROSE." in after, \
            "the whole point: not one human byte is lost"
        assert after.index("## Enums") < after.index("## Database functions") \
            < after.index("## Access control (RLS)"), "inserted in RECIPE order, not appended"
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", \
            "an inserted section is born clean"
        assert json.loads(kd(dst, "sync", "--upgrade", "--json").stdout)["code"] == "NOTHING_TO_UPGRADE"

        # a recorded decision not to have the section is respected
        strip_functions_section()
        assert kd(dst, "sync", "--upgrade", "--reject", "db.functions", "--json",
                  env=local_env).returncode == 0
        r = kd(dst, "sync", "--upgrade", "--apply-all", "--json")
        assert json.loads(r.stdout)["code"] == "NOTHING_TO_UPGRADE", r.stdout[:200]
        assert "## Database functions" not in open(dm_path).read(), "a rejection holds"

        # a same-path document keeldocs did not generate is never written to
        os.remove(os.path.join(dst, ".keeldocs", "decisions.jsonl"))
        hand = "# Data model\n\nSomebody else wrote this. No markers anywhere.\n"
        W(dm_path, hand)
        r = kd(dst, "sync", "--upgrade", "--apply-all", "--json")
        assert json.loads(r.stdout)["code"] == "NOTHING_TO_UPGRADE"
        assert open(dm_path).read() == hand, "ownership proof is the root anchor, and it refuses"
        rmtree(tmp)
        print("  PASS  recipe migration: older doc gains the section in recipe order, zero human bytes lost")
    except Exception as e:
        failures.append(f"upgrade integration: {why(e)}")

    # ---- N2: java + go end-to-end (born clean, drift loop closes) ----
    try:
        import shutil, tempfile
        for fx, mut, newpath in [
            ("java-scenario",
             ("src/main/java/demo/HealthController.java",
              '    @GetMapping("/health")',
              '    @GetMapping("/health")\n    public String h2() { return "x"; }\n\n    @GetMapping("/ready")'),
             "/ready"),
            ("go-scenario",
             ("main.go", '\tr.GET("/health", health)',
              '\tr.GET("/health", health)\n\tr.GET("/ready", ready)'),
             "/ready"),
        ]:
            tmp = tempfile.mkdtemp(prefix=f"keeldocs-{fx[:4]}-")
            dst = os.path.join(tmp, "repo")
            shutil.copytree(os.path.join(ROOT, "fixtures", fx), dst,
                            ignore=shutil.ignore_patterns("golden", ".keeldocs"))
            r = kd(dst, "init", "--yes", "--json")
            env_ = json.loads(r.stdout)
            assert r.returncode == 0 and env_["code"] == "INITIALIZED", (fx, r.stdout[:200])
            eps = open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
            assert "/health" in eps or "/owners" in eps, (fx, "endpoints doc must render")
            rc = kd(dst, "check", "--json")
            assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", (fx, "born-clean violated")
            rel, needle, repl = mut
            srcp = os.path.join(dst, rel)
            W(srcp, open(srcp).read().replace(needle, repl))
            r = kd(dst, "check", "--json")
            assert r.returncode == 1, (fx, "new endpoint must drift the docs")
            assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
            assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", (fx, "loop must close")
            assert newpath in open(os.path.join(dst, "docs", "reference", "endpoints.md")).read()
            rmtree(tmp)
        print("  PASS  N2 java+go: spring member-mode + gin chains, born-clean, drift loops close")
    except Exception as e:
        failures.append(f"java/go integration: {why(e)}")

    # ---- N3 variant topology: helm + kustomize, unknowns never guessed ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-k8s-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "k8s-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        assert sorted(env_["data"]["card"]["capabilities"]["services-topology"]["providers"]) == \
            ["helm@0.3.0", "kustomize@0.3.0"]
        smap = open(os.path.join(dst, "docs", "architecture", "system-map.md")).read()
        for node in ("rides-api", "rides-worker", "notifier"):
            assert node in smap, f"{node} must appear in the map"
        assert "ghcr.io/acme/rides-api:1.4.0" in smap, "declared values must render"
        assert "<unknown:.Values.worker.image>" in smap, \
            "an UNDECLARED value must stay explicitly unknown in the doc, never guessed"
        rep = json.load(open([os.path.join(dst, ".keeldocs", "out", f)
                              for f in os.listdir(os.path.join(dst, ".keeldocs", "out"))
                              if f.startswith("init-")][0]))
        kinds = {g["kind"] for g in rep.get("extractionGaps", [])}
        assert any("undeclared value" in k for k in kinds), "undeclared values must be named gaps"
        assert any("overlay" in k for k in kinds), "overlays must be named, never silently rendered"
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean violated"
        # declaring the missing value resolves the unknown and drifts the map
        W(os.path.join(dst, "chart", "values.yaml"),
          open(os.path.join(dst, "chart", "values.yaml")).read().replace(
              "worker:\n  enabled: true", "worker:\n  enabled: true\n  image: ghcr.io/acme/worker:9.9.9"))
        r = kd(dst, "check", "--json")
        assert r.returncode == 1, "declaring a value must drift the rendered map"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        smap = open(os.path.join(dst, "docs", "architecture", "system-map.md")).read()
        assert "ghcr.io/acme/worker:9.9.9" in smap and "<unknown:.Values.worker.image>" not in smap
        rmtree(tmp)
        print("  PASS  N3 variant topology: helm declared-values render, kustomize base, unknowns explicit")
    except Exception as e:
        failures.append(f"variant topology integration: {why(e)}")

    # ---- async-messaging + data-flow recipe: labeled corpus, born clean ----
    try:
        import shutil, tempfile
        # E15 gate against the committed ground truth: every DECLARED channel
        # found, none invented, the computed one held as a gap
        truth = open(os.path.join(ROOT, "fixtures", "messaging-scenario", "GROUND_TRUTH.md")).read()
        expected = {l.split("|")[3].strip() for l in truth.splitlines()
                    if l.startswith("|") and l.count("|") >= 5 and "---" not in l
                    and not l.startswith("| transport")}
        tmp = tempfile.mkdtemp(prefix="keeldocs-msg-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "messaging-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:200]
        assert env_["data"]["docs"]["written"] == ["docs/architecture/data-flow.md"]
        # channels joined the denominator (owner decision) and the data-flow
        # recipe documents them, so init still lands at 100%
        cov = env_["data"]["coverage"]["after"]
        assert cov["perCapability"]["async-messaging"]["total"] == 10 and cov["pct"] == 100, cov
        assert sorted(env_["data"]["card"]["capabilities"]["async-messaging"]["providers"]) == [
            "kafka@0.3.0", "rabbitmq@0.3.0", "redis-pubsub@0.3.0", "sqs-sns@0.3.0",
            "supabase-realtime@0.3.0"], "all five transports resolve into ONE capability"
        cache = open(os.path.join(dst, ".keeldocs", "cache", "facts", "async-messaging.jsonl")).read()
        got = {json.loads(l)["payload"]["attrs"]["name"] for l in cache.splitlines() if l.strip()}
        assert got == expected, f"recall/precision vs GROUND_TRUTH: missing {expected - got}, invented {got - expected}"
        rep = json.load(open([os.path.join(dst, ".keeldocs", "out", f)
                              for f in os.listdir(os.path.join(dst, ".keeldocs", "out"))
                              if f.startswith("init-")][0]))
        assert any("non-literal topic" in g["kind"] for g in rep.get("extractionGaps", [])), \
            "the computed topic must be a named gap, never a guessed name"
        flow = open(os.path.join(dst, "docs", "architecture", "data-flow.md")).read()
        assert "```mermaid" in flow and "publishes" in flow and "delivers" in flow
        rc = kd(dst, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean violated"
        # drift loop: a new topic stales ONLY the data-flow regions
        W(os.path.join(dst, "src", "events.ts"),
          '\nexport const extra = () => producer.send({ topic: "audit.trail", messages: [] });\n', "a")
        r = kd(dst, "check", "--json")
        top = {t["id"] for t in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and top == {"flow.diagram", "flow.channels"}, top
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        assert "audit.trail" in open(os.path.join(dst, "docs", "architecture", "data-flow.md")).read()
        rmtree(tmp)
        print("  PASS  async-messaging: 10/10 labeled channels, gap held, data-flow born clean, drift loop closes")
    except Exception as e:
        failures.append(f"async-messaging integration: {why(e)}")

    # ---- next-scenario end-to-end: file-based routes + edge fns land ----
    try:
        import shutil as _shn
        ns = os.path.join(ROOT, "fixtures", "next-scenario", ".keeldocs")
        _shn.rmtree(ns, ignore_errors=True)
        r = run_check("next-scenario")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "CLEAN", r.stdout[:200]
        files = [f for f in os.listdir(os.path.join(ns, "out")) if f.startswith("check-")]
        rep = json.load(open(os.path.join(ns, "out", files[0])))
        assert rep["capabilities"]["client-routes"]["providers"] == ["next-routes@0.3.0"]
        assert rep["coverage"]["perCapability"]["client-routes"]["total"] == 5, rep["coverage"]
        assert "supabase-functions@0.3.0" in rep["capabilities"]["http-endpoints"]["providers"]
        cr = open(os.path.join(ns, "cache", "facts", "client-routes.jsonl")).read()
        assert cr.count('"fact:client-routes/') == 5 and '"/owners/[ownerId]/edit"' in cr
        ep = open(os.path.join(ns, "cache", "facts", "http-endpoints.jsonl")).read()
        assert '"fact:http-endpoints/POST /functions/v1/accept-ride"' in ep
        print("  PASS  next-scenario: app-router routes + edge-function endpoints extracted")
    except Exception as e:
        failures.append(f"next-scenario integration: {why(e)}")

    # ---- client-routes end-to-end: facts land, coverage denominator untouched ----
    try:
        import shutil as _shx
        rs = os.path.join(ROOT, "fixtures", "react-scenario", ".keeldocs")
        _shx.rmtree(rs, ignore_errors=True)
        r = run_check("react-scenario")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "CLEAN", r.stdout[:200]
        files = [f for f in os.listdir(os.path.join(rs, "out")) if f.startswith("check-")]
        rep = json.load(open(os.path.join(rs, "out", files[0])))
        assert rep["capabilities"]["client-routes"]["providers"] == ["react-router@0.3.0"]
        cache = open(os.path.join(rs, "cache", "facts", "client-routes.jsonl")).read()
        assert cache.count('"fact:client-routes/') == 9, "both idioms, composed and deduped"
        assert '"/owners/:ownerId/edit"' in cache and '"/admin/users/:uid"' in cache
        # owner decision 2026-08-01: routes COUNT, and the screens inventory
        # makes them documentable - a counted-but-undocumentable surface would
        # be an unreachable metric
        assert rep["coverage"]["perCapability"]["client-routes"]["total"] == 9, rep["coverage"]
        assert any(g["kind"] == "non-literal Route path" for g in rep["extractionGaps"]), \
            "the computed path must be an honest gap"
        print("  PASS  client-routes: react-router idioms extracted, coverage denominator untouched")
    except Exception as e:
        failures.append(f"client-routes integration: {why(e)}")

    # ---- interview: cap-5 cards from engine state, resumable, journal-verified ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-iv-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "drift-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        r1 = kd(dst, "interview", "--json", env=local_env)
        r2 = kd(dst, "interview", "--json", env=local_env)
        assert r1.stdout == r2.stdout, "NONDETERMINISTIC interview batch"
        env_ = json.loads(r1.stdout)
        assert r1.returncode == 0 and env_["code"] == "INTERVIEW", r1.stdout[:200]
        cards = env_["data"]["cards"]
        assert len(cards) == 5 and env_["truncated"] is True, "cap 5 must bind (6 candidates here)"
        assert env_["data"]["budget"]["chars"] <= 6000, env_["data"]["budget"]
        assert cards[0]["kind"] == "removal" and cards[1]["kind"] == "removal", \
            "dead bindings outrank document-next cards"
        q1 = open(os.path.join(dst, ".keeldocs", "interview", "queue.yaml")).read()
        # confirm a removal -> tombstone rides the EXISTING drift semantic
        rm = cards[0]
        r = kd(dst, "answer", rm["qid"], "confirm", "--by", "harness", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert env_["code"] == "DECISION_RECORDED" and env_["data"]["effects"] == [f"tombstone {rm['subject']}"], env_
        c = json.loads(kd(dst, "check", "--json").stdout)["data"]["counts"]
        assert c.get("intentionally_removed") == 1, c
        # reject a document card -> journaled interview-reject, never re-asked
        doc_card = next(x for x in cards if x["kind"] == "document")
        r = kd(dst, "answer", doc_card["qid"], "reject", "--by", "harness", "--json", env=local_env)
        assert json.loads(r.stdout)["code"] == "DECISION_RECORDED"
        jl = open(os.path.join(dst, ".keeldocs", "decisions.jsonl")).read()
        assert '"type":"tombstone"' in jl and '"type":"interview-reject"' in jl, \
            "both decisions must be journal-verified"
        r = kd(dst, "interview", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        qids = [x["qid"] for x in env_["data"]["cards"]]
        assert rm["qid"] not in qids and doc_card["qid"] not in qids, "settled cards must never re-ask"
        # unknown keeps the card open (re-asked), CI guard refuses answer
        r = kd(dst, "answer", qids[0], "unknown", "--by", "harness", "--json", env=local_env)
        assert json.loads(r.stdout)["code"] == "DECISION_RECORDED"
        r = kd(dst, "interview", "--json", env=local_env)
        assert qids[0] in [x["qid"] for x in json.loads(r.stdout)["data"]["cards"]], "unknown must re-ask"
        r = kd(dst, "answer", qids[0], "confirm", "--json", env={**os.environ, "CI": "true"})
        assert r.returncode == 2 and "disabled in CI" in json.loads(r.stdout)["summary"]
        r = kd(dst, "answer", qids[0], "bogus", "--json", env=local_env)
        assert r.returncode == 2 and json.loads(r.stdout)["code"] == "USAGE"
        # resumable purely from committed files: queue regenerates deterministically
        q2 = open(os.path.join(dst, ".keeldocs", "interview", "queue.yaml")).read()
        assert q1 != q2 and "progress:" in q2, "queue export must track the answered state"
        rmtree(tmp)
        print("  PASS  interview: cap-5 batch, tombstone/reject effects journaled, resumable, CI-guarded")
    except Exception as e:
        failures.append(f"interview integration: {why(e)}")

    # ---- R3+R4: module guide, onboarding-verify classes, mine -> rationale ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-r34-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "python-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        # module guide: deterministic skeleton, born clean, one prose slot
        r = kd(dst, "new", "module-guide", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "CREATED", r.stdout[:200]
        mg = open(os.path.join(dst, env_["data"]["path"])).read()
        assert "keeldocs:slot" in mg and "## Public surface" in mg and "## Module dependencies" in mg
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", "module guide must be born clean"
        # a stale guide must be REPAIRABLE, not just reportable (its regions had
        # no sync-time renderer once - reported stale, never fixable)
        W(os.path.join(dst, "app", "routers", "extra.py"),
          "from app.routers import users  # new import edge\n")
        r = kd(dst, "check", "--json")
        assert r.returncode == 1, "a new module must stale the guide"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", \
            "module-guide drift loop must CLOSE (regions renderable at sync time)"
        # onboarding-verify: make-claim + version-claim fire with receipts
        W(os.path.join(dst, "Makefile"), "serve:\n\tuvicorn app.main:app\n")
        pj = json.load(open(os.path.join(dst, "package.json"))) if os.path.exists(os.path.join(dst, "package.json")) else {"name": "x", "private": True}
        pj["engines"] = {"node": ">=20"}
        W(os.path.join(dst, "package.json"), json.dumps(pj, indent=2) + "\n")
        os.makedirs(os.path.join(dst, "docs", "guides"), exist_ok=True)
        W(os.path.join(dst, "docs", "guides", "setup.md"),
          "# Setup\n\nYou need node 18 or newer installed.\n\nRun `make dev` then `make serve`.\n")
        r = kd(dst, "init", "--json", env=local_env)
        lies = {(x["class"], x["claim"]) for x in json.loads(r.stdout)["data"]["lies"]}
        assert ("make-claim", "make dev") in lies, lies
        assert ("version-claim", "node 18") in lies, lies
        assert ("make-claim", "make serve") not in lies, "existing target must not fire"
        # mine -> rationale cards -> reject is journaled and never re-asked
        genv = {**os.environ, "GIT_AUTHOR_DATE": "2026-07-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2026-07-01T00:00:00Z"}
        def g(*a):
            rr = subprocess.run(["git", "-C", dst, "-c", "user.name=h", "-c", "user.email=h@x", *a],
                                capture_output=True, text=True, env=genv)
            assert rr.returncode == 0, rr.stderr[-200:]
        g("init", "-q"); g("config", "core.autocrlf", "false")
        g("add", "-A"); g("commit", "-qm", "base import")
        W(os.path.join(dst, "app", "main.py"), "\n# retry tuning\n", "a")
        g("add", "-A"); g("commit", "-qm", "fix: cap retries at 3 after the 07-12 incident")
        r = kd(dst, "mine", "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert env_["code"] == "MINED" and env_["data"]["candidates"] >= 1, r.stdout[:200]
        r = kd(dst, "interview", "--json", env=local_env)
        cards = json.loads(r.stdout)["data"]["cards"]
        rat = [c for c in cards if c["kind"] == "rationale"]
        assert rat and "cap retries at 3" in rat[0]["question"], cards[:2]
        r = kd(dst, "answer", rat[0]["qid"], "reject", "--by", "harness", "--json", env=local_env)
        assert json.loads(r.stdout)["code"] == "DECISION_RECORDED"
        r = kd(dst, "interview", "--json", env=local_env)
        assert rat[0]["qid"] not in [c["qid"] for c in json.loads(r.stdout)["data"]["cards"]], \
            "rejected rationale must never re-ask"
        rmtree(tmp)
        print("  PASS  R3+R4: module guide born clean, make/version lie classes, mine -> rationale -> reject holds")
    except Exception as e:
        failures.append(f"R3/R4 integration: {why(e)}")

    # ---- E10 red-team: T2 refusals + marker-forgery neutralized (doc 11 R2) ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-e10-")
        author = os.path.join(tmp, "author"); os.makedirs(author)
        prov = os.path.join(author, "acme-schema"); os.makedirs(prov)
        W(os.path.join(prov, "provider.yaml"),
          "id: acme-schema\ncapability: db-schema\nsemver: 1.0.0\ntier: code\n"
          "entry: ./extract.py\ndetect: { files: [\"acme.schema\"] }\ninputs: [\"**/*.schema\"]\ntimeout_class: A\nemits: [table]\n")
        W(os.path.join(prov, "extract.py"),
          "import json\nprint(json.dumps({\"models\": [{\"name\": \"Gadget\", \"fields\": "
          "[{\"name\": \"id\", \"type\": \"Int\"}]}], \"enums\": []}))\n")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        W(os.path.join(dst, "acme.schema"), "gadget\n")
        # 1) unsigned add -> REFUSED, exit 2, nothing installed
        r = kd(dst, "provider", "add", prov, "--json", env=local_env)
        assert r.returncode == 2 and json.loads(r.stdout)["code"] == "REFUSED", r.stdout[:200]
        assert "unsigned" in json.loads(r.stdout)["data"]["refusal"]
        assert not os.path.exists(os.path.join(dst, ".keeldocs", "providers")), "refusal must install nothing"
        # 2) signed but UNTRUSTED signer -> REFUSED
        r = kd(author, "provider", "keygen", "--json", env=local_env)
        pub = json.loads(r.stdout)["data"]["publicKeyB64"]
        key = os.path.join(author, "keeldocs-signing-key.pem")
        assert kd(author, "provider", "sign", prov, "--key", key, "--signer", "acme", "--json",
                  env=local_env).returncode == 0
        r = kd(dst, "provider", "add", prov, "--json", env=local_env)
        assert r.returncode == 2 and "not trusted" in json.loads(r.stdout)["data"]["refusal"]
        # 3) trust the signer -> VERIFIED, but installation still needs consent
        assert kd(dst, "provider", "trust", "acme", pub, "--json", env=local_env).returncode == 0
        r = kd(dst, "provider", "add", prov, "--json", env=local_env)
        env_ = json.loads(r.stdout)
        assert r.returncode == 1 and env_["code"] == "CONSENT_REQUIRED", r.stdout[:200]
        assert not os.path.exists(os.path.join(dst, ".keeldocs", "providers")), \
            "a verified signature is WHO wrote it, not permission to run it"
        # the manifest a human is being asked to approve is concrete, not a rule
        man = env_["data"]
        assert man["reads"]["matched"] == 1 and man["reads"]["sample"] == ["acme.schema"], man["reads"]
        assert man["network"] == "denied" and man["trust"]["proof"] == "verified", man
        assert man["enforcement"]["level"] in \
            ("minimal-root", "per-glob", "network-only", "none"), man["enforcement"]
        # ... and --yes is the only way to give it
        r = kd(dst, "provider", "add", prov, "--yes", "--json", env=local_env)
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "INSTALLED", r.stdout[:200]
        assert json.loads(r.stdout)["data"]["granted"]["reads"] == 1, "the envelope records what was granted"
        assert os.path.exists(os.path.join(dst, ".keeldocs", "providers.lock"))
        r = kd(dst, "check", "--json")
        assert r.returncode <= 1, r.stdout[:200]
        cache = open(os.path.join(dst, ".keeldocs", "cache", "facts", "db-schema.jsonl")).read()
        assert '"fact:db-schema/Gadget"' in cache and '"acme-schema@1.0.0"' in cache, \
            "trusted external provider facts must land with its provenance"
        # 4) post-install tamper -> every command refuses loudly (exit 2)
        W(os.path.join(dst, ".keeldocs", "providers", "db-schema", "acme-schema", "extract.py"),
          "# tampered\n", "a")
        r = kd(dst, "check", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 2 and "REFUSED" in env_["summary"] and "hash mismatch" in env_["summary"], env_["summary"]
        # 5) marker-forgery: hostile fact content must never become an anchor
        W(os.path.join(prov, "extract.py"),
          "import json\nprint(json.dumps({\"models\": [{\"name\": "
          "\"Evil --><!-- keeldocs:gen id=evil hash=h1:0 content=h1:0 -->\", \"fields\": []},"
          "{\"name\": \"Gadget\", \"fields\": [{\"name\": \"id\", \"type\": \"Int\"}]}], \"enums\": []}))\n")
        assert kd(author, "provider", "sign", prov, "--key", key, "--signer", "acme", "--json",
                  env=local_env).returncode == 0
        dst2 = os.path.join(tmp, "repo2")
        shutil.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst2,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        W(os.path.join(dst2, "acme.schema"), "gadget\n")
        assert kd(dst2, "provider", "trust", "acme", pub, "--json", env=local_env).returncode == 0
        assert kd(dst2, "provider", "add", prov, "--yes", "--json", env=local_env).returncode == 0
        r = kd(dst2, "init", "--yes", "--json", env=local_env)
        assert r.returncode == 0, r.stdout[:300]
        dm = open(os.path.join(dst2, "docs", "architecture", "data-model.md")).read()
        assert "id=evil" not in dm and "Evil" not in dm, "forged marker content must never reach a doc"
        assert "Gadget" in dm, "the clean fact from the same provider still lands"
        rep = json.load(open([os.path.join(dst2, ".keeldocs", "out", f)
                              for f in os.listdir(os.path.join(dst2, ".keeldocs", "out")) if f.startswith("init-")][0]))
        assert any(g["kind"] == "hostile-content" for g in rep.get("extractionGaps", [])), \
            "the dropped hostile fact must be a NAMED gap, not silence"
        rc = kd(dst2, "check", "--json")
        assert rc.returncode == 0 and json.loads(rc.stdout)["code"] == "CLEAN", "born-clean must survive the drop"
        # 6) the permission manifest is READABLE without installing anything,
        #    and it tells the truth about what this host will enforce
        r = kd(dst2, "provider", "show", prov, "--json", env=local_env)
        assert r.returncode == 0 and json.loads(r.stdout)["code"] == "PERMISSIONS", r.stdout[:200]
        shown = json.loads(r.stdout)["data"]
        assert shown["id"] == "acme-schema" and shown["reads"]["globs"] == ["**/*.schema"], shown
        human = kd(dst2, "provider", "show", prov, env=local_env)
        assert human.returncode == 0
        for word in ("RUNS", "READS", "NETWORK", "WITHHELD", "TRUST", "SANDBOX"):
            assert word in human.stdout, f"the consent screen must name {word}: {human.stdout[:300]}"
        # a secret matching a provider's globs is named as WITHHELD, by path
        W(os.path.join(dst2, "secrets.schema"), "x\n")
        W(os.path.join(dst2, ".env"), "DB_PASSWORD=hunter2\n")
        wide = os.path.join(tmp, "wide")
        shutil.copytree(prov, wide)
        W(os.path.join(wide, "provider.yaml"),
          open(os.path.join(wide, "provider.yaml")).read().replace('inputs: ["**/*.schema"]',
                                                                   'inputs: ["**/*"]'))
        r = kd(dst2, "provider", "show", wide, "--json", env=local_env)
        w = json.loads(r.stdout)["data"]
        assert ".env" in w["withheld"]["sample"], \
            f"a provider asking for the world must be SHOWN what it will not get: {w['withheld']}"
        assert ".env" not in w["reads"]["sample"] and w["reads"]["matched"] > 0
        rmtree(tmp)
        print("  PASS  E10 red-team: unsigned/untrusted/tampered all REFUSED; marker forgery dropped as a named gap")
    except Exception as e:
        failures.append(f"E10 trust red-team: {why(e)}")

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
        W(sch, sch_src)
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
        rmtree(tmp)
        print("  PASS  redaction barrier: secret neutralized, envelope loud, born-clean preserved")
    except Exception as e:
        failures.append(f"redaction barrier: {why(e)}")

    # ---- skill lint (E7's runnable slice): ADR-010 budget caps, structurally ----
    try:
        total_listing = 0
        skill_dirs = sorted(os.path.join("skills", d) for d in os.listdir(os.path.join(ROOT, "skills")))
        for sd in skill_dirs:
            sp = os.path.join(ROOT, sd, "SKILL.md")
            assert os.path.exists(sp), f"{sd}: missing SKILL.md"
            text = open(sp, encoding="utf-8").read()
            assert text.startswith("---"), f"{sd}: missing frontmatter"
            fm = text.split("---", 2)[1]
            fields = dict(l.split(":", 1) for l in fm.strip().split("\n") if ":" in l)
            assert "name" in fields and "description" in fields, f"{sd}: frontmatter needs name+description"
            desc = fields["description"].strip()
            assert len(desc) <= 1536, f"{sd}: description {len(desc)} chars > 1536 (Claude truncation cap)"
            total_listing += len(fields["name"]) + len(desc)
            assert len(text) <= 20000, f"{sd}: SKILL.md {len(text)} chars - keep well under compaction budgets"
        assert total_listing <= 8000, f"skills listing {total_listing} chars > 8000 (Codex listing cap)"
        print(f"  PASS  skill lint: {len(skill_dirs)} skills within ADR-010 budgets (listing {total_listing}/8000)")
    except Exception as e:
        failures.append(f"skill lint: {why(e)}")

    # ---- package-scoped fact identity: a monorepo guide describes ITS package ----
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-mono-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "mono-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        assert kd(dst, "init", "--yes", "--json").returncode == 0
        for pkg, slug in [("@acme/web", "acme-web"), ("@acme/api", "acme-api")]:
            r = kd(dst, "new", "module-guide", "--package", pkg, "--json")
            assert r.returncode == 0 and json.loads(r.stdout)["code"] == "CREATED", r.stdout[:200]
        web = open(os.path.join(dst, "docs", "reference", "modules", "acme-web.md")).read()
        api = open(os.path.join(dst, "docs", "reference", "modules", "acme-api.md")).read()
        # the bind is ONE short token however many endpoints the package has -
        # the 200-char cap is why enumeration was never an option
        assert "binds=pkg:@acme/web#http-endpoints/*" in web, web[:400]
        assert "binds=pkg:@acme/api#http-endpoints/*" in api
        # and each guide describes only its own package
        assert "/web/home" in web and "/api/orders" not in web, "a guide must not claim another package's surface"
        assert "/api/orders" in api and "/web/home" not in api
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN", "born-clean per package"
        # DRIFT ISOLATION - the whole point. Touch web; api must stay clean.
        W(os.path.join(dst, "packages", "web", "src", "app.js"),
          "\napp.get('/web/settings', (req, res) => res.end());\n", "a")
        r = kd(dst, "check", "--json")
        stale = {t_["id"] for t_ in json.loads(r.stdout)["data"]["top"]}
        assert r.returncode == 1 and "mod.acme-web.surface" in stale, stale
        assert "mod.acme-api.surface" not in stale, \
            "editing one package must NOT stale another package's guide - the defect this closes"
        assert kd(dst, "sync", "--apply-all", "--json", env=local_env).returncode == 0
        assert json.loads(kd(dst, "check", "--json").stdout)["code"] == "CLEAN"
        web2 = open(os.path.join(dst, "docs", "reference", "modules", "acme-web.md")).read()
        api2 = open(os.path.join(dst, "docs", "reference", "modules", "acme-api.md")).read()
        assert "/web/settings" in web2, "the scoped region regenerates scoped"
        assert api2 == api, "the untouched package's guide is byte-identical after sync"
        rmtree(tmp)
        print("  PASS  package-scoped identity: per-package binds, disjoint guides, drift isolated per package")
    except Exception as e:
        failures.append(f"package-scope integration: {why(e)}")

    # ---- manifest lint: `inputs` is load-bearing now, so it must exist ----
    try:
        missing = []
        for cap in sorted(os.listdir(os.path.join(ROOT, "providers"))):
            capd = os.path.join(ROOT, "providers", cap)
            if cap.startswith("_") or not os.path.isdir(capd):
                continue
            for pid in sorted(os.listdir(capd)):
                py = os.path.join(capd, pid, "provider.yaml")
                if not os.path.exists(py):
                    continue
                text = open(py, encoding="utf-8").read()
                if "status: stub" in text:
                    continue                       # declared, not shipped
                if "live: true" in text:
                    continue                       # reads a DSN, not the repository
                line = next((l for l in text.splitlines() if l.startswith("inputs:")), None)
                if line is None or line.split(":", 1)[1].strip() in ("[]", ""):
                    missing.append(f"{cap}/{pid}")
        assert not missing, ("a provider with no declared inputs gets an EMPTY sandbox view "
                             f"and silently extracts nothing: {', '.join(missing)}")
        load = subprocess.run(["node", "-e",
            "import(process.argv[1]).then(m=>console.log(m.loadProviders().length))",
            __import__("pathlib").Path(ROOT, "src", "providers.js").as_uri()],
            capture_output=True, text=True)
        assert load.returncode == 0, f"the registry does not load: {load.stderr[-300:]}"
        print(f"  PASS  manifest lint: {load.stdout.strip()} providers declare a read scope, registry loads")
    except Exception as e:
        failures.append(f"manifest lint: {why(e)}")

    # ---- ADR-002 sandbox: tier probe + MECHANISM proofs (net and rofs) ----
    try:
        import shutil
        RO = 'mount --bind "$1" "$1" && mount -o remount,ro,bind "$1" && shift && exec "$@"'
        def unshare_ok(args):
            if sys.platform != "linux":
                return False
            try:
                return subprocess.run(["unshare", *args], capture_output=True).returncode == 0
            except OSError:
                return False
        expect = ("rofs" if unshare_ok(["-rnm", "--", "/bin/sh", "-c", RO, "sh", "/tmp", "/bin/true"])
                  else "net" if unshare_ok(["-rn", "true"]) else "none")
        wired = subprocess.run(["node", "-e",
            "import(process.argv[1]).then(m=>console.log(JSON.stringify(m.sandboxState())))",
            __import__("pathlib").Path(ROOT, "src", "facts.js").as_uri()], capture_output=True, text=True)
        assert wired.returncode == 0 and json.loads(wired.stdout)["tier"] == expect, \
            f"engine sandbox tier disagrees with the probe: {wired.stdout!r} vs {expect}"
        if expect != "none":
            # network: a live localhost listener is unreachable inside the wrapper
            import socket
            srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
            port = srv.getsockname()[1]
            code = ("import socket,sys\ns=socket.socket()\ns.settimeout(2)\n"
                    f"sys.exit(0 if s.connect_ex((\"127.0.0.1\", {port})) == 0 else 3)")
            direct = subprocess.run([sys.executable, "-c", code], capture_output=True)
            wrapped = subprocess.run(["unshare", "-rn", "--", sys.executable, "-c", code], capture_output=True)
            srv.close()
            assert direct.returncode == 0, "control: direct connect must succeed"
            assert wrapped.returncode == 3, "netns must block even localhost"
        if expect == "rofs":
            # filesystem: the same write succeeds outside and fails inside
            import tempfile as _tf
            d = _tf.mkdtemp(prefix="keeldocs-ro-")
            W(os.path.join(d, "seed.txt"), "x")
            wcode = ("import sys\ntry:\n open(sys.argv[1] + '/written.txt', 'w').write('x')\n"
                     " sys.exit(0)\nexcept OSError:\n sys.exit(7)")
            free = subprocess.run([sys.executable, "-c", wcode, d], capture_output=True)
            caged = subprocess.run(["unshare", "-rnm", "--", "/bin/sh", "-c", RO, "sh", d,
                                    sys.executable, "-c", wcode, d], capture_output=True)
            assert free.returncode == 0, "control: the write must succeed unsandboxed"
            assert caged.returncode == 7, "read-only bind must refuse provider writes"
            assert open(os.path.join(d, "seed.txt")).read() == "x", "reads must still work"
            rmtree(d)
            print("  PASS  sandbox tier rofs: network blocked AND repo read-only (purity enforced by the kernel)")

            # ---- per-glob READ scoping: the undeclared file does not exist ----
            # Same control discipline as above: every assertion is paired with
            # the unsandboxed run that proves the test itself is not vacuous.
            SCOPE = "\n".join([
                'view=$1; root=$2; n=$3; shift 3',
                'while [ "$n" -gt 0 ]; do',
                '  mount --bind "$1" "$2" || exit 91',
                '  mount -o remount,ro,bind "$2" || exit 92',
                '  shift 2; n=$((n-1))',
                'done',
                'mount --rbind "$view" "$root" || exit 93',
                'mount -o remount,ro,bind "$root" || exit 94',
                'cd "$root" || exit 95',
                'exec "$@"',
            ])
            repo = _tf.mkdtemp(prefix="keeldocs-scope-")
            os.makedirs(os.path.join(repo, "src"))
            os.makedirs(os.path.join(repo, ".git", "objects"))
            os.makedirs(os.path.join(repo, "view", "src"))
            os.makedirs(os.path.join(repo, "view", ".git"))
            W(os.path.join(repo, "src", "a.ts"), "declared\n")
            W(os.path.join(repo, ".env"), "DB_PASSWORD=hunter2\n")
            W(os.path.join(repo, ".git", "objects", "o"), "OBJ\n")
            os.link(os.path.join(repo, "src", "a.ts"), os.path.join(repo, "view", "src", "a.ts"))

            def probe(rel, caged):
                # read a repo-relative path, and the same path ABSOLUTELY -
                # scoping that only hid relative paths would be theatre
                code = ("import sys\ntry:\n sys.stdout.write(open(sys.argv[1]).read())\n"
                        " sys.exit(0)\nexcept OSError:\n sys.exit(8)")
                target = os.path.join(repo, rel)
                if not caged:
                    return subprocess.run([sys.executable, "-c", code, target], capture_output=True)
                return subprocess.run(
                    ["unshare", "-rnm", "--", "/bin/sh", "-c", SCOPE, "sh",
                     os.path.join(repo, "view"), repo, "1",
                     os.path.join(repo, ".git"), os.path.join(repo, "view", ".git"),
                     sys.executable, "-c", code, target], capture_output=True)

            assert probe(".env", caged=False).returncode == 0, "control: .env is readable unsandboxed"
            assert probe(".env", caged=True).returncode == 8, \
                "an UNDECLARED file must not exist inside the view, not even by absolute path"
            assert probe("src/a.ts", caged=True).returncode == 0, "a declared file stays readable"
            assert probe(".git/objects/o", caged=True).returncode == 0, \
                "a directory grant is carried through by --rbind"
            assert open(os.path.join(repo, ".env")).read().startswith("DB_PASSWORD"), \
                "the real repository is untouched by any of this"
            rmtree(repo)

            # and the engine leaves NO view behind - a leaked one inside the
            # repo is indistinguishable from repository content to any walker
            probe_repo = _tf.mkdtemp(prefix="keeldocs-scopeE2E-")
            shutil.copytree(os.path.join(ROOT, "fixtures", "express-mounts"),
                            os.path.join(probe_repo, "repo"),
                            ignore=shutil.ignore_patterns("golden", ".keeldocs"))
            dstp = os.path.join(probe_repo, "repo")
            W(os.path.join(dstp, ".env"), "DB_PASSWORD=hunter2\n")
            assert kd(dstp, "init", "--yes", "--json").returncode == 0
            assert not os.path.exists(os.path.join(dstp, ".keeldocs", "cache", "scope")), \
                "every sandbox view must be torn down, on every path out"
            fdir = os.path.join(dstp, ".keeldocs", "cache", "facts")
            blob = "".join(open(os.path.join(fdir, f)).read() for f in sorted(os.listdir(fdir)))
            assert "hunter2" not in blob, "a secret must never reach any fact file"
            assert "hunter2" not in "".join(
                open(os.path.join(r_, f)).read()
                for r_, _d, fs in os.walk(os.path.join(dstp, "docs")) for f in fs), \
                "nor any generated document"
            rmtree(probe_repo)
            print("  PASS  per-glob read scoping: undeclared files absent, grants carried, views torn down")
            # ---- MINIMAL ROOT: the host outside the repository is gone too ----
            # Composed from the ENGINE's own script and plan, so this gate proves
            # the shipped mechanism rather than a copy of it.
            state = json.loads(subprocess.run(["node", "-e",
                "import(process.argv[1]).then(m=>console.log(JSON.stringify(m.sandboxState())))",
                __import__("pathlib").Path(ROOT, "src", "facts.js").as_uri()],
                capture_output=True, text=True).stdout)
            if state.get("root") != "minimal":
                print(f"  PASS  minimal root: unavailable here, reported honestly "
                      f"({state.get('rootReason', '?')})")
            else:
                spec = subprocess.run(["node", "--input-type=module", "-e",
                    "import {MINROOT_SCRIPT} from %r;"
                    "import {minimalRootPlan} from %r;"
                    "console.log(JSON.stringify({script: MINROOT_SCRIPT, plan: minimalRootPlan([])}))"
                    % (__import__("pathlib").Path(ROOT, "src", "facts.js").as_uri(),
                       __import__("pathlib").Path(ROOT, "src", "minroot.js").as_uri())],
                    capture_output=True, text=True)
                assert spec.returncode == 0, spec.stderr[-300:]
                spec = json.loads(spec.stdout)
                mr = _tf.mkdtemp(prefix="keeldocs-minroot-")
                os.makedirs(os.path.join(mr, "view"))
                os.makedirs(os.path.join(mr, "root"))
                # a credential OUTSIDE the repository, in the shape that matters
                home = _tf.mkdtemp(prefix="keeldocs-homelike-")
                W(os.path.join(home, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n")
                code = ("import sys\ntry:\n open(sys.argv[1]).read()\n sys.exit(0)\n"
                        "except OSError:\n sys.exit(8)")
                target = os.path.join(home, "id_rsa")
                free = subprocess.run([sys.executable, "-c", code, target], capture_output=True)
                caged = subprocess.run(
                    ["unshare", "-rnm", "--", "/bin/sh", "-c", spec["script"], "sh",
                     os.path.join(mr, "view"), os.path.join(mr, "root"), "0",
                     str(len(spec["plan"]["keeps"])), *spec["plan"]["keeps"],
                     str(len(spec["plan"]["masks"])), *spec["plan"]["masks"],
                     sys.executable, "-c", code, target], capture_output=True)
                assert free.returncode == 0, "control: the credential is readable on the host"
                assert caged.returncode == 8, \
                    "a credential OUTSIDE the repository must not exist inside the minimal root"
                # ...and the runtimes still start, which is the other half of the claim
                alive = subprocess.run(
                    ["unshare", "-rnm", "--", "/bin/sh", "-c", spec["script"], "sh",
                     os.path.join(mr, "view"), os.path.join(mr, "root"), "0",
                     str(len(spec["plan"]["keeps"])), *spec["plan"]["keeps"],
                     str(len(spec["plan"]["masks"])), *spec["plan"]["masks"],
                     sys.executable, "-c", "import sys; sys.exit(0)"], capture_output=True)
                assert alive.returncode == 0, f"python must still start: {alive.stderr[-200:]}"
                rmtree(mr); rmtree(home)
                print("  PASS  minimal root: the host outside the repository is masked; runtimes still start")

        elif expect == "net":
            print("  PASS  sandbox tier net: network blocked; no usable mount namespace here")
        else:
            print("  PASS  sandbox tier none: wiring agrees, best-effort documented (ADR-013)")
    except Exception as e:
        failures.append(f"sandbox: {why(e)}")

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

    # ---- D4 per-file parse cache (R10): re-parsing only what changed must be
    # INDISTINGUISHABLE from re-parsing everything. The engine cannot verify a
    # provider's `incremental: per-file` claim, so this is where it gets checked.
    try:
        import re as _re4, shutil as _sh4, tempfile as _tf4
        tmp = _tf4.mkdtemp(prefix="keeldocs-d4-")
        repo = os.path.join(tmp, "repo")
        subprocess.run([sys.executable, os.path.join(ROOT, "experiments", "e8-scale", "gen.py"),
                        repo, "6", "5", "60"], capture_output=True, text=True, timeout=300, check=True)
        KD = os.path.join(ROOT, "bin", "keeldocs.js")

        def facts(*extra):
            r = subprocess.run(["node", "-e", (
                'import("%s/src/facts.js").then(async ({extractAll}) => {'
                'const {jcs} = await import("%s/src/jcs.js");'
                'const r = extractAll(process.argv[1], {});'
                'const d = jcs([...r.factsById.values()].map(f => ({id: f.id, hash: f.hash, payload: f.payload,'
                ' provenance: f.provenance})).sort((a,b) => a.id.localeCompare(b.id)));'
                'console.log(JSON.stringify({n: r.factsById.size, reparsed: r.cache.reparsed,'
                ' err: r.toolError ?? null, dump: d}));'
                '});') % (ROOT.replace("\\", "/"), ROOT.replace("\\", "/")), repo],
                capture_output=True, text=True, timeout=900,
                env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if extra else {})})
            return json.loads(r.stdout.strip().splitlines()[-1])

        cold = facts()
        assert cold["err"] is None, cold["err"]
        assert cold["reparsed"].get("ts-imports", 0) > 1, \
            f"the fixture must exercise the incremental provider; got {cold['reparsed']}"
        parsed_cold = cold["reparsed"]["ts-imports"]

        # edit ONE file, then compare the incremental answer to a from-scratch one
        victim = os.path.join(repo, "packages", "pkg3", "src", "m2.ts")
        W(victim, open(victim).read() + "\nexport function d4HarnessProbe(n: number): number { return n; }\n")
        inc = facts()
        assert inc["reparsed"].get("ts-imports") == 1, \
            f"exactly one file changed, so exactly one re-parse; got {inc['reparsed']}"
        scratch = facts("--no-cache")
        assert inc["dump"] == scratch["dump"], \
            "the incremental answer differs from the from-scratch answer - a speedup that drops a surface is a lie"
        assert "d4HarnessProbe" in inc["dump"], "the edit never reached the facts through the cache"
        assert inc["n"] == scratch["n"], f"fact count {inc['n']} vs {scratch['n']}"
        # a DELETION must propagate too - the easy bug is a cache that only watches edits
        os.remove(victim)
        gone, gone_scratch = facts(), facts("--no-cache")
        assert gone["dump"] == gone_scratch["dump"], "a deleted file's symbols survived in the per-file cache"
        assert "d4HarnessProbe" not in gone["dump"]
        rmtree(tmp)
        print(f"  PASS  D4 per-file parse cache: {parsed_cold} parses cached, 1 re-parsed on edit, "
              f"incremental==from-scratch through edit AND delete")
    except Exception as e:
        failures.append(f"D4 per-file parse cache: {why(e)}")

    # ---- D6: express adopts the per-file cache. The flagship endpoint
    # extractor resolves mount graphs ACROSS files, so this is the case where a
    # per-file cache is most likely to be quietly wrong. Adding a file changes
    # what an untouched file's imports resolve to, which is why the key carries
    # a path-set digest - and why ADD and DELETE are tested, not just EDIT.
    try:
        import shutil as _sh6, tempfile as _tf6
        tmp = _tf6.mkdtemp(prefix="keeldocs-d6-")
        repo = os.path.join(tmp, "repo")
        _sh6.copytree(os.path.join(ROOT, "fixtures", "express-mounts"), repo,
                      ignore=_sh6.ignore_patterns("golden", ".keeldocs"))
        SNIP = ('import("%s/src/facts.js").then(async ({extractAll}) => {'
                'const {jcs} = await import("%s/src/jcs.js");'
                'const r = extractAll(process.argv[1], {});'
                'const e = [...r.factsById.values()].filter(f => f.payload.type === "endpoint");'
                'console.log(JSON.stringify({n: e.length, rescanned: r.cache.reparsed.express ?? 0,'
                ' err: r.toolError ?? null,'
                ' dump: jcs(e.map(f => ({id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance}))'
                '.sort((a,b) => a.id.localeCompare(b.id)))}));'
                '});') % (ROOT.replace("\\", "/"), ROOT.replace("\\", "/"))

        def eps(no_cache=False):
            r = subprocess.run(["node", "-e", SNIP, repo], capture_output=True, text=True, timeout=600,
                               env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if no_cache else {})})
            return json.loads(r.stdout.strip().splitlines()[-1])

        base = eps()
        assert base["err"] is None and base["n"] == 4, base
        assert base["rescanned"] == 3, f"expected 3 files scanned cold, got {base['rescanned']}"
        api = os.path.join(repo, "routes", "api.js")

        # 1) EDIT one file -> exactly one re-scan, same answer as from scratch
        W(api, open(api).read().replace("router.get('/orders'", "router.get('/baskets'"))
        edited = eps()
        assert edited["rescanned"] == 1, f"one file changed, so one re-scan; got {edited['rescanned']}"
        assert edited["dump"] == eps(True)["dump"], "edited incremental answer != from-scratch"
        assert "/api/baskets" in edited["dump"], "the rename never reached the mount-resolved path"

        # 2) ADD a router and mount it -> a NEW cross-file edge must resolve.
        # This is the case sharding would have broken and the case a
        # content-only key would have missed.
        W(os.path.join(repo, "routes", "v2.js"),
          "const express = require('express');\nconst r = express.Router();\n"
          "r.get('/beta', (q, s) => s.json([]));\nmodule.exports = r;\n")
        W(api, open(api).read().replace("module.exports = router;",
          "const v2 = require('./v2');\nrouter.use('/v2', v2);\nmodule.exports = router;"))
        added = eps()
        assert added["dump"] == eps(True)["dump"], "added incremental answer != from-scratch"
        assert "/api/v2/beta" in added["dump"], \
            "a mount added in another file did not resolve - the path-set digest is not doing its job"
        assert added["n"] == 5, added["n"]

        # 3) DELETE the file the mount points at -> the endpoint must vanish
        os.remove(os.path.join(repo, "routes", "v2.js"))
        gone = eps()
        assert gone["dump"] == eps(True)["dump"], "deleted incremental answer != from-scratch"
        assert "/api/v2/beta" not in gone["dump"], "an endpoint survived the deletion of the file that defined it"
        assert gone["n"] == 4, gone["n"]
        rmtree(tmp)
        print("  PASS  D6 express per-file scan: mount graph correct through edit, ADD and DELETE; "
              "1 re-scan on an edit")
    except Exception as e:
        failures.append(f"D6 express per-file scan: {why(e)}")

    # ---- D9: env-readers adopts the per-file cache. This is the provider with
    # NO cross-file dependency, and the gate checks that too: an add re-scans
    # only the added file and a delete re-scans nothing, where express (whose
    # key carries a path-set digest) has to redo everything. If this provider
    # ever starts behaving like express, its manifest claim has become false.
    try:
        import shutil as _sh9, tempfile as _tf9
        tmp = _tf9.mkdtemp(prefix="keeldocs-d9-")
        repo = os.path.join(tmp, "repo")
        _sh9.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), repo,
                      ignore=_sh9.ignore_patterns("golden", ".keeldocs"))
        SNIP9 = ('import("%s/src/facts.js").then(async ({extractAll}) => {'
                 'const {jcs} = await import("%s/src/jcs.js");'
                 'const r = extractAll(process.argv[1], {});'
                 'const e = [...r.factsById.values()].filter(f => f.payload.type === "env-var");'
                 'console.log(JSON.stringify({n: e.length, rescanned: r.cache.reparsed["env-readers"] ?? 0,'
                 ' err: r.toolError ?? null,'
                 ' dump: jcs(e.map(f => ({id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance}))'
                 '.sort((a,b) => a.id.localeCompare(b.id)))}));'
                 '});') % (ROOT.replace("\\", "/"), ROOT.replace("\\", "/"))

        def envs(no_cache=False):
            r = subprocess.run(["node", "-e", SNIP9, repo], capture_output=True, text=True, timeout=600,
                               env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if no_cache else {})})
            return json.loads(r.stdout.strip().splitlines()[-1])

        base = envs()
        assert base["err"] is None and base["n"] == 2, base
        app = os.path.join(repo, "app.js")

        W(app, open(app).read() + "\nconst extra = process.env.D9_PROBE;\n")
        edited = envs()
        assert edited["rescanned"] == 1, f"one file changed, one re-scan; got {edited['rescanned']}"
        assert edited["dump"] == envs(True)["dump"], "edited incremental answer != from-scratch"
        assert "D9_PROBE" in edited["dump"], "the new read never reached the facts"

        W(os.path.join(repo, "added.js"), "export const k = process.env.D9_ADDED;\n")
        added = envs()
        assert added["dump"] == envs(True)["dump"], "added incremental answer != from-scratch"
        assert "D9_ADDED" in added["dump"]
        assert added["rescanned"] == 1, \
            ("an ADD re-scanned %d files: this provider has no cross-file dependency, so only the new file "
             "should be scanned - if that changed, `incremental: per-file` is now a false claim"
             % added["rescanned"])

        os.remove(os.path.join(repo, "added.js"))
        gone = envs()
        assert gone["dump"] == envs(True)["dump"], "deleted incremental answer != from-scratch"
        assert "D9_ADDED" not in gone["dump"], "a var survived the deletion of the file that read it"
        assert gone["rescanned"] == 0, f"a DELETE should re-scan nothing; got {gone['rescanned']}"
        rmtree(tmp)
        print("  PASS  D9 env-readers per-file scan: correct through edit/ADD/DELETE, and an ADD "
              "re-scans 1 file where express re-scans all")
    except Exception as e:
        failures.append(f"D9 env-readers per-file scan: {why(e)}")

    # ---- D2 input-proportional output cap (R10): a provider whose LEGITIMATE
    # output exceeds the old 5MB constant must complete with nothing lost, and a
    # runaway must still be killed. Both halves matter: the first without the
    # second is just a raised limit.
    try:
        import re as _re2, shutil as _sh2, tempfile as _tf2
        tmp = _tf2.mkdtemp(prefix="keeldocs-d2-")
        KD = os.path.join(ROOT, "bin", "keeldocs.js")

        # (a) legitimate large output: 252 files / 250k lines makes ts-imports
        # emit ~6.2MB - over the old 5MB constant, well under the 6x ratio.
        # Grown from 20x10x800 when D8 halved the wire format: the assertion
        # below caught the fixture falling under the constant and refused to
        # pass vacuously, which is the gate working rather than a gate to fix.
        big = os.path.join(tmp, "big")
        subprocess.run([sys.executable, os.path.join(ROOT, "experiments", "e8-scale", "gen.py"),
                        big, "25", "10", "1000"], capture_output=True, text=True, timeout=300, check=True)
        direct = subprocess.run(
            [sys.executable, os.path.join(ROOT, "providers", "module-graph", "ts-imports", "extract_symbols.py"), big],
            capture_output=True, text=True, timeout=600)
        emitted = json.loads(direct.stdout)
        assert len(direct.stdout) > 5 * 1024 * 1024, \
            f"fixture no longer exceeds the old constant ({len(direct.stdout)}B) - this gate would pass vacuously"
        r = subprocess.run(["node", KD, "init", "--yes", "--json"], cwd=big,
                           capture_output=True, text=True, timeout=900)
        env = json.loads(r.stdout)
        assert r.returncode == 0 and env["code"] == "INITIALIZED", \
            f"a {len(direct.stdout) // 1048576}MB provider still cannot complete: {r.stdout[:300]}"
        # completing is not enough - NOTHING may be lost on the way through
        rc = subprocess.run(["node", KD, "check", "--json"], cwd=big, capture_output=True, text=True, timeout=900)
        rep = json.load(open(os.path.join(big, ".keeldocs", "out",
                        [f for f in os.listdir(os.path.join(big, ".keeldocs", "out")) if f.startswith("check-")][0])))
        assert "toolError" not in rep, rep.get("toolError")
        counted = subprocess.run(["node", "-e", (
            'import("%s/src/facts.js").then(({extractAll}) => {'
            'const r = extractAll(process.argv[1], {});'
            'const t = (k) => [...r.factsById.values()].filter(f => f.payload.type === k).length;'
            'console.log(JSON.stringify({modules: t("module"), symbols: t("symbol"), err: r.toolError ?? null}));'
            '});') % ROOT.replace("\\", "/"), big], capture_output=True, text=True, timeout=900)
        got = json.loads(counted.stdout.strip().splitlines()[-1])
        assert got["err"] is None, got["err"]
        assert got["modules"] == len(emitted["modules"]) and got["symbols"] == len(emitted["symbols"]), \
            f"facts lost in transit: engine {got} vs provider " \
            f"{{'modules': {len(emitted['modules'])}, 'symbols': {len(emitted['symbols'])}}}"
        big_mb = len(direct.stdout) / 1048576

        # (b) a runaway is STILL killed. Tiny declared input -> the floor binds,
        # and the provider prints far past it. Installed through the real T2
        # path so this is the engine's cap, not a test harness's.
        author = os.path.join(tmp, "author"); os.makedirs(author)
        prov = os.path.join(author, "flood-schema"); os.makedirs(prov)
        W(os.path.join(prov, "provider.yaml"),
          "id: flood-schema\ncapability: db-schema\nsemver: 1.0.0\ntier: code\n"
          "entry: ./extract.py\ndetect: { files: [\"flood.schema\"] }\ninputs: [\"**/*.schema\"]\n"
          "timeout_class: B\nemits: [table]\n")
        W(os.path.join(prov, "extract.py"),
          "import sys\n# ~8MB from a 12-byte input: nothing about this is proportional\n"
          "sys.stdout.write('{\"models\": [')\n"
          "sys.stdout.write(','.join('{\"name\": \"T%d\", \"fields\": [{\"name\": \"pad\", \"type\": \"%s\"}]}'\n"
          "                          % (i, 'x' * 200) for i in range(40000)))\n"
          "sys.stdout.write('], \"enums\": []}')\n")
        flood = os.path.join(tmp, "flood")
        _sh2.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), flood,
                      ignore=_sh2.ignore_patterns("golden", ".keeldocs"))
        W(os.path.join(flood, "flood.schema"), "tiny\n")
        lenv = {**os.environ, "CI": ""}
        def kd2(cwd, *a):
            return subprocess.run(["node", KD, *a], cwd=cwd, capture_output=True, text=True, timeout=600, env=lenv)
        pub = json.loads(kd2(author, "provider", "keygen", "--json").stdout)["data"]["publicKeyB64"]
        assert kd2(author, "provider", "sign", prov, "--key",
                   os.path.join(author, "keeldocs-signing-key.pem"), "--signer", "acme", "--json").returncode == 0
        assert kd2(flood, "provider", "trust", "acme", pub, "--json").returncode == 0
        assert kd2(flood, "provider", "add", prov, "--yes", "--json").returncode == 0, "install failed"
        r = kd2(flood, "check", "--json")
        env = json.loads(r.stdout)
        assert r.returncode == 2 and env["code"] == "TOOL_ERROR", \
            f"a provider emitting ~8MB from 5 bytes was NOT killed: rc={r.returncode} {r.stdout[:300]}"
        assert "output cap exceeded" in env["summary"], env["summary"]
        # and the message must name the rule that really bound - the FLOOR here,
        # never the ratio (which would be an explanation that is not true)
        assert "floor" in env["summary"], f"message does not name the binding rule: {env['summary']}"
        assert "6x" not in env["summary"], f"message blames the ratio when the floor bound: {env['summary']}"
        rmtree(tmp)
        print(f"  PASS  D2 output cap: {big_mb:.1f}MB provider completes with 0 facts lost; "
              f"runaway still killed naming the floor")
    except Exception as e:
        failures.append(f"D2 output cap: {why(e)}")

    # ---- D1 incremental extraction (R10): the cache must be INVISIBLE in the
    # output and visible only in the clock. Every assertion here is about the
    # cached answer being indistinguishable from the uncached one; a cache that
    # is merely fast is not the feature.
    try:
        import re as _re8, shutil as _shd, tempfile as _tfd
        tmp = _tfd.mkdtemp(prefix="keeldocs-d1-")
        dst = os.path.join(tmp, "repo")
        _shd.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                      ignore=_shd.ignore_patterns("golden", ".keeldocs"))
        KD = os.path.join(ROOT, "bin", "keeldocs.js")

        def kd(*a, text_mode=False):
            return subprocess.run(["node", KD, *a], cwd=dst, capture_output=True, text=True, timeout=600)

        assert kd("init", "--yes", "--json").returncode == 0, "init failed"
        report = os.path.join(dst, ".keeldocs", "out")

        def check_report(*extra):
            _shd.rmtree(report, ignore_errors=True)
            r = kd("check", "--json", *extra)
            files = [f for f in os.listdir(report) if f.startswith("check-")]
            assert len(files) == 1, files
            return r.stdout, open(os.path.join(report, files[0])).read()

        # cold: no extract cache at all
        _shd.rmtree(os.path.join(dst, ".keeldocs", "cache", "extract"), ignore_errors=True)
        cold_env, cold_rep = check_report()
        warm_env, warm_rep = check_report()
        assert cold_env == warm_env, "cached run produced a DIFFERENT envelope - the cache reached the deterministic channel"
        assert cold_rep == warm_rep, "cached run produced a DIFFERENT report"

        # the cache must actually have done something, or everything above passes vacuously
        human = kd("check").stdout
        m = _re8.search(r"^cache: (\d+)/(\d+) provider\(s\) reused", human, _re8.M)
        assert m and int(m.group(1)) > 0, f"nothing was reused; cache line was {human!r}"
        reused, total = int(m.group(1)), int(m.group(2))

        # an EDIT must reach the output through the cache, identically to without it
        schema = os.path.join(dst, "prisma", "schema.prisma")
        W(schema, open(schema).read() + "\nmodel Widget {\n  id Int @id @default(autoincrement())\n  label String\n}\n")
        edited_env, edited_rep = check_report()
        truth_env, truth_rep = check_report("--no-cache")
        assert edited_rep == truth_rep, "the cached answer after an edit differs from a from-scratch run"
        assert edited_env == truth_env, "envelope differs between cached and --no-cache"
        # the strongest assertion in this block: the new table is VISIBLE through
        # the cache. Equal-but-both-stale would satisfy everything above.
        cold_j, edited_j = json.loads(cold_rep), json.loads(edited_rep)
        assert edited_j["coverage"]["perCapability"]["db-schema"]["total"] \
            == cold_j["coverage"]["perCapability"]["db-schema"]["total"] + 1, \
            "the new model never reached the facts - a stale hit served the old schema"
        assert edited_j["counts"].get("stale") == 1, "and the ERD it belongs in must have gone stale"
        # ...and --no-cache must really refuse the cache
        assert _re8.search(r"^cache: disabled", kd("check", "--no-cache").stdout, _re8.M), "--no-cache did not disable it"
        rmtree(tmp)
        print(f"  PASS  D1 incremental extraction: warm==cold and edited==--no-cache byte-for-byte ({reused}/{total} reused)")
    except Exception as e:
        failures.append(f"D1 incremental extraction: {why(e)}")

    # ---- ERD scale (E11 / R13): a database past Mermaid's ceiling still ships
    # a document that RENDERS, is born clean, and loses no table. The unit
    # tests cover the plan; this covers the loop - init writes it, the content
    # hash covers the chunked bytes, check agrees, sync reproduces them.
    try:
        import re as _re8, shutil as _shs, tempfile as _tfs
        N = 260  # past the measured break: flat is ~65k chars / ~520 edges here
        tmp = _tfs.mkdtemp(prefix="keeldocs-erdscale-")
        dst = os.path.join(tmp, "repo")
        os.makedirs(os.path.join(dst, "prisma"))
        models = ['datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n']
        for i in range(N):
            models.append(
                f"model T{i:04d} {{\n  id Int @id @default(autoincrement())\n"
                f"  name String\n  slug String\n  body String?\n  amount Int\n  active Boolean\n"
                f"  peer T{(i + 1) % N:04d} @relation(fields: [peerId], references: [id])\n  peerId Int\n"
                f"  backrefs T{(i - 1) % N:04d}[]\n}}\n")
        W(os.path.join(dst, "prisma", "schema.prisma"), "\n".join(models))
        W(os.path.join(dst, "package.json"), '{"name":"erdscale","version":"1.0.0"}\n')
        ri = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "init", "--yes", "--json"],
                            cwd=dst, capture_output=True, text=True, timeout=600)
        assert ri.returncode == 0, f"init rc={ri.returncode} {ri.stdout[:300]}"
        doc_path = os.path.join(dst, "docs", "architecture", "data-model.md")
        doc = open(doc_path).read()
        diagram = doc.split("<!-- keeldocs:gen id=db.root.diagram")[1].split("<!-- /keeldocs:gen -->")[0]
        fences = diagram.count("```mermaid")
        assert fences > 1, f"{N} tables must split; got {fences} diagram(s)"
        # every table reaches the reader - the whole point
        drawn = set(_re8.findall(r"^  (T\d{4}) \{$", diagram, _re8.M))
        assert len(drawn) == N, f"{len(drawn)} of {N} tables drawn - {N - len(drawn)} silently lost"
        # every fenced diagram is one Mermaid will parse (its SHIPPED ceilings)
        for j, chunk in enumerate(diagram.split("```mermaid")[1:]):
            body = chunk.split("```")[0]
            assert len(body) <= 50_000, f"chunk {j}: {len(body)} chars over maxTextSize"
            assert body.count("}o--||") <= 500, f"chunk {j}: {body.count('}o--||')} edges over maxEdges"
        # born clean: the content hash covers the chunked bytes actually written
        rc = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "check", "--json"],
                            cwd=dst, capture_output=True, text=True, timeout=600)
        ce = json.loads(rc.stdout)
        assert rc.returncode == 0 and ce["code"] == "CLEAN", f"not born clean: rc={rc.returncode} {rc.stdout[:300]}"
        # and sync regenerates the chunked region identically (repair loop closed)
        rs = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "sync", "--apply-all", "--json"],
                            cwd=dst, capture_output=True, text=True, timeout=600)
        assert rs.returncode == 0, f"sync rc={rs.returncode} {rs.stdout[:300]}"
        assert open(doc_path).read() == doc, "sync rewrote a clean chunked diagram - init and sync disagree"
        print(f"  PASS  ERD scale (E11/R13): {N} tables -> {fences} renderable diagrams, all drawn, born clean, sync-stable")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"ERD scale: {why(e)}")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  FAIL  {f}")
        sys.exit(1)
    print(f"\nAll green: {len(MATRIX)} extractor + 2 check + init + sync + honesty-loop + system-map integrations + envelope smoke.")


if __name__ == "__main__":
    main()
