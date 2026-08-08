#!/usr/bin/env python3
"""keeldocs fixture harness - the contribution test bed and CI determinism gate.

For every registered provider fixture:
  1. run the extractor TWICE and require byte-identical stdout (determinism gate)
  2. compare canonicalized output to the committed golden fact file

Also smoke-tests the CLI envelope contract (exit codes + JSON shape).
Exit 0 = all green; 1 = mismatch/failure. No network, no clock, no LLM - by design.
"""
import glob, json, os, pathlib, re, subprocess, sys, time, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The node -e snippets below feed this to dynamic import(). A path is NOT a URL:
# on Windows `C:/x/src/facts.js` makes node read `c:` as a protocol and throw
# ERR_UNSUPPORTED_ESM_URL_SCHEME, so the child prints nothing and dies. as_uri()
# yields file:///Users/... and file:///C:/Users/..., both of which import()
# accepts. Four D-series checks failed this way on the non-blocking Windows lane
# for at least twelve consecutive runs, reported only as "list index out of
# range" because the reason was on the stderr nobody read.
ROOT_URL = pathlib.Path(ROOT).as_uri()


class _SkipCount(Exception):
    """The check count is only meaningful on a run where every check ran."""


_PASSES, _TIER_PASSES = [], []
_stdlib_print = print
_LINUX = "  PASS  [linux] "


def print(*args, **kwargs):  # noqa: A001 - deliberate, module-wide
    """Count the PASS lines, because README ships the number.

    "82 end-to-end harness checks" is a published claim in a tarball, and it was
    hand-maintained and already wrong: the harness ran 83. Fifty-two call sites
    is too many to instrument by hand, and several sit inside loops, so the count
    can only be taken at runtime. A shim beats a hand-kept tally in the project
    whose whole argument is that hand-kept numbers rot.

    The two kernel-mechanism proofs that exist only where `unshare -rnm` works
    are counted separately: a portable figure that changes with the runner's
    kernel is not a figure, and would have turned this gate into a Linux-only
    CI failure the first time it ran."""
    if args and isinstance(args[0], str) and args[0].startswith("  PASS  "):
        (_TIER_PASSES if args[0].startswith(_LINUX) else _PASSES).append(args[0])
    _stdlib_print(*args, **kwargs)


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
        # The one workspace golden that is NOT invariant under suppressing the
        # gap emission. The other five are single-package or fully-resolved
        # trees, so a provider that reported nothing it dropped reproduced all
        # five byte-for-byte - the gate could not have failed.
        "name": "pnpm-mixed-scenario / workspace-layout (declared members it cannot resolve are named)",
        "cmd": [sys.executable, "providers/workspace-layout/auto/extract_workspace.py",
                "fixtures/pnpm-mixed-scenario"],
        "golden": "fixtures/pnpm-mixed-scenario/golden/workspace-layout.json",
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



def pin_meta(rep):
    """Null what is volatile across commits and releases; ASSERT what must be
    right rather than frozen. meta.engine used to be baked into every golden,
    which is why nothing caught 0.2.0-rc.4 shipping with ENGINE_VERSION
    "0.2.0-dev.0" stamped on every receipt: the golden agreed with the bug.
    A frozen version string can only ever confirm itself; checking it against
    package.json is the gate that actually fails."""
    ver = json.load(open(os.path.join(ROOT, "package.json")))["version"]
    assert rep["meta"]["engine"] == f"keeldocs@{ver}", \
        f'meta.engine {rep["meta"]["engine"]!r} != keeldocs@{ver}'
    rep["meta"]["head"] = None            # volatile across commits
    rep["meta"]["providerSetHash"] = None  # cache identity, not golden identity
    rep["meta"]["engine"] = None           # release identity, asserted above
    return rep


def node_json(r, what):
    """Parse the single JSON line a node -e snippet prints. Empty stdout means the
    child died, and the reason is on stderr - which `splitlines()[-1]` discarded,
    raising IndexError and naming nothing. A harness that reports "list index out
    of range" for a crashed subprocess is not reporting; it is guessing."""
    lines = (r.stdout or "").strip().splitlines()
    if not lines:
        raise AssertionError(
            f"{what}: node wrote no stdout (rc={r.returncode}); "
            f"stderr: {(r.stderr or '').strip()[-400:] or '(empty)'}")
    return json.loads(lines[-1])


def why(e):
    """A bare `assert x` carries no message; without the line number a failure
    here is a scavenger hunt. Report where it fired, always."""
    tb = traceback.extract_tb(e.__traceback__)
    where = f" [harness.py:{tb[-1].lineno}]" if tb else ""
    return f"{e}{where}"

def canonical_lines(text):
    """A JSONL fact file compared key-order-insensitively, line by line."""
    return [canonical(l) for l in text.splitlines() if l.strip()]


def tracking_docs():
    """The documents whose counts are claims about the CURRENT tree, as
    (name, body) with `counts:ignore` lines already dropped.

    CHANGELOG.md is here for its `## Unreleased` section only, and it is here
    because it was the one tracking document no count gate read. CLAUDE.md names
    it as the file to update when the measured before-and-after changes, and it
    stated `104 harness checks` against a tree with 106 - written by the commit
    that added the harness-count gate, and invisible to that gate, which reads
    four files and not this one. A count nobody checks is the shape of every
    defect this project has spent four releases on.

    Only the Unreleased slice: a RELEASED section is history, and `0.4.3` saying
    `98 harness checks` is true of `0.4.3`. Scanning the whole file would make
    the gate demand that the past be rewritten, which is the one thing a
    changelog must never do - so the slice ends at the next `## ` heading.
    """
    for rel in ("README.md", "ROADMAP.md", "CLAUDE.md", "AGENTS.md", "CHANGELOG.md"):
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        text = open(path, encoding="utf-8").read()
        if rel == "CHANGELOG.md":
            m = re.search(r"(?m)^## Unreleased\b(.*?)(?=^## |\Z)", text, re.S)
            # No Unreleased section is not a hole: between releases there is
            # nothing claiming to describe this tree. An empty one is, so it
            # yields and the caller's own "stated somewhere" assertions apply.
            if not m:
                continue
            text, rel = m.group(1), "CHANGELOG.md (Unreleased)"
        # A historical quote and a scoped count are not claims about the current
        # tree. They opt out explicitly, per line, rather than the patterns being
        # loosened until they catch nothing.
        yield rel, "\n".join(l for l in text.split("\n") if "counts:ignore" not in l)


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
        pin_meta(report)
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
        pin_meta(rep)
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
        pin_meta(rep)
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

    # ---- workspace layout: three silent collapses, now named end-to-end ----
    # Asserted through the CLI, not at extractor stdout, because the extractor
    # was never the whole defect: `packageFacts` hardcoded `gaps: []`, so even a
    # provider that reported its drops would have had them thrown away between
    # the process boundary and the report. Only init and check can see both
    # halves. Named kinds, never a total gap count - other providers legitimately
    # report their own (a non-git copy costs one) and a count would tie this gate
    # to them.
    try:
        import shutil, tempfile
        tmp = tempfile.mkdtemp(prefix="keeldocs-wsdrop-")
        dst = os.path.join(tmp, "repo")
        shutil.copytree(os.path.join(ROOT, "fixtures", "pnpm-mixed-scenario"), dst,
                        ignore=shutil.ignore_patterns("golden", ".keeldocs"))
        wsy = os.path.join(dst, "pnpm-workspace.yaml")
        facts_file = os.path.join(dst, ".keeldocs", "cache", "facts", "workspace-layout.jsonl")

        def layout():
            return [json.loads(l)["payload"]["attrs"]
                    for l in open(facts_file, encoding="utf-8") if l.strip()]

        def check_gaps():
            """`check --ci --json` -> (envelope, the gaps its full report names).
            --ci is the mode CI actually runs, and the one whose clock is HEAD's."""
            r = kd(dst, "check", "--ci", "--json")
            e = json.loads(r.stdout)
            # An extraction gap must never move the verdict: it says the answer is
            # incomplete, not that the documentation is wrong.
            assert r.returncode == 0 and e["code"] == "CLEAN", (r.returncode, r.stdout[:300])
            assert "extraction gap(s)" in e["summary"], e["summary"]
            full = json.load(open(os.path.join(dst, *e["full"].split("/")), encoding="utf-8"))
            return e, {(g["kind"], g["file"]) for g in full.get("extractionGaps", [])}

        # collapse 1: three declared members, one resolvable. The COLLAPSE still
        # happens - pnpm would not call a package.json-less directory a member
        # either, and guessing one is the lie this project exists to avoid. What
        # must not happen is the collapse being invisible.
        r = kd(dst, "init", "--yes", "--json")
        env_ = json.loads(r.stdout)
        assert r.returncode == 0 and env_["code"] == "INITIALIZED", r.stdout[:300]
        rep = json.load(open(os.path.join(dst, ".keeldocs", "out", "init-nogit.json"), encoding="utf-8"))
        dropped = {g["file"] for g in rep.get("extractionGaps", [])
                   if g["kind"] == "workspace-member-unresolved"}
        assert dropped == {"services/api", "services/worker"}, dropped
        _e, gaps_ = check_gaps()
        assert {("workspace-member-unresolved", "services/api"),
                ("workspace-member-unresolved", "services/worker")} <= gaps_, sorted(gaps_)
        attrs = layout()
        assert len(attrs) == 1 and attrs[0]["manager"] == "pnpm", attrs

        # collapse 2: one tab instead of two spaces. The manifest does not parse,
        # and the repo used to report manager:single, one package, no error - a
        # whole workspace erased by one byte, exactly like the drift marker that
        # one byte turned off.
        W(wsy, 'packages:\n\t- "apps/*"\n')
        _e, gaps_ = check_gaps()
        assert ("workspace-manifest-unparsed", "pnpm-workspace.yaml") in gaps_, sorted(gaps_)
        attrs = layout()
        assert len(attrs) == 1 and attrs[0]["manager"] == "single", attrs

        # collapse 3: a valid manifest that declares no members at all
        W(wsy, "onlyBuiltDependencies:\n  - esbuild\n")
        _e, gaps_ = check_gaps()
        assert ("workspace-no-packages-declared", "pnpm-workspace.yaml") in gaps_, sorted(gaps_)
        assert not [k for k, _f in gaps_ if k == "workspace-member-unresolved"], sorted(gaps_)
        attrs = layout()
        assert len(attrs) == 1 and attrs[0]["manager"] == "single", attrs

        # The same three collapses on npm/yarn, which is most repositories. This
        # half exists because the first version of the fix was pnpm-only while the
        # changelog, the commit and the provider docstring all said "every
        # manifest" - and no gate could catch the gap, because every multi-package
        # fixture here is pnpm. A gate that cannot fail for the majority manager is
        # not a gate. Removing the pnpm manifest is what reaches the npm/yarn branch.
        os.remove(wsy)
        pjp = os.path.join(dst, "package.json")
        W(pjp, '{"name":"nw","workspaces":["apps/*"],}')          # trailing comma
        _e, gaps_ = check_gaps()
        assert ("workspace-manifest-unparsed", "package.json") in gaps_, sorted(gaps_)

        W(pjp, '{"name":"nw","workspaces":{"nohoist":["**/rn"]}}')  # yarn dict, no packages
        _e, gaps_ = check_gaps()
        assert ("workspace-no-packages-declared", "package.json") in gaps_, sorted(gaps_)

        # Control, and the load-bearing half: a package.json with no `workspaces`
        # key at all is a genuine single-package repo. If this ever warns, the two
        # assertions above are passing on a provider that simply always complains.
        W(pjp, '{"name":"nw","version":"1.0.0"}')
        _e, gaps_ = check_gaps()
        assert not [k for k, f in gaps_ if f == "package.json"
                    and k.startswith("workspace-")], sorted(gaps_)
        attrs = layout()
        assert len(attrs) == 1 and attrs[0]["manager"] == "single", attrs
        rmtree(tmp)
        print("  PASS  workspace-layout gaps: polyglot members, unparseable manifest and a memberless "
              "manifest each named in init and check --ci on BOTH pnpm and npm/yarn, a clean "
              "single-package manifest still silent, verdict still CLEAN")
    except Exception as e:
        failures.append(f"workspace-layout gap integration: {why(e)}")

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
        # ...and NOT modelling it is a scope decision, so it has to be legible.
        # `liveTableFacts` hardcoded `gaps: []`, so the live provider had no way
        # to report anything it walked past: a catalog that is mostly views
        # produced a complete-looking answer over a fraction of it. This is the
        # third of the three hardcoded normalizers, and the only one an external
        # stub cannot reach - dispatch is `reg.id === "tbls-live"` and the engine
        # refuses a duplicate provider id (exit 2), so it is proved here.
        rep_live = json.load(open([os.path.join(dst, ".keeldocs", "out", f)
                                   for f in os.listdir(os.path.join(dst, ".keeldocs", "out"))
                                   if f.startswith("init-")][0], encoding="utf-8"))
        live_gaps = {(g["kind"], g["file"]) for g in rep_live.get("extractionGaps", [])}
        assert ("live-entry-not-modelled: view", "public.order_totals") in live_gaps, \
            f"the catalog entry the live provider declined to model must be NAMED: {sorted(live_gaps)}"
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
        assert "| PUT | `/rest/v1/item_events`" not in ep, "a keyless one does not"
        assert "| GET | `/rest/v1/item_counts`" in ep and \
               "| PATCH | `/rest/v1/item_counts`" not in ep, "an aggregate view is GET-only"
        assert "| PATCH | `/rest/v1/active_items`" in ep, "an auto-updatable view is writable"
        assert "| GET | `/rest/v1/rpc/search_items`" in ep and \
               "| POST | `/rest/v1/rpc/search_items`" in ep, "a STABLE rpc answers both"
        assert "| GET | `/rest/v1/rpc/claim_item`" not in ep, "a VOLATILE rpc is POST-only"
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
        # The cap is read from the adapters, never restated here. It was a
        # literal 8000 in this file AND a constant in src/skillscmd.js until
        # 2026-08-08, so the number an agent owns lived in two places that could
        # disagree and in neither place the agent's own manifest - which is the
        # defect the R7 drill found and the reason it now lives in the manifest.
        # The binding constraint is the smallest cap any supported agent states.
        #
        # Note the two measurements of "the listing" do not agree and are left
        # that way on purpose. This lint sums the name and description VALUES
        # (1431 chars today); `src/skillscmd.js` sums the whole frontmatter LINES
        # including the `name: ` and `description: ` prefixes (1539). Which one
        # ADR-010's 8000 refers to is not established - nobody has measured what
        # an agent actually loads - so picking one and calling it right would
        # trade a visible disagreement for an invisible guess. Both sit under
        # 8000 with room to spare; if that stops being true, measure first.
        caps = []
        adapters_dir = os.path.join(ROOT, "adapters")
        for agent in sorted(os.listdir(adapters_dir)):
            mf = os.path.join(adapters_dir, agent, "manifest.yaml")
            if not os.path.isfile(mf):
                continue
            for line in open(mf, encoding="utf-8").read().split("\n"):
                head = line.split("#")[0].strip()
                if head.startswith("listing_cap:"):
                    caps.append((agent, int(head.split(":", 1)[1].strip())))
        cap = min([c for _, c in caps], default=8000)
        assert total_listing <= cap, (
            f"skills listing {total_listing} chars > {cap} "
            f"(the smallest cap any adapter states: {caps or 'none, engine default 8000'})")
        print(f"  PASS  skill lint: {len(skill_dirs)} skills within ADR-010 budgets "
              f"(listing {total_listing}/{cap}, cap from {len(caps)} adapter manifest(s))")
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
            print("  PASS  [linux] per-glob read scoping: undeclared files absent, grants carried, views torn down")
            # ---- MINIMAL ROOT: the host outside the repository is gone too ----
            # Composed from the ENGINE's own script and plan, so this gate proves
            # the shipped mechanism rather than a copy of it.
            state = json.loads(subprocess.run(["node", "-e",
                "import(process.argv[1]).then(m=>console.log(JSON.stringify(m.sandboxState())))",
                __import__("pathlib").Path(ROOT, "src", "facts.js").as_uri()],
                capture_output=True, text=True).stdout)
            if state.get("root") != "minimal":
                print(f"  PASS  [linux] minimal root: unavailable here, reported honestly "
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
                print("  PASS  [linux] minimal root: the host outside the repository is masked; runtimes still start")

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
                '});') % (ROOT_URL, ROOT_URL), repo],
                capture_output=True, text=True, timeout=900,
                env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if extra else {})})
            return node_json(r, "node -e extract")

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
                '});') % (ROOT_URL, ROOT_URL)

        def eps(no_cache=False):
            r = subprocess.run(["node", "-e", SNIP, repo], capture_output=True, text=True, timeout=600,
                               env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if no_cache else {})})
            return node_json(r, "node -e extract")

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
                 '});') % (ROOT_URL, ROOT_URL)

        def envs(no_cache=False):
            r = subprocess.run(["node", "-e", SNIP9, repo], capture_output=True, text=True, timeout=600,
                               env={**os.environ, **({"KEELDOCS_NO_CACHE": "1"} if no_cache else {})})
            return node_json(r, "node -e extract")

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

        # (a) legitimate large output: 390 files / 432k lines makes ts-imports
        # emit ~7.1MB - over the old 5MB constant, well under the 6x ratio.
        # This fixture has now been grown TWICE, by D8 and again by D11, each
        # time because the assertion below caught it falling under the constant
        # and refused to pass vacuously. That is the gate working, not a gate
        # to fix - and it is why the assertion exists at all.
        big = os.path.join(tmp, "big")
        subprocess.run([sys.executable, os.path.join(ROOT, "experiments", "e8-scale", "gen.py"),
                        big, "30", "12", "1200"], capture_output=True, text=True, timeout=300, check=True)
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
        # `check` writing no envelope is a real failure with a real reason on
        # stdout; indexing [0] into an empty listing reports IndexError and buries
        # it. Name what actually happened.
        out_dir = os.path.join(big, ".keeldocs", "out")
        spilled = sorted(f for f in os.listdir(out_dir)) if os.path.isdir(out_dir) else []
        checks = [f for f in spilled if f.startswith("check-")]
        assert checks, (f"check wrote no envelope to .keeldocs/out (rc={rc.returncode}); "
                        f"dir holds {spilled or '(nothing)'}; stdout: {(rc.stdout or '').strip()[:300]}; "
                        f"stderr: {(rc.stderr or '').strip()[-200:]}")
        rep = json.load(open(os.path.join(out_dir, checks[0])))
        assert "toolError" not in rep, rep.get("toolError")
        counted = subprocess.run(["node", "-e", (
            'import("%s/src/facts.js").then(({extractAll}) => {'
            'const r = extractAll(process.argv[1], {});'
            'const t = (k) => [...r.factsById.values()].filter(f => f.payload.type === k).length;'
            'console.log(JSON.stringify({modules: t("module"), symbols: t("symbol"), err: r.toolError ?? null}));'
            '});') % ROOT_URL, big], capture_output=True, text=True, timeout=900)
        got = node_json(counted, "D2 fact count")
        assert got["err"] is None, got["err"]
        # the module-graph contract accepts two symbol shapes (D11): flat
        # `symbols`, or `symbolFiles` grouped under their file. Count either,
        # because this assertion is about facts surviving the trip - not about
        # which shape the provider happens to prefer this month.
        n_symbols = len(emitted.get("symbols", [])) + sum(
            len(f.get("symbols", [])) for f in emitted.get("symbolFiles", []))
        assert got["modules"] == len(emitted["modules"]) and got["symbols"] == n_symbols, \
            f"facts lost in transit: engine {got} vs provider " \
            f"{{'modules': {len(emitted['modules'])}, 'symbols': {n_symbols}}}"
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

    # ---- the tracking documents must agree with the tree ----
    # These counts were hand-maintained and rotted continuously. In ONE day the
    # provider count was wrong (35 vs 34), the finding-class count was wrong
    # (8 vs 7), and the unit-test figure was stale in four places across three
    # files while the real number moved 151 -> 172 - including in a paragraph
    # that shipped inside a published npm tarball. A project arguing that
    # hand-maintained documentation lies cannot hand-maintain its own counts.
    try:
        sys.path.insert(0, os.path.join(ROOT, "scripts", "dev"))
        from counts import counts as _counts  # noqa: E402
        truth = _counts()
        tap = subprocess.run(["node", "--test", "--test-reporter=tap"] +
                             sorted(glob.glob(os.path.join(ROOT, "tests", "*.test.js"))),
                             cwd=ROOT, capture_output=True, text=True, timeout=1800).stdout
        units = len(re.findall(r"^ok \d+ ", tap, re.M))
        # One optional adjective before the noun. Without it this gate could not
        # see the exact defect its own comment cites: `35 shipped providers` sat
        # in ROADMAP §8 from the day the gate was written, and `(\d+) providers`
        # cannot match across an intervening word. A pattern that misses the
        # string it was built for is decoration, not a gate.
        # `\b` because widening the adjective made `E5 determinism goldens` read
        # as a claim of five goldens: an experiment id is not a count.
        ADJ = r"(?:[a-z][a-z-]* )?"
        N = r"\b(\d+) "
        PHRASE = {"providers": rf"{N}{ADJ}providers",
                  "capabilities": rf"{N}{ADJ}capabilities",
                  "recipes": rf"{N}{ADJ}recipes",
                  "skills": rf"{N}{ADJ}skills",
                  "goldens": rf"{N}{ADJ}(?:extractor )?goldens",
                  "adrs": rf"{N}ADRs",
                  "finding_classes": rf"{N}{ADJ}finding classes"}
        bad = []
        # How many times each claim was actually FOUND. Without this the loops
        # below fail only on a mismatched match: a phrase that stops matching at
        # all is compared to nothing, and the gate prints PASS over a claim it
        # has stopped reading. `finding classes` appears once in the whole
        # corpus, so rewording that one line - "the five finding classes" - would
        # have retired it silently. The comment above says a pattern that misses
        # the string it was built for is decoration rather than a gate; that was
        # a statement about the pattern, and it was equally true of the gate.
        seen = {k: 0 for k in PHRASE}
        seen["unit tests"] = 0
        # A historical quote (D4's "12 providers re-run") and a scoped count
        # ("8 unit tests against Mermaid's ceilings") are not claims about the
        # current tree; they opt out per line inside `tracking_docs`, rather than
        # the patterns being loosened until they catch nothing. CHANGELOG's
        # Unreleased section arrives from there too - it is a claim about this
        # tree and was read by neither count gate.
        for rel, body in tracking_docs():
            # Line-wrapped prose hid claims from every pattern here: ROADMAP §8
            # wraps between "6" and "agent skills", so the count was unchecked
            # for no reason but where the line broke. Collapse AFTER the per-line
            # `counts:ignore` filter, so the escape hatch still works per line.
            body = re.sub(r"\s+", " ", body)
            for key, pat in PHRASE.items():
                for m in re.finditer(pat, body):
                    seen[key] += 1
                    if int(m.group(1)) != truth[key]:
                        bad.append(f"{rel}: '{m.group(0)}' but the tree has {truth[key]}")
            for m in re.finditer(r"(\d+) unit tests", body):
                seen["unit tests"] += 1
                if int(m.group(1)) != units:
                    bad.append(f"{rel}: '{m.group(0)}' but the suite has {units}")
        unstated = sorted(k for k, n in seen.items() if not n)
        if unstated:
            bad.append("no tracking document states a count for " + ", ".join(unstated)
                       + " - the phrase moved or was reworded out from under the pattern, so the "
                         "claim went UNCHECKED rather than correct and this gate printed PASS "
                         "over it. Restate it or delete the pattern deliberately")
        assert not bad, "stale counts in the tracking documents:\n    " + "\n    ".join(bad)
        print(f"  PASS  tracking-document counts: {units} unit tests, {truth['providers']} providers, "
              f"{truth['goldens']} goldens agree with the tree ({sum(seen.values())} claim(s) found "
              f"across {len(seen)} phrase(s), every phrase stated somewhere)")
    except Exception as e:  # noqa: BLE001
        failures.append(f"tracking-document counts: {why(e)}")

    # ---- packaged-artifact gates: what npm actually ships, not what git holds ----
    # Deliberately last. Every provider above has now run, so __pycache__ exists
    # exactly as it does on a CI runner - which is the state that let compiled
    # bytecode into the signed 0.2.0-rc.4 tarball. CI's own `pack` job runs before
    # any Python executes, so it could never have caught this. Packing a cold tree
    # here would reproduce that same vacuous gate.
    try:
        # npm is npm.cmd on Windows; a bare "npm" raises WinError 2 under
        # subprocess without a shell. Caught by the non-blocking Windows lane
        # the first time this gate ran.
        npm = "npm.cmd" if os.name == "nt" else "npm"
        r = subprocess.run([npm, "pack", "--dry-run", "--json"],
                           cwd=ROOT, capture_output=True, text=True, timeout=180)
        assert r.returncode == 0, f"npm pack failed rc={r.returncode}: {r.stderr[-300:]}"
        shipped = [f["path"] for f in json.loads(r.stdout)[0]["files"]]
        bad = [f for f in shipped if f.endswith(".pyc") or "__pycache__" in f]
        assert not bad, f"compiled bytecode would ship: {bad[:4]}"
        pkg = json.load(open(os.path.join(ROOT, "package.json")))
        plug = json.load(open(os.path.join(ROOT, ".claude-plugin", "plugin.json")))
        assert plug.get("version") == pkg["version"], \
            f'plugin.json {plug.get("version")} != package.json {pkg["version"]}'
        # R9's budgets were stated in the risk register and enforced by nothing:
        # no dep count, no install-script check, in harness or either workflow.
        # The transitive walk is the part that matters - a direct-dep count cannot
        # see the Shai-Hulud class, which arrives through a lifecycle script in a
        # dependency-of-a-dependency.
        deps = {**pkg.get("dependencies", {}), **pkg.get("optionalDependencies", {})}
        assert len(deps) <= 5, f"R9 dep budget: {len(deps)} runtime deps > 5 ({sorted(deps)})"
        for stage in ("preinstall", "install", "postinstall"):
            assert stage not in pkg.get("scripts", {}), f"R9: package.json defines a {stage} script"
        lock = json.load(open(os.path.join(ROOT, "package-lock.json")))
        offenders = [name for name, meta in lock.get("packages", {}).items()
                     if isinstance(meta, dict) and meta.get("hasInstallScript")]
        assert not offenders, f"R9: lockfile entries carry install scripts: {offenders[:4]}"
        # The npm half was gated and the Python half was not, which made "zero
        # install scripts" a half-truth: pip executes build/install code, and
        # `pip install -r` runs on every consumer's runner (action.yml), on the
        # rollup runner, and in release.yml - which holds `id-token: write`.
        # Every third-party action is SHA-pinned. A tag is mutable, and these run
        # in release.yml, which holds `id-token: write` - the tj-actions class.
        # Local `uses: ./` refs are this repo and are exempt by definition.
        import re as _re
        floating = []
        for rel in (os.path.join(".github", "workflows", "ci.yml"),
                    os.path.join(".github", "workflows", "release.yml"),
                    "action.yml", os.path.join("rollup", "action.yml")):
            for ref in _re.findall(r"uses:\s*(\S+)", open(os.path.join(ROOT, rel), encoding="utf-8").read()):
                if ref.startswith("./") or "@" not in ref:
                    continue
                if not _re.fullmatch(r"[0-9a-f]{40}", ref.split("@", 1)[1]):
                    floating.append(f"{rel}: {ref}")
        assert not floating, f"R9: actions pinned to a mutable tag: {floating}"
        print("  PASS  R9 action pinning: every third-party `uses:` is a 40-char commit SHA")

        # release.yml ended at `npm publish`, so a release's only evidence was the
        # log line saying the artifact was made - the exact thing this project's
        # rule forbids relying on - while SECURITY.md told consumers the provenance
        # attestation is what to trust and nothing checked one existed. The `verify`
        # job closes that. This gate exists because deleting it would restore the
        # silence with no other symptom: the release would still go green.
        #
        # Parsed by indentation rather than with yaml. pyyaml IS hash-pinned in
        # providers/requirements.txt, but the harness is stdlib-only on purpose,
        # and a gate that raises ImportError where pip has not run is a gate that
        # reports the wrong failure. Start after `jobs:` - `on:`/`push:` sits at
        # the same indent as a job name and would otherwise parse as one.
        # SECURITY.md names workflow paths in prose, and its promise IS about a
        # path - "no provenance attestation naming `.github/workflows/release.yml`".
        # Renaming the file turns that sentence false with no other symptom. First,
        # because if the file is gone the reads below raise FileNotFoundError and
        # the build reports a missing file instead of a broken promise.
        sec = open(os.path.join(ROOT, ".github", "SECURITY.md"), encoding="utf-8").read()
        named = sorted(set(_re.findall(r"\.github/workflows/[\w.-]+\.yml", sec)))
        assert named, "SECURITY.md names no workflow file - the provenance promise has lost its subject"
        missing = [p for p in named if not os.path.isfile(os.path.join(ROOT, *p.split("/")))]
        assert not missing, f"SECURITY.md names workflow files that do not exist: {missing}"

        body = open(os.path.join(ROOT, ".github", "workflows", "release.yml"), encoding="utf-8").read()
        rel_lines = body.splitlines()
        jobs, cur = {}, None
        for line in rel_lines[next(i for i, l in enumerate(rel_lines) if l.rstrip() == "jobs:") + 1:]:
            head = _re.match(r"^  ([A-Za-z_][\w-]*):\s*$", line)
            if head:
                cur = head.group(1)
                jobs[cur] = []
            elif cur:
                jobs[cur].append(line)
        jobs = {k: "\n".join(v) for k, v in jobs.items()}
        assert {"publish", "verify"} <= set(jobs), \
            f"release.yml no longer has both a publish and a verify job: {sorted(jobs)}"

        def _perms(job):
            """The job's permissions mapping alone, comments stripped.

            Scoped, because the first version of this gate searched the whole job
            for `id-token` and went red on the comment that explains why the verify
            job does not have one. A gate that fires on the prose describing it is
            not measuring the property."""
            out, on = [], False
            for line in jobs[job].splitlines():
                if _re.match(r"^    permissions:\s*(#.*)?$", line):
                    on = True
                elif on and _re.match(r"^      \S", line):
                    out.append(_re.sub(r"#.*$", "", line))
                elif on and line.strip():
                    break
            return "\n".join(out)

        assert _re.search(r"^\s*needs:\s*publish\s*$", jobs["verify"], _re.M), \
            "the verify job must run after the publish it verifies"
        # The constraint the item was written under, gated so it cannot erode:
        # verification must never become something the publish waits on.
        assert not _re.search(r"^\s*needs:", jobs["publish"], _re.M), \
            "publish has grown a `needs:` - the publish must not be conditional on verification"
        assert not _re.search(r"id-token", _perms("verify")), \
            "the verify job must hold no OIDC token: it verifies releases, it must never be able to make one"
        assert _re.search(r"id-token:\s*write", _perms("publish")), \
            "publish needs id-token: write or there is no provenance attestation to verify"

        # Scoped to the code that ACTS, and every exclusion below was found by
        # mutation rather than by reasoning - the first three drafts of this gate
        # each stayed green through a mutation that removed the thing being
        # asserted:
        #   the `if: failure()` step prints a by-hand reproduction recipe carrying
        #     the same command and the same flags, so deleting the whole
        #     verification step left the needles satisfied by the error message;
        #   the comments explaining each flag quote the flag, so deleting
        #     `--cert-identity` and `--digest-alg sha512` from the command left
        #     them satisfied by the prose describing them;
        #   the step NAME is "npm audit signatures, the command SECURITY.md gives
        #     consumers", so deleting that command left it satisfied by its own
        #     heading.
        # A gate that reads a description of the check instead of the check is the
        # exact defect this job exists to end, so it may not be one itself.
        assert "if: failure()" in jobs["verify"], \
            "the verify job no longer says what a red verification means"
        acting = "\n".join(
            _re.sub(r"\s#.*$", "", line)
            for line in jobs["verify"].split("if: failure()")[0].splitlines()
            if not line.lstrip().startswith("#") and not line.lstrip().startswith("- name:"))
        # `npm audit signatures` is NOT sufficient on its own, and that is measured
        # rather than argued: on 2026-08-08 it exited 0 for a tree holding
        # lodash@4.17.21, which carries a valid registry signature and no
        # attestation at all. The attestation claim rests entirely on the
        # `gh attestation verify` flags, so those are what this gate holds - one
        # per thing SECURITY.md promises a consumer.
        for needle, why_ in (("gh attestation verify", "nothing verifies the provenance attestation"),
                             ("--digest-alg sha512", "npm's subject digest is sha512, and the default sha256 fails rather than verifies"),
                             ("--cert-identity", "the signer identity is unasserted, so any repository's attestation would pass"),
                             ("--source-digest", "the attestation is not bound to this commit"),
                             ("--deny-self-hosted-runners", "a self-hosted runner could have produced it"),
                             (".github/workflows/release.yml@$GITHUB_REF", "the asserted identity no longer names this workflow at this tag"),
                             ("npm audit signatures", "the command SECURITY.md hands consumers is not run on the published artifact")):
            assert needle in acting, f"release.yml verify job dropped `{needle}`: {why_}"
        print("  PASS  release verification: verify job runs after publish, holds no id-token, "
              "and asserts tag, repository and workflow path against the published artifact")
        print(f"  PASS  SECURITY.md workflow paths: all {len(named)} named file(s) exist")

        req = os.path.join(ROOT, "providers", "requirements.txt")
        lines = [l.strip() for l in open(req, encoding="utf-8") if l.strip() and not l.lstrip().startswith("#")]
        pinned = [l for l in lines if "==" in l]
        assert pinned, "providers/requirements.txt declares no pins"
        unhashed = [l.split()[0] for l in pinned if "--hash=sha256:" not in l and not l.rstrip().endswith("\\")]
        assert not unhashed, f"R9: extractor pins without hashes: {unhashed}"
        assert sum(1 for l in lines if l.startswith("--hash=sha256:")) >= len(pinned), \
            "R9: fewer hash lines than pinned packages"
        sites = {os.path.join(".github", "workflows", "ci.yml"): 2,
                 os.path.join(".github", "workflows", "release.yml"): 1,
                 "action.yml": 1, os.path.join("rollup", "action.yml"): 1}
        for rel, want in sites.items():
            body = open(os.path.join(ROOT, rel), encoding="utf-8").read()
            got = body.count("pip install")
            hashed = body.count("--require-hashes")
            assert got == want and hashed == want, \
                f"R9: {rel} has {got} pip install(s) and {hashed} --require-hashes (want {want}/{want})"
        print(f"  PASS  R9 extractor runtime: {len(pinned)} pins hash-locked, "
              f"--require-hashes on all {sum(sites.values())} install sites")
        print(f"  PASS  R9 supply-chain budget: {len(deps)} runtime deps, "
              f"0 install scripts across {len(lock.get('packages', {}))} lockfile entries")
        print(f"  PASS  packaged artifact: {len(shipped)} files, no bytecode, plugin version matches")
    except Exception as e:
        failures.append(f"packaged artifact: {why(e)}")

    # KEEL-5. `recipes/` shipped in the tarball and no code read it, so nothing
    # held it to the renderer and it drifted all the way: every anchor id in
    # recipes/erd/template.md named a section render.js does not emit, and three
    # recipe ids stamped into user documents had no spec at all. Spec and
    # implementation are now bound in the only direction that can be checked
    # without loading the spec at runtime - the harness reads both.
    try:
        import re as _re
        spec_root = os.path.join(ROOT, "docs", "design", "recipes")
        src = {}
        for rel in ("render.js", "newcmd.js"):
            src[rel] = open(os.path.join(ROOT, "src", rel), encoding="utf-8").read()
        blob = "".join(src.values())
        emitted = set(_re.findall(r"recipe=([a-z0-9-]+)@\d+", blob))
        specs = {d for d in os.listdir(spec_root)
                 if os.path.isdir(os.path.join(spec_root, d))}
        assert emitted == specs, (
            f"recipe spec/renderer mismatch: renderer-only {sorted(emitted - specs)}, "
            f"spec-only {sorted(specs - emitted)}")
        pkg_files = json.load(open(os.path.join(ROOT, "package.json")))["files"]
        assert not [f for f in pkg_files if f.startswith("recipes")], \
            "recipes/ is back in the published package; nothing reads it at runtime"
        # `prefix` because two recipes template their output per package / per
        # ADR number; the literal part is still enough to catch a moved file.
        def prefix(v):
            return v.split("{", 1)[0]
        checked, tpl_ids = 0, 0
        for rid in sorted(specs):
            spec = open(os.path.join(spec_root, rid, "recipe.yaml"), encoding="utf-8").read()
            assert _re.search(rf"^id:\s*{_re.escape(rid)}\s*$", spec, _re.M), \
                f"{rid}/recipe.yaml declares an id that is not its directory name"
            for field in ("path", "root_anchor"):
                m = _re.search(rf'^\s+{field}:\s*"?([^"\n#]+?)"?\s*$', spec, _re.M)
                assert m, f"{rid}/recipe.yaml declares no output.{field}"
                want = prefix(m.group(1))
                assert want and want in blob, \
                    f"{rid}: output.{field} {m.group(1)!r} is emitted by no renderer"
                checked += 1
            tpl = os.path.join(spec_root, rid, "template.md")
            if os.path.exists(tpl):
                tpl_text = open(tpl, encoding="utf-8").read()
                # Unfenced, these parse as real anchors: the move into docs/ scored
                # two sections of an illustration as documented surfaces of keeldocs
                # itself, which is coverage inflation in the tool that exists to
                # argue coverage has to mean something.
                assert "```" in tpl_text, \
                    f"{rid}/template.md must fence its markers; under docs/ they parse as real anchors"
                for aid in _re.findall(r"\bid=([A-Za-z0-9._{}-]+)", tpl_text):
                    assert prefix(aid) in src["render.js"], \
                        f"{rid}/template.md anchors id={aid}, which render.js never emits"
                    tpl_ids += 1
        assert tpl_ids, "no recipe template.md was checked - the id gate is vacuous"
        print(f"  PASS  recipe specs: {len(specs)} recipes, {checked} output claims and "
              f"{tpl_ids} template anchor id(s) matched to the renderer, 0 shipped")
    except Exception as e:
        failures.append(f"recipe specs: {why(e)}")

    # KEEL-11 groundwork: the three ways the parser used to fail silently. All
    # three were found by designing the compatibility policy and then verifying
    # its premises against the shipped code rather than taking them.
    try:
        import shutil as _sh11, tempfile as _tf11
        tmp = _tf11.mkdtemp(prefix="keeldocs-failclosed-")
        KDF = os.path.join(ROOT, "bin", "keeldocs.js")
        fenv = {**os.environ, "CI": ""}

        def repo(name, doc):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "docs"))
            W(os.path.join(d, "package.json"), '{"name":"%s","version":"1.0.0"}\n' % name)
            W(os.path.join(d, "app.js"), "const a = process.env.REAL_VAR;\n")
            W(os.path.join(d, "docs", "x.md"), doc)
            for c in (["init", "-q", "."], ["config", "user.email", "t@t"],
                      ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "i"]):
                subprocess.run(["git", *c], cwd=d, capture_output=True, timeout=60)
            return d

        def check(d):
            r = subprocess.run(["node", KDF, "check", "--json"], cwd=d,
                               capture_output=True, text=True, timeout=300, env=fenv)
            return r.returncode, node_json(r, f"check in {os.path.basename(d)}")

        # (1) A package scope naming a package this workspace does not contain.
        # The empty set hashes to a constant that is the same in every repository
        # and that no code change can move, so the section matched it forever.
        gone = repo("gone", "# X\n\n<!-- keeldocs: id=x.root binds=pkg:@acme/gone#http-endpoints/* hash-kind=fact -->\n"
                            "\n<!-- keeldocs:gen id=x.root.t hash=h1:838b60ffacdbdef4 -->\n| a |\n<!-- /keeldocs:gen -->\n")
        rc, env = check(gone)
        assert rc == 1 and env["code"] == "DRIFT_FOUND", \
            f"a document scoped to an absent package must not certify clean: rc={rc} {env['code']}"
        states = {t["state"] for t in env["data"]["top"]}
        assert states == {"dead"}, f"absent package scope should be dead, got {states}"
        assert any("@acme/gone" in m for t in env["data"]["top"] for m in t.get("missing", [])), \
            "the finding must name the scope that does not resolve"
        # Control: the SAME shape against a package that does exist stays clean,
        # or the gate is just asserting that package binds never work.
        ok = repo("present", "# X\n\n<!-- keeldocs: id=x.root binds=pkg:present#config-surface/* hash-kind=fact -->\n")
        rc_ok, env_ok = check(ok)
        assert env_ok["code"] == "CLEAN", \
            f"control: a scope naming a real package must resolve, got {env_ok['code']} {env_ok['summary'][:120]}"

        # (2) The unknown-key guard's name class has to be WIDER than any name a
        # key could have. It was [A-Za-z][A-Za-z0-9-]*, so a name with `_`, `.`,
        # `:` or a leading digit was not seen as an attempted key and was absorbed
        # into the preceding value - reaching data.top[].missing verbatim, in the
        # envelope an agent parses, in a format whose spec says no free text ever.
        probe = subprocess.run(["node", "--input-type=module", "-e", (
            'import {parseDoc} from "%s/src/anchors.js";'
            'const out = {};'
            'for (const [k, body] of JSON.parse(process.argv[1])) {'
            '  const r = parseDoc(`<!-- keeldocs: ${body} -->\\n`, "d.md");'
            '  out[k] = r.anchors.length ? ("accepted:" + r.anchors[0].binds.map(b => b.raw).join("|"))'
            '                            : ("refused:" + r.quarantined[0].reason);'
            '}'
            'console.log(JSON.stringify(out));') % ROOT_URL, json.dumps([
                ["dash", "id=a.b binds=fact:x/y provider-set=zzz"],
                ["underscore", "id=a.b binds=fact:x/y provider_set=zzz"],
                ["dotted", "id=a.b binds=fact:x/y provider.set=zzz"],
                ["colon", "id=a.b binds=fact:x/y ext:v=zzz"],
                ["digit", "id=a.b binds=fact:x/y 2fa=zzz"],
                ["route", "id=a.b binds=fact:http-endpoints/GET /items?x=1 hash-kind=fact"],
                ["symbol", "id=a.b binds=ds npm @app/api . src/o/S#submit(2). hash-kind=fact"],
                ["pkg", "id=a.b binds=pkg:@acme/web#http-endpoints/* hash-kind=fact"],
            ])], capture_output=True, text=True, timeout=120)
        lex = node_json(probe, "anchor lexer probe")
        for k in ("dash", "underscore", "dotted", "colon", "digit"):
            assert lex[k].startswith("refused:unknown-key"), \
                f"an unknown key spelled `{k}` was absorbed instead of refused: {lex[k]}"
        # ...and the legitimate forms, including a value that really contains `=`,
        # still parse. Tightening a lexer until it rejects real input is the other
        # way to get this wrong.
        assert lex["route"] == "accepted:fact:http-endpoints/GET /items?x=1", lex["route"]
        assert lex["symbol"].startswith("accepted:ds npm"), lex["symbol"]
        assert lex["pkg"] == "accepted:pkg:@acme/web#http-endpoints/*", lex["pkg"]

        # (3) A refused marker had no verdict: recorded in the spilled report and
        # absent from the envelope, the summary and the exit code, so an engine
        # that had stopped checking a section still printed CLEAN and exited 0.
        bad = repo("refused", "# X\n\n<!-- keeldocs: id=x.root binds=fact:config-surface/REAL_VAR totally-bogus=yes hash-kind=fact -->\n")
        rc_b, env_b = check(bad)
        assert rc_b == 1, f"a marker the engine cannot parse must not exit 0, got {rc_b}"
        assert env_b["code"] == "UNREADABLE", \
            f"UNREADABLE outranks DRIFT_FOUND - a drift count over an unreadable tree is not a number to headline: {env_b['code']}"
        ref = env_b["data"].get("refused") or []
        assert ref and ref[0]["reason"] == "unknown-key" and ref[0]["line"] == 3, \
            f"the envelope must name the refused marker by line and reason: {ref}"
        # (4) The generation gate. A future key would otherwise be refused as
        # `unknown-key`, telling a user their anchor is malformed when it is only
        # newer than their engine - wrong and unactionable. `needs` makes the
        # answer named, and it has to be read BEFORE the vocabulary check or the
        # unknown key alongside it decides the outcome first.
        gen = node_json(subprocess.run(["node", "--input-type=module", "-e", (
            'import {parseDoc} from "%s/src/anchors.js";'
            'const out = {};'
            'for (const [k, m] of JSON.parse(process.argv[1])) {'
            '  const r = parseDoc(m + "\\n", "d.md");'
            '  out[k] = (r.anchors.length + r.regions.length) ? "accepted"'
            '           : ("refused:" + r.quarantined[0].reason);'
            '}'
            'console.log(JSON.stringify(out));') % ROOT_URL, json.dumps([
                ["explicit1", "<!-- keeldocs: needs=1 id=a.b binds=fact:x/y hash-kind=fact -->"],
                ["future", "<!-- keeldocs: needs=2 id=a.b binds=fact:x/y provider-set=h1:00 -->"],
                ["future-region", "<!-- keeldocs:gen needs=2 id=a.b.t hash=h1:00112233 -->"],
                ["not-first", "<!-- keeldocs: id=a.b needs=2 binds=fact:x/y -->"],
                ["bad", "<!-- keeldocs: needs=x id=a.b binds=fact:x/y -->"],
                ["absent", "<!-- keeldocs: id=a.b binds=fact:x/y hash-kind=fact -->"],
            ])], capture_output=True, text=True, timeout=120), "generation gate probe")
        assert gen["future"] == "refused:needs-newer-reader:2",             f"a marker from a later generation must say so, not read as a typo: {gen['future']}"
        assert gen["future-region"] == "refused:needs-newer-reader:2",             f"the gate has to cover regions too, not only section anchors: {gen['future-region']}"
        assert gen["not-first"] == "refused:needs-not-first",             f"`needs` must lead, or an unknown key ahead of it decides first: {gen['not-first']}"
        assert gen["bad"] == "refused:bad-needs", gen["bad"]
        # Both ends of the compatibility promise: this generation parses, and a
        # document written before the key existed is still conforming.
        assert gen["explicit1"] == "accepted" and gen["absent"] == "accepted",             f"generation 1 must parse with and without the declaration: {gen}"
        # And this engine must never WRITE the key - a 0.x document and a 1.0
        # document have to be byte-identical or the freeze owes everyone a rewrite.
        for rel in ("src/render.js", "src/newcmd.js", "src/patch.js"):
            body = open(os.path.join(ROOT, rel), encoding="utf-8").read()
            assert "needs=" not in body, f"{rel} emits `needs=`; a generation-1 engine must not"
        # (5) A generated region carrying NEITHER hash. It still looks managed and
        # is checked against nothing, so the same wrong body reports `stale` with a
        # hash and `clean` without one. Two deleted attributes - a hand edit, or a
        # merge that resolved a marker line badly - retired a section from drift
        # detection permanently and silently. The pair below is the whole proof.
        BODY = "| GET | `/gone` |\n"
        # A region id the renderer knows, so `sync` can actually regenerate it -
        # an unknown id takes the `unrenderable` path, which is correct behaviour
        # and would have made the repair half of this gate untestable.
        ANCH = "<!-- keeldocs: id=config.reference binds=fact:config-surface/* hash-kind=fact -->\n"
        hashed = repo("hashed", "# X\n\n" + ANCH +
                      "\n<!-- keeldocs:gen id=config.reference.table hash=h1:0000000000000000 -->\n" + BODY + "<!-- /keeldocs:gen -->\n")
        bare = repo("bare", "# X\n\n" + ANCH +
                    "\n<!-- keeldocs:gen id=config.reference.table -->\n" + BODY + "<!-- /keeldocs:gen -->\n")
        rc_h, env_h = check(hashed)
        rc_r, env_r = check(bare)
        assert rc_h == 1 and env_h["code"] == "DRIFT_FOUND", f"control: the hashed twin must drift: {env_h['code']}"
        assert rc_r == 1 and env_r["code"] == "UNREADABLE", \
            f"the same body with the hashes deleted must not read as a pass: rc={rc_r} {env_r['code']} {env_r['summary'][:120]}"
        # ...and one sync has to put it back under check, or the finding is a dead
        # end the user cannot clear.
        sy = subprocess.run(["node", KDF, "sync", "--apply-all", "--json"], cwd=bare,
                            capture_output=True, text=True, timeout=300, env=fenv)
        assert sy.returncode == 0, f"sync could not repair an unverified region: {sy.stdout[-200:]}"
        rc_f, env_f = check(bare)
        assert env_f["code"] != "UNREADABLE", \
            f"sync ran but the region is still unverified: {env_f['code']} {env_f['summary'][:120]}"
        assert "hash=h1:" in open(os.path.join(bare, "docs", "x.md"), encoding="utf-8").read(), \
            "sync must write the hash back into the marker"
        # (6) The same shape one layer down, and it needed no missing attribute at
        # all. A recorded hash whose ALGORITHM this engine cannot compare was its
        # own state, `rebaseline` - not in DRIFT_STATES, not in the summary, not
        # in `top`, and with no branch in buildProposals. So the `hashed` twin
        # above, with its `h1` changed to `h2` and NOTHING else, exited 0 CLEAN
        # over the identical wrong body, and `sync` said NOTHING_TO_SYNC. One byte
        # retired a section from drift detection permanently, with no way back.
        # The parser accepts `h[0-9]+:`, so this was reachable today by a merge
        # resolving a marker line badly - no future algorithm required.
        algo = repo("algo", "# X\n\n" + ANCH +
                    "\n<!-- keeldocs:gen id=config.reference.table hash=h2:0000000000000000 -->\n"
                    + BODY + "<!-- /keeldocs:gen -->\n")
        rc_a, env_a = check(algo)
        assert rc_a == 1 and env_a["code"] == "UNREADABLE", \
            f"a hash the engine cannot compare must not read as a pass: rc={rc_a} {env_a['code']} {env_a['summary'][:120]}"
        # ...named, not merely counted. "1 section is not being checked" without
        # saying which one is a finding nobody can act on.
        unv = env_a["data"].get("unverified") or []
        assert unv and unv[0]["id"] == "config.reference.table" \
            and unv[0]["reason"] == "unreadable-hash-algorithm" and unv[0]["line"] == 5, \
            f"the envelope must name the unverifiable section by id, line and reason: {unv}"
        # ...and NOT as drift either: ADR-008 is right that an algorithm change is
        # not the user's code changing. Refusing to verify is the honest verdict;
        # crying drift would be the other way to get this wrong.
        assert env_a["data"]["counts"].get("driftTotal") == 0, \
            f"an algorithm mismatch is not drift: {env_a['data']['counts']}"
        sy_a = subprocess.run(["node", KDF, "sync", "--apply-all", "--json"], cwd=algo,
                              capture_output=True, text=True, timeout=300, env=fenv)
        assert sy_a.returncode == 0, f"sync could not re-baseline an unreadable algorithm: {sy_a.stdout[-200:]}"
        rc_a2, env_a2 = check(algo)
        assert env_a2["code"] != "UNREADABLE", \
            f"sync ran but the section is still unverifiable: {env_a2['code']} {env_a2['summary'][:120]}"
        algo_doc = open(os.path.join(algo, "docs", "x.md"), encoding="utf-8").read()
        assert "h2:" not in algo_doc and "hash=h1:" in algo_doc, \
            f"sync must re-baseline the marker onto the current algorithm: {algo_doc}"
        print("  PASS  parser fails closed: absent package scope is dead (real scope still clean), "
              "5 unknown-key spellings refused with 3 legitimate binds intact, refused markers reach "
              "exit 1 + UNREADABLE, a hashless gen region and an uncomparable hash algorithm are both "
              "unverified-and-named (not drift, not clean) and one sync repairs each, "
              "generation gate names a newer reader and is never emitted")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"parser fails closed: {why(e)}")

    # KEEL-11's freeze. Section 12 of the spec enumerates what a conforming reader
    # may rely on, and a frozen promise nothing checks is the defect this project
    # exists to detect - published, this time, in the document third parties would
    # implement from. Every rule in section 12 is probed against the shipped
    # parser here, so prose and parser cannot drift apart silently.
    try:
        probe = node_json(subprocess.run(["node", "--input-type=module", "-e", (
            'import {parseDoc} from "%s/src/anchors.js";'
            'const out = {};'
            'for (const [k, doc] of JSON.parse(process.argv[1])) {'
            '  const r = parseDoc(doc + "\\\\n", "d.md");'
            '  out[k] = (r.anchors.length + r.regions.length)'
            '    ? "accepted" : (r.quarantined.length ? "refused:" + r.quarantined[0].reason : "IGNORED");'
            '}'
            'console.log(JSON.stringify(out));') % ROOT_URL, json.dumps([
                # envelope: `>` in a value is refused by name, never ignored
                ["gt", "<!-- keeldocs: id=a.b binds=fact:x/GET /a?q=>1 -->"],
                # layout
                ["nospace", "<!--keeldocs:genid=a.b hash=h1:00112233-->x<!-- /keeldocs:gen -->"],
                ["multiline", "<!-- keeldocs: id=a.b\n  binds=fact:x/* -->"],
                ["indented", "    <!-- keeldocs: id=a.b binds=fact:x/y -->"],
                ["blockquoted", "> <!-- keeldocs: id=a.b binds=fact:x/y -->"],
                ["fenced", "```\n<!-- keeldocs: id=a.b binds=fact:x/y -->\n```"],
                # keys
                ["idonly", "<!-- keeldocs: id=a.b -->"],
                ["orderswap", "<!-- keeldocs: hash-kind=fact binds=fact:x/y id=a.b -->"],
                ["dupkey", "<!-- keeldocs: id=a.b id=c.d -->"],
                # identity
                ["slashid", "<!-- keeldocs: id=a/b -->"],
                ["badrecipe", "<!-- keeldocs: id=a.b recipe=erd@x -->"],
                ["bareclose", "<!-- keeldocs:gen id=a.b -->x<!-- /keeldocs: -->"],
            ])], capture_output=True, text=True, timeout=180), "spec section 12 probe")
        FROZEN = {
            "gt": "refused:malformed-marker",
            "nospace": "accepted", "multiline": "accepted",
            "indented": "accepted", "blockquoted": "accepted",
            "fenced": "IGNORED",
            "idonly": "accepted", "orderswap": "accepted",
            "dupkey": "refused:duplicate-key:id",
            "slashid": "refused:bad-id", "badrecipe": "refused:bad-recipe",
            "bareclose": "refused:unbalanced-close",
        }
        wrong = {k: (probe[k], v) for k, v in FROZEN.items() if probe.get(k) != v}
        assert not wrong, "the parser no longer matches the frozen spec section 12:\n    " + \
            "\n    ".join(f"{k}: parser says {got!r}, spec says {want!r}" for k, (got, want) in wrong.items())
        # The freeze must actually be declared, and only where the policy it
        # depends on exists - a freeze without section 11 is a promise with no
        # migration path behind it.
        spec = open(os.path.join(ROOT, "spec", "anchor-spec.md"), encoding="utf-8").read()
        assert "Frozen at 1.0" in spec, "section 8 does not declare the freeze"
        for heading in ("## 11. Compatibility policy", "## 12. The frozen surface"):
            assert heading in spec, f"the freeze cites {heading!r}, which is not in the spec"
        print(f"  PASS  spec 1.0 freeze: {len(FROZEN)} frozen parser behaviours match section 12, "
              "policy and surface both present")
    except Exception as e:
        failures.append(f"spec 1.0 freeze: {why(e)}")

    # KEEL-24 / E16. The plugin + marketplace path. `claude plugin validate .
    # --strict` is the authoritative check and it passes (proven by mutation: a
    # non-kebab name and a string `author` both make it exit 1), but it needs the
    # `claude` binary, which no CI runner has. So the invariants this repo depends
    # on are asserted portably here, and the experiment records the real run.
    try:
        pdir = os.path.join(ROOT, ".claude-plugin")
        plug = json.load(open(os.path.join(pdir, "plugin.json"), encoding="utf-8"))
        mkt = json.load(open(os.path.join(pdir, "marketplace.json"), encoding="utf-8"))
        kebab = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
        assert kebab.match(plug.get("name", "")), f"plugin name must be kebab-case: {plug.get('name')!r}"
        assert isinstance(plug.get("author"), dict) and plug["author"].get("name"), \
            "plugin `author` is an OBJECT with a name, not a string - the validator rejects the string form"
        assert kebab.match(mkt.get("name", "")), f"marketplace name must be kebab-case: {mkt.get('name')!r}"
        # --strict treats a missing marketplace description as an error, and a
        # repo that only ever runs the lenient form would not know.
        assert (mkt.get("description") or "").strip(), \
            "marketplace needs a description; `claude plugin validate --strict` fails without one"
        assert isinstance(mkt.get("owner"), dict) and mkt["owner"].get("name"), "marketplace owner needs a name"
        entries = mkt.get("plugins") or []
        assert entries, "marketplace lists no plugins"
        for e in entries:
            assert e.get("name") and e.get("source"), f"marketplace entry incomplete: {e}"
            src = e["source"]
            assert isinstance(src, str) and src.startswith("./"), \
                f"only repo-relative sources are used here; {src!r} would not resolve from a git marketplace"
            assert ".." not in src, "source path traversal"
            target = os.path.normpath(os.path.join(ROOT, src))
            assert os.path.isfile(os.path.join(target, ".claude-plugin", "plugin.json")), \
                f"marketplace entry {e['name']} points at {src}, which has no plugin.json"
        # Skills are auto-discovered from skills/<name>/SKILL.md - no manifest
        # entry - so an unrecognised frontmatter key is how a skill goes missing
        # through the plugin path while working through `skills install`.
        KNOWN_FM = {"name", "description", "when_to_use", "argument-hint", "arguments",
                    "disable-model-invocation", "user-invocable", "allowed-tools",
                    "disallowed-tools", "model", "effort", "context", "agent",
                    "background", "hooks", "paths", "shell"}
        checked_fm = 0
        for sk in sorted(glob.glob(os.path.join(ROOT, "skills", "*", "SKILL.md"))):
            head = open(sk, encoding="utf-8").read().split("---")[1]
            keys = {l.split(":", 1)[0].strip() for l in head.strip().split("\n")
                    if ":" in l and not l.startswith((" ", "\t", "#"))}
            unknown = sorted(keys - KNOWN_FM)
            assert not unknown, f"{os.path.relpath(sk, ROOT)}: frontmatter key(s) {unknown} are not recognised"
            assert "name" in keys and "description" in keys, \
                f"{os.path.relpath(sk, ROOT)}: a plugin skill needs name and description"
            checked_fm += 1
        assert checked_fm >= 5, f"only {checked_fm} skills checked - the frontmatter gate is thin"
        print(f"  PASS  plugin manifests: marketplace + plugin valid, {len(entries)} entry, "
              f"{checked_fm} skill frontmatters use only recognised keys")
    except Exception as e:
        failures.append(f"plugin manifests: {why(e)}")

    # KEEL-17. `keeldocs noise` - the counts-only report a cohort member can paste
    # into a public issue. The journal it summarizes is made of document paths,
    # section ids and fact ids, so "counts only" is a claim about the one thing
    # that could leak a private repository's map into a public tracker. The
    # fixture journal below is deliberately full of names that would be obvious
    # in the output if any of them survived.
    try:
        import shutil as _sh17, tempfile as _tf17
        tmp = _tf17.mkdtemp(prefix="keeldocs-noise-")
        os.makedirs(os.path.join(tmp, ".keeldocs"))
        SECRETS = ["acme-billing-internal", "GET /admin/keys/rotate",
                   "docs/private/customer-migration.md", "payments.reconciliation.table"]
        END = "2026-08-05T00:00:00.000Z"
        rows = [
            # (type, target, days before END) - week 1 is the oldest of the four
            ("applied", f"docs/private/customer-migration.md#{SECRETS[0]}", 22),
            ("rejection", f"fact:http-endpoints/{SECRETS[1]}", 15),
            ("rejection", SECRETS[3], 15),
            ("applied", SECRETS[2], 8),
            ("rejection", SECRETS[3], 8),
            ("snooze", SECRETS[0], 1),
            ("tombstone", SECRETS[3], 1),
            ("rejection", SECRETS[1], 1),
            ("applied", SECRETS[2], 0),
            ("applied", SECRETS[0], 40),   # outside the window - must not be counted
        ]
        end_ms = 1785888000000  # 2026-08-05T00:00:00Z, stated rather than computed
        lines = []
        for typ, target, ago in rows:
            at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime((end_ms - ago * 86400000) / 1000)) + ".000Z"
            lines.append(json.dumps({"at": at, "target": target, "type": typ}, sort_keys=True))
        lines.append("{ this line is not json")   # the malformed-line path
        W(os.path.join(tmp, ".keeldocs", "decisions.jsonl"), "\n".join(lines) + "\n")

        KDN = os.path.join(ROOT, "bin", "keeldocs.js")
        r = subprocess.run(["node", KDN, "noise", "--json"], cwd=tmp,
                           capture_output=True, text=True, timeout=120)
        env = node_json(r, "keeldocs noise --json")
        d = env["data"]
        assert r.returncode == 0 and env["ok"], f"noise exited {r.returncode}: {env}"
        assert d["windowEnd"] == END, f"window must anchor on the newest entry, got {d['windowEnd']}"
        assert d["entries"] == 9, f"9 entries in window (one is 40 days old), got {d['entries']}"
        assert d["counts"]["applied"] == 3 and d["counts"]["rejection"] == 4, \
            f"counts wrong: {d['counts']}"
        assert d["malformed"] == 1, "a malformed journal line must be counted, not silently dropped"
        assert d["acceptRate"] == 0.429, f"3/7 = 0.429, got {d['acceptRate']}"
        # The self-throttle needs rejections to OUTNUMBER applies 2:1, not merely
        # to lead: 4 vs 3 stays normal. Both branches are checked, because a rule
        # only ever observed on one side of its threshold is not observed.
        assert d["nudgeLevel"] == "normal", f"4 rejections against 3 applies is not 2:1: {d['nudgeLevel']}"
        assert [w["applied"] for w in d["weeks"]] == [1, 0, 1, 1], f"week buckets: {d['weeks']}"
        assert [w["rejected"] for w in d["weeks"]] == [0, 2, 1, 1], f"week buckets: {d['weeks']}"

        # The claim, checked against both output shapes.
        plain = subprocess.run(["node", KDN, "noise"], cwd=tmp, capture_output=True, text=True, timeout=120)
        assert plain.returncode == 0, f"noise (human) exited {plain.returncode}"
        for blob, what in ((r.stdout, "--json"), (plain.stdout, "human")):
            for s in SECRETS + ["docs/", "fact:", ".md", "admin"]:
                assert s not in blob, f"{what} output leaked {s!r} - the journal's targets must not survive"
        # Pure function of the journal: no clock, no extraction, so two runs match.
        again = subprocess.run(["node", KDN, "noise", "--json"], cwd=tmp, capture_output=True, text=True, timeout=120)
        assert again.stdout == r.stdout, "noise is not deterministic on an unchanged journal"
        # The other side of the threshold: 3 rejections, nothing applied.
        quiet_dir = os.path.join(tmp, "quiet", ".keeldocs")
        os.makedirs(quiet_dir)
        W(os.path.join(quiet_dir, "decisions.jsonl"), "\n".join(
            json.dumps({"at": f"2026-08-0{i + 1}T00:00:00.000Z", "target": "x", "type": "rejection"},
                       sort_keys=True) for i in range(3)) + "\n")
        q = node_json(subprocess.run(["node", KDN, "noise", "--json"], cwd=os.path.dirname(quiet_dir),
                                     capture_output=True, text=True, timeout=120), "noise (quiet)")
        assert q["data"]["nudgeLevel"] == "quiet", f"3 rejections and 0 applies must throttle: {q['data']}"
        assert q["data"]["acceptRate"] == 0.0, f"0 of 3 applied is a rate of 0, not null: {q['data']}"
        # And the third case, which is the one a rate can lie about: decisions
        # exist but none of them was an accept-or-reject. A rate of 0 there is a
        # claim that everything proposed was refused; the answer is "no data".
        none_dir = os.path.join(tmp, "undecided", ".keeldocs")
        os.makedirs(none_dir)
        W(os.path.join(none_dir, "decisions.jsonl"),
          json.dumps({"at": "2026-08-01T00:00:00.000Z", "target": "x", "type": "snooze"}, sort_keys=True) + "\n")
        u = node_json(subprocess.run(["node", KDN, "noise", "--json"], cwd=os.path.dirname(none_dir),
                                     capture_output=True, text=True, timeout=120), "noise (undecided)")
        assert u["data"]["acceptRate"] is None, \
            f"nothing decided must report no rate, not a rate of zero: {u['data']['acceptRate']}"
        assert "n/a" in u["summary"], f"the summary must say so in words: {u['summary']}"
        # Opt-in means nothing else reaches for it.
        for rel in ("check.js", "init.js", "sync.js"):
            body = open(os.path.join(ROOT, "src", rel), encoding="utf-8").read()
            assert "noise.js" not in body, f"src/{rel} imports the noise report - it must stay opt-in"
        print("  PASS  noise report: counts only (7 decisions, 4 weekly buckets, 1 malformed line), "
              "no journal target survives either output, deterministic, invoked by nothing else")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"noise report: {why(e)}")

    # KEEL-30. `[providers] exclude-paths` - the path scope. Every assertion is
    # paired with the same run WITHOUT the scope, because a gate that only checks
    # "the fixture var is absent" passes just as happily when extraction found
    # nothing at all.
    try:
        import shutil as _sh30, tempfile as _tf30
        tmp = _tf30.mkdtemp(prefix="keeldocs-scope-")
        W(os.path.join(tmp, "package.json"), '{"name":"scope-fixture","version":"1.0.0"}\n')
        os.makedirs(os.path.join(tmp, "fixtures", "sample"))
        # SHARED is read from both sides: the fact must survive with the fixture
        # read site pruned, because an env var the application reads is the
        # application's however many fixtures also touch it.
        W(os.path.join(tmp, "app.js"),
          "const a = process.env.APP_ONLY;\nconst b = process.env.SHARED;\n")
        W(os.path.join(tmp, "fixtures", "sample", "demo.js"),
          "const c = process.env.FIXTURE_ONLY;\nconst d = process.env.SHARED;\n")

        def envfacts(exclude):
            r = subprocess.run(["node", "-e", (
                'import("%s/src/facts.js").then(({extractAll}) => {'
                'const r = extractAll(process.argv[1], {excludePaths: JSON.parse(process.argv[2])});'
                'const e = [...r.factsById.values()].filter(f => f.payload.type === "env-var");'
                'console.log(JSON.stringify({err: r.toolError ?? null, scopedOut: r.scopedOut,'
                ' names: e.map(f => f.payload.attrs.name).sort(),'
                ' sites: Object.fromEntries(e.map(f => [f.payload.attrs.name,'
                '   (f.provenance.source ?? []).map(s => s.file).sort()]))}));'
                '});') % ROOT_URL, tmp, json.dumps(exclude)],
                capture_output=True, text=True, timeout=600,
                env={**os.environ, "KEELDOCS_NO_CACHE": "1"})
            out = node_json(r, f"extract excludePaths={exclude}")
            assert not out["err"], f"extraction failed: {out['err']}"
            return out

        wide = envfacts([])
        assert "FIXTURE_ONLY" in wide["names"], \
            f"control: without a scope the fixture var must be found, got {wide['names']}"
        assert wide["scopedOut"] == 0, "control: nothing is scoped out when nothing is excluded"
        assert len(wide["sites"]["SHARED"]) == 2, \
            f"control: SHARED must have both read sites, got {wide['sites']['SHARED']}"

        scoped = envfacts(["fixtures/**"])
        assert "FIXTURE_ONLY" not in scoped["names"], "a fixture-only fact survived the scope"
        assert "APP_ONLY" in scoped["names"], "the scope removed a fact it was never given"
        assert scoped["scopedOut"] >= 1, "the report must count what the scope removed"
        assert "SHARED" in scoped["names"], \
            "a fact read from BOTH sides must survive with the excluded site pruned, not be dropped whole"
        assert scoped["sites"]["SHARED"] == ["app.js"], \
            f"SHARED must keep the app read site and lose the fixture one, got {scoped['sites']['SHARED']}"
        # A nested checkout is somebody else's code. git does not track through
        # one, and neither should extraction: an agent worktree under .claude/
        # put this repository's whole fixture tree back into its own dogfood and
        # took it from 12 documented surfaces to 32. The control matters more
        # than the assertion - remove the nested .git and the same file must be
        # found again, or this passes because the walk broke.
        vend = os.path.join(tmp, "fixtures", "vendored")
        os.makedirs(os.path.join(vend, ".git"))
        W(os.path.join(vend, "lib.js"), "const v = process.env.VENDORED_VAR;\n")
        assert "VENDORED_VAR" not in envfacts([])["names"], \
            "a nested checkout's facts must not be this repository's"
        rmtree(os.path.join(vend, ".git"))
        assert "VENDORED_VAR" in envfacts([])["names"], \
            "control: without the nested .git the same file must be found, or the walk is simply broken"
        rmtree(vend)

        # The scope is repo-relative and must not be satisfiable by a bare name.
        assert "FIXTURE_ONLY" in envfacts(["demo.js"])["names"], \
            "`demo.js` is a repo-root path, not a basename - matching it anywhere would make every scope over-broad"

        # The other half: an excluded path must not reach the sandbox VIEW either,
        # or a provider could still read what the repository owner scoped out on
        # any host where a view is built. Checked through the resolver rather than
        # through a mount, so it holds on every platform.
        view = node_json(subprocess.run(["node", "-e", (
            'import("%s/src/scope.js").then(({repoFiles, resolveInputs}) => {'
            'const root = process.argv[1];'
            'const wide = repoFiles(root), scoped = repoFiles(root, ["fixtures/**"]);'
            'console.log(JSON.stringify({'
            ' wide: resolveInputs(root, ["**/*.js"], wide).files,'
            ' scoped: resolveInputs(root, ["**/*.js"], scoped).files}));'
            '});') % ROOT_URL, tmp], capture_output=True, text=True, timeout=120), "resolveInputs")
        assert "fixtures/sample/demo.js" in view["wide"], \
            f"control: an unscoped view must contain the fixture, got {view['wide']}"
        assert view["scoped"] == ["app.js"], \
            f"an excluded path reached the provider's view: {view['scoped']}"
        print("  PASS  path scope: fixture-only facts removed, shared read sites pruned, "
              f"app facts and the unscoped control both intact ({scoped['scopedOut']} scoped out)")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"path scope: {why(e)}")

    # `argMode: schemaFile` makes DETECTION double as file SELECTION, and the
    # selection was the first basename match in a sorted depth-first walk. So a
    # monorepo with two `schema.prisma` files parsed one of them, said nothing
    # about the other, and reported CLEAN at 100% coverage - a ratio whose
    # denominator had silently dropped a whole service's database. `drizzle` and
    # `sql-replay` both already name what they skipped (`chain-ignored`); the one
    # provider that could not was the most used one. The control is the point of
    # this gate: a single-schema repo must produce NO gap, or "gaps appear" is
    # all that is being asserted and the finding could never regress into view.
    try:
        import shutil as _sh_ms, tempfile as _tf_ms
        tmp = _tf_ms.mkdtemp(prefix="keeldocs-multischema-")
        KDMS = os.path.join(ROOT, "bin", "keeldocs.js")
        API = ('datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n'
               'model User {\n  id    Int    @id @default(autoincrement())\n'
               '  email String @unique\n}\n')
        BILL = ('datasource db { provider = "postgresql" url = env("BILLING_URL") }\n'
                'model Invoice {\n  id     Int    @id @default(autoincrement())\n'
                '  amount Int\n}\n')

        def prisma_repo(name, schemas):
            d = os.path.join(tmp, name)
            os.makedirs(d)
            W(os.path.join(d, "package.json"),
              '{"name":"%s","version":"1.0.0","dependencies":{"prisma":"^5.0.0"}}\n' % name)
            for rel, body in schemas:
                os.makedirs(os.path.join(d, os.path.dirname(rel)), exist_ok=True)
                W(os.path.join(d, *rel.split("/")), body)
            for c in (["init", "-q", "."], ["config", "user.email", "t@t"],
                      ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "i"]):
                subprocess.run(["git", *c], cwd=d, capture_output=True, timeout=60)
            r = subprocess.run(["node", KDMS, "init", "--yes", "--json"], cwd=d,
                               capture_output=True, text=True, timeout=600,
                               env={**os.environ, "CI": ""})
            assert r.returncode == 0, f"{name}: init rc={r.returncode}: {r.stdout[-300:]}{r.stderr[-300:]}"
            c2 = subprocess.run(["node", KDMS, "check", "--json"], cwd=d,
                                capture_output=True, text=True, timeout=600,
                                env={**os.environ, "CI": ""})
            env2 = node_json(c2, f"check in {name}")
            spill = json.load(open(os.path.join(d, *env2["full"].split("/")), encoding="utf-8"))
            return env2, spill

        # Control first: ONE schema, and nothing may be reported as skipped.
        env_one, spill_one = prisma_repo("single", [("prisma/schema.prisma", API)])
        assert not [g for g in spill_one.get("extractionGaps", []) if g["kind"] == "schema-ignored"], \
            f"control: a repo with one schema must report nothing skipped: {spill_one.get('extractionGaps')}"
        assert "extraction gap" not in env_one["summary"], \
            f"control: the summary must stay quiet when there is nothing to say: {env_one['summary']}"
        assert any(k.endswith("/User") for k in
                   [f["id"] for f in spill_one["findings"]] + list(spill_one["coverage"]["perCapability"])) \
            or spill_one["coverage"]["perCapability"].get("db-schema", {}).get("total"), \
            f"control: the single-schema repo must document a table at all: {spill_one['coverage']}"

        # The case: two schemas, and the one that was not read must be NAMED.
        env_two, spill_two = prisma_repo("mono", [("apps/api/prisma/schema.prisma", API),
                                                  ("apps/billing/prisma/schema.prisma", BILL)])
        skipped = [g for g in spill_two.get("extractionGaps", []) if g["kind"] == "schema-ignored"]
        assert [g["file"] for g in skipped] == ["apps/billing/prisma/schema.prisma"], \
            f"the schema the engine chose not to read must be named, once, by path: {spill_two.get('extractionGaps')}"
        # ...and the headline number must stop reading like a repo with one database.
        assert "extraction gap" in env_two["summary"], \
            f"coverage is a ratio; a dropped input has to be legible beside it: {env_two['summary']}"
        # The defect's own observable, pinned so a future change that reads BOTH
        # schemas is caught here rather than silently making this gate vacuous.
        db = spill_two["coverage"]["perCapability"].get("db-schema", {})
        assert db.get("total") == 1, \
            f"expected exactly one table from the chosen schema (this gate must be re-thought if both are read now): {db}"
        print("  PASS  schemaFile selection: two schema.prisma - one read, the other named as a gap "
              "and counted beside coverage; single-schema control reports nothing skipped")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"schemaFile selection: {why(e)}")

    # `argMode: root` threw away the path detection had just proved, and three
    # extractors re-derived it at the repository root: rails re-joined
    # `config/routes.rb`, next-routes re-tested `app` and `src/app`, compose
    # re-walked its four filenames, and sql-policies' MIGRATION_DIRS were four
    # root-anchored literals. Measured on `main` before this gate existed, on
    # fixtures/nested-layout-scenario: `http-endpoints`, `client-routes`,
    # `services-topology` and `db-policies` each reported `status: ok` with an
    # EMPTY fact set, no gap of any kind, and `check` exited 0 - the strongest
    # form of the class this file's changelog opens with, because the answer is
    # not merely smaller, it is nothing.
    #
    # The root-layout twin is the control and it is the whole point. Every other
    # rails, next, compose and sql-policies fixture in this tree is root-layout,
    # so every one of their goldens passed against a shape none of them
    # contained. A nested gate that passed because the nested fixture had
    # stopped containing routes would still pass; the twin pins what this exact
    # content produces, and the two trees hold the four inputs byte for byte.
    try:
        import shutil as _sh_nl, tempfile as _tf_nl
        # The outer `kd` is shadowed by a later block's own local of the same
        # name; use an explicit runner rather than depending on which one wins.
        def kdx(cwd, *a):
            return subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), *a],
                                  cwd=cwd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, "CI": ""})

        NEST = os.path.join(ROOT, "fixtures", "nested-layout-scenario")
        ROOTFX = os.path.join(ROOT, "fixtures", "root-layout-scenario")

        def extract(script, root, detected=None):
            cmd = [sys.executable, os.path.join(ROOT, *script.split("/")), root]
            if detected:
                cmd.append(os.path.join(root, *detected.split("/")))
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=180)
            assert r.returncode == 0, f"{script}: rc={r.returncode} {r.stderr[-300:]}"
            return json.loads(r.stdout)

        RAILS = "providers/http-endpoints/rails/extract_rails.py"
        NEXT = "providers/client-routes/next-routes/extract_next.py"
        COMPOSE = "providers/services-topology/compose/extract_compose.py"
        POLICIES = "providers/db-policies/sql-policies/extract_policies.py"

        # (1) The twins hold the same bytes, so a count that moves here means the
        #     fixture changed, not the layout. Asserted rather than assumed.
        for a, b in (("apps/api/config/routes.rb", "config/routes.rb"),
                     ("apps/web/next.config.ts", "next.config.ts"),
                     ("apps/web/app/page.tsx", "app/page.tsx"),
                     ("apps/web/app/dashboard/page.tsx", "app/dashboard/page.tsx"),
                     ("apps/web/app/api/health/route.ts", "app/api/health/route.ts"),
                     ("deploy/docker-compose.yml", "docker-compose.yml"),
                     ("packages/db/migrations/0001_init.sql", "migrations/0001_init.sql"),
                     ("packages/db/migrations/0002_policies.sql", "migrations/0002_policies.sql")):
            assert open(os.path.join(NEST, *a.split("/")), "rb").read() == \
                   open(os.path.join(ROOTFX, *b.split("/")), "rb").read(), \
                   f"the twins have drifted apart: {a} != {b}"

        # (2) CONTROL: the root-layout twin still extracts in full. These numbers
        #     are the fixture's content, so a nested gate cannot pass by the
        #     nested tree quietly emptying out.
        r_rails = extract(RAILS, ROOTFX)
        r_next = extract(NEXT, ROOTFX)
        r_comp = extract(COMPOSE, ROOTFX)
        r_pol = extract(POLICIES, ROOTFX)
        assert len(r_rails["endpoints"]) == 18, \
            f"control: root config/routes.rb must still yield 18 endpoints, got {len(r_rails['endpoints'])}"
        assert not r_rails["warnings"], f"control: a root routes.rb is not a gap: {r_rails['warnings']}"
        assert len(r_next["routes"]) == 3, \
            f"control: root app/** must still yield 3 routes, got {len(r_next['routes'])}"
        assert not r_next["warnings"], f"control: a root app/ is not a gap: {r_next['warnings']}"
        owned = [s for s in r_comp["services"] if s["kind"] == "owned"]
        assert len(owned) == 2, f"control: a root compose file must still yield 2 owned services, got {owned}"
        assert (len(r_pol["policies"]), len(r_pol["rls"])) == (2, 1), \
            f"control: root migrations/ must still yield 2 policies + 1 rls, got " \
            f"{len(r_pol['policies'])}/{len(r_pol['rls'])}"

        # (3) THE CASE: the same bytes, one directory deeper. Same counts, and
        #     every receipt points at the nested path rather than a root guess.
        n_rails = extract(RAILS, NEST, "apps/api/config/routes.rb")
        n_next = extract(NEXT, NEST, "apps/web/next.config.ts")
        n_comp = extract(COMPOSE, NEST, "deploy/docker-compose.yml")
        n_pol = extract(POLICIES, NEST)
        assert len(n_rails["endpoints"]) == 18 and \
            {e["file"] for e in n_rails["endpoints"]} == {"apps/api/config/routes.rb"}, \
            f"nested routes.rb: {len(n_rails['endpoints'])} endpoints from " \
            f"{sorted({e['file'] for e in n_rails['endpoints']})}"
        assert len(n_next["routes"]) == 3 and \
            all(r["file"].startswith("apps/web/app/") for r in n_next["routes"]), \
            f"nested app router: {n_next['routes']}"
        assert len([s for s in n_comp["services"] if s["kind"] == "owned"]) == 2 and \
            n_comp.get("file") == "deploy/docker-compose.yml", \
            f"nested compose: {n_comp.get('file')} {n_comp['services']}"
        assert (len(n_pol["policies"]), len(n_pol["rls"])) == (2, 1) and \
            {p["file"] for p in n_pol["policies"]} == {"packages/db/migrations/0001_init.sql",
                                                       "packages/db/migrations/0002_policies.sql"}, \
            f"nested migrations: {n_pol}"

        # (4) End to end, through the engine, which is where the defect was
        #     visible: `status: ok` over nothing, and a coverage figure that read
        #     like a repository with no API, no screens, no services and no RLS.
        tmp = _tf_nl.mkdtemp(prefix="keeldocs-nested-layout-")
        dst = os.path.join(tmp, "repo")
        _sh_nl.copytree(NEST, dst, ignore=_sh_nl.ignore_patterns("golden", ".keeldocs"))
        for c in (["init", "-q", "."], ["config", "user.email", "t@t"],
                  ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "i"]):
            subprocess.run(["git", *c], cwd=dst, capture_output=True, timeout=60)
        ri = kdx(dst, "init", "--yes", "--json")
        assert ri.returncode == 0, f"nested init rc={ri.returncode}: {ri.stdout[-400:]}{ri.stderr[-400:]}"
        caps = json.loads(ri.stdout)["data"]["card"]["capabilities"]
        counts = {}
        for cap in ("http-endpoints", "client-routes", "services-topology", "db-policies"):
            path = os.path.join(dst, ".keeldocs", "cache", "facts", f"{cap}.jsonl")
            counts[cap] = len([l for l in open(path, encoding="utf-8")]) if os.path.exists(path) else 0
        # The exact shape the gate forbids: ok, and nothing behind it.
        vacuous = [c for c in counts if caps[c]["status"] == "ok" and counts[c] == 0]
        assert not vacuous, \
            f"capabilities reporting `status: ok` over an EMPTY fact set: {vacuous} ({counts})"
        assert counts == {"http-endpoints": 18, "client-routes": 3,
                          "services-topology": 3, "db-policies": 3}, counts
        rc = kdx(dst, "check", "--json")
        envc = node_json(rc, "nested check")
        assert rc.returncode == 0 and envc["code"] == "CLEAN", f"{rc.returncode} {envc['summary']}"
        # `0.4.2` summarised this exact tree as `no facts` - a coverage ratio with
        # nothing in either term, printed beside four capabilities reporting `ok`.
        assert "no facts" not in envc["summary"], envc["summary"]
        # the receipts a user reads must name the nested files, not a root guess
        ep = open(os.path.join(dst, "docs", "reference", "endpoints.md"), encoding="utf-8").read()
        assert "apps/api/config/routes.rb" in ep, "the endpoint table must cite the nested routes.rb"
        rmtree(tmp)
        print("  PASS  nested layout: rails/next/compose/sql-policies all extract from a monorepo "
              "(18 endpoints, 3 routes, 3 services, 3 policy facts, nested receipts); "
              "root-layout twin control unchanged")
    except Exception as e:
        failures.append(f"nested layout: {why(e)}")

    # The second half of the same mechanism. `detect.files` is a basename match
    # over the whole tree and `argMode: detectedFile` makes it a SELECTION, so
    # the engine must name every candidate it did not choose - the argument
    # `schema-ignored` and `chain-ignored` already make. Which candidate wins is
    # the walk's order and this gate deliberately does NOT assert it: that would
    # be a claim about Docker's own file precedence, which nothing here has
    # checked. The control is the load-bearing half - one compose file must
    # produce NO gap, or all this asserts is that gaps appear.
    try:
        import shutil as _sh_ci, tempfile as _tf_ci
        # The outer `kd` is shadowed by a later block's own local of the same
        # name; use an explicit runner rather than depending on which one wins.
        def kdx(cwd, *a):
            return subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), *a],
                                  cwd=cwd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, "CI": ""})

        tmp = _tf_ci.mkdtemp(prefix="keeldocs-candidate-")

        def compose_repo(name, extra_names=()):
            d = os.path.join(tmp, name)
            _sh_ci.copytree(os.path.join(ROOT, "fixtures", "root-layout-scenario"), d,
                            ignore=_sh_ci.ignore_patterns("golden", ".keeldocs"))
            for extra in extra_names:
                _sh_ci.copyfile(os.path.join(d, "docker-compose.yml"), os.path.join(d, extra))
            for c in (["init", "-q", "."], ["config", "user.email", "t@t"],
                      ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "i"]):
                subprocess.run(["git", *c], cwd=d, capture_output=True, timeout=60)
            assert kdx(d, "init", "--yes", "--json").returncode == 0, name
            rr = kdx(d, "check", "--json")
            ee = node_json(rr, f"check in {name}")
            sp = json.load(open(os.path.join(d, *ee["full"].split("/")), encoding="utf-8"))
            return ee, [g for g in sp.get("extractionGaps", []) if g["kind"] == "candidate-ignored"]

        env_one, ign_one = compose_repo("one")
        assert not ign_one, f"control: a single compose file must name nothing as ignored: {ign_one}"
        assert "extraction gap" not in env_one["summary"], \
            f"control: the summary must stay quiet when there is nothing to say: {env_one['summary']}"
        env_two, ign_two = compose_repo("two", ("compose.yaml",))
        assert len(ign_two) == 1 and ign_two[0]["file"] in ("docker-compose.yml", "compose.yaml"), \
            f"the compose file the engine did not choose must be named, once, by path: {ign_two}"
        assert "extraction gap" in env_two["summary"], \
            f"an unread input has to be legible beside coverage: {env_two['summary']}"
        # ...and both candidates must be accounted for: one read, one named.
        assert {ign_two[0]["file"]} | {"docker-compose.yml", "compose.yaml"} == \
            {"docker-compose.yml", "compose.yaml"}, ign_two
        rmtree(tmp)
        print("  PASS  candidate selection: with two root compose files the unchosen one is named "
              "and counted beside coverage; the single-file control names nothing")
    except Exception as e:
        failures.append(f"candidate selection: {why(e)}")

    # Three normalizers still hardcoded `gaps: []` - `envFacts` (config-surface),
    # `liveTableFacts` (db-schema/tbls-live) and `policyFacts` (db-policies).
    # They are the last of the class `0.4.0` opened with `drizzle` (which
    # DECLARED `extraction-gap` for three releases while being structurally
    # unable to emit one) and `0.4.2` continued with `packageFacts` (which
    # collapsed a three-member workspace to one package in silence). A provider
    # in one of these capabilities could report a blind spot perfectly and the
    # engine would drop the sentence on the floor.
    #
    # Two of the three are proved with signed external stub providers, because a
    # stub is the only way to assert "whatever the extractor says, the engine
    # carries" rather than "this particular extractor happens to say something".
    # The third cannot be: `liveTableFacts` is dispatched by `reg.id ===
    # "tbls-live"` and the engine refuses a duplicate provider id outright
    # (verified: `duplicate provider id(s): tbls-live`, exit 2), so it is proved
    # through the real provider and the canned tbls seam instead - see the live
    # integration block, which now asserts the dropped view is NAMED.
    try:
        import shutil as _sh_gp, tempfile as _tf_gp
        # The outer `kd` is shadowed by a later block's own local of the same
        # name; use an explicit runner rather than depending on which one wins.
        def kdx(cwd, *a):
            return subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), *a],
                                  cwd=cwd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, "CI": ""})

        tmp = _tf_gp.mkdtemp(prefix="keeldocs-gappass-")
        author = os.path.join(tmp, "author")
        os.makedirs(author)
        STUBS = {
            "stub-config": ("config-surface", "env-var",
                            '{"vars": [], "warnings": [{"kind": "stub-config-gap", "file": "stub/config.env"}]}'),
            "stub-policies": ("db-policies", "policy",
                              '{"policies": [], "rls": [], '
                              '"warnings": [{"kind": "stub-policy-gap", "file": "stub/policy.sql"}]}'),
        }
        for pid, (cap, fact, out) in STUBS.items():
            d = os.path.join(author, pid)
            os.makedirs(d)
            W(os.path.join(d, "provider.yaml"),
              f"id: {pid}\ncapability: {cap}\nsemver: 1.0.0\ntier: code\n"
              f"entry: ./extract.py\ndetect: {{ always: true }}\ninputs: [\"**/*.stub\"]\n"
              f"timeout_class: A\nemits: [{fact}, extraction-gap]\n")
            W(os.path.join(d, "extract.py"), f"import json\nprint(json.dumps({out}))\n")
        dst = os.path.join(tmp, "repo")
        _sh_gp.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                        ignore=_sh_gp.ignore_patterns("golden", ".keeldocs"))
        r = kdx(author, "provider", "keygen", "--json")
        pub = json.loads(r.stdout)["data"]["publicKeyB64"]
        key = os.path.join(author, "keeldocs-signing-key.pem")
        assert kdx(dst, "provider", "trust", "acme", pub, "--json").returncode == 0
        for pid in STUBS:
            d = os.path.join(author, pid)
            assert kdx(author, "provider", "sign", d, "--key", key, "--signer", "acme",
                      "--json").returncode == 0, pid
            rr = kdx(dst, "provider", "add", d, "--yes", "--json")
            assert rr.returncode == 0, f"{pid}: {rr.stdout[-300:]}"
        assert kdx(dst, "init", "--yes", "--json").returncode == 0
        rc = kdx(dst, "check", "--json")
        envg = node_json(rc, "gap pass-through check")
        spill = json.load(open(os.path.join(dst, *envg["full"].split("/")), encoding="utf-8"))
        got = {(g["kind"], g["file"]) for g in spill.get("extractionGaps", [])}
        for want in (("stub-config-gap", "stub/config.env"), ("stub-policy-gap", "stub/policy.sql")):
            assert want in got, \
                f"a warning the extractor emitted never reached extractionGaps: {want} not in {sorted(got)}"
        # CONTROL: a gap is a receipt, not a verdict. If it moved the exit code
        # these assertions would be indistinguishable from asserting drift.
        assert rc.returncode == 0 and envg["code"] == "CLEAN", \
            f"an extraction gap must not move the verdict: {rc.returncode} {envg['summary']}"
        assert "extraction gap" in envg["summary"], envg["summary"]
        rmtree(tmp)
        print("  PASS  normalizer gap pass-through: config-surface and db-policies carry an extractor's "
              "warning to extractionGaps (was hardcoded `gaps: []`), and it moves no exit code")
    except Exception as e:
        failures.append(f"normalizer gap pass-through: {why(e)}")

    # KEEL-28. `emits:` reached the permission manifest a human reads before
    # consenting to a third-party provider, and stopped there: it never entered
    # the registry entry, so the engine could not have enforced it. The runtime
    # half now fails closed (src/facts.js) and every golden exercises it. This is
    # the static half - a token that is not a fact type cannot be emitted by
    # anything, so no run would ever catch it. `prisma` declared `column` and
    # `relation` from v0.1: attributes of a table fact, printed to users as fact
    # types the provider would produce.
    try:
        import re as _re
        facts_js = open(os.path.join(ROOT, "src", "facts.js"), encoding="utf-8").read()
        vocab = set(_re.findall(r'type:\s*"([a-z-]+)"', facts_js)) | {"extraction-gap"}
        assert len(vocab) > 10, f"fact-type vocabulary looks wrong: {sorted(vocab)}"
        bad, declared_by, shipped = [], {}, 0
        for yml in sorted(glob.glob(os.path.join(ROOT, "providers", "*", "*", "provider.yaml"))):
            body = open(yml, encoding="utf-8").read()
            rel = os.path.relpath(yml, ROOT).replace(os.sep, "/")
            if _re.search(r"^status:\s*stub\b", body, _re.M):
                continue  # declared, not shipped - the loader skips it too
            shipped += 1
            m = _re.search(r"^emits:\s*\[([^\]]*)\]", body, _re.M)
            assert m, f"{rel}: no `emits:` - the consent manifest would print nothing"
            toks = [t.strip() for t in m.group(1).split(",") if t.strip()]
            assert toks, f"{rel}: `emits:` is empty"
            for t in toks:
                declared_by.setdefault(t, []).append(rel)
                if t not in vocab:
                    bad.append(f"{rel}: emits `{t}`, which is not a fact type")
        assert not bad, "undeclarable emits:\n    " + "\n    ".join(bad)

        # The runtime half's harder case: a provider whose output is missing a
        # field its fact type needs. `models: [{fields: []}]` used to produce
        # `fact:db-schema/undefined` with an undefined `name`, and JSON.stringify
        # drops undefined keys - so the fact reached the fact file, the golden and
        # the document missing part of itself. Silent absence is the nastiest
        # false-drift source the provider contract names.
        #
        # Installed through the real T2 path (keygen -> sign -> trust -> add),
        # because a provider directory that the registry never loads would prove
        # nothing. Paired with a well-formed record in the same payload, so the
        # gate cannot pass by the provider dying outright.
        import shutil as _sh28, tempfile as _tf28
        mt = _tf28.mkdtemp(prefix="keeldocs-malformed-")
        auth = os.path.join(mt, "author"); os.makedirs(auth)
        pdir = os.path.join(auth, "halfwit"); os.makedirs(pdir)
        W(os.path.join(pdir, "provider.yaml"),
          "id: halfwit\ncapability: db-schema\nsemver: 1.0.0\ntier: code\n"
          "entry: ./extract.py\ndetect: { files: [\"halfwit.schema\"] }\n"
          "inputs: [\"**/*.schema\"]\ntimeout_class: A\nemits: [table]\n")
        W(os.path.join(pdir, "extract.py"),
          "import json, sys\n"
          "sys.stdout.write(json.dumps({\"models\": [{\"name\": \"Good\", \"fields\": []},\n"
          "                                          {\"fields\": []}], \"enums\": []}))\n")
        work = os.path.join(mt, "repo")
        _sh28.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), work,
                       ignore=_sh28.ignore_patterns("golden", ".keeldocs"))
        W(os.path.join(work, "halfwit.schema"), "x\n")
        KDM = os.path.join(ROOT, "bin", "keeldocs.js")
        menv = {**os.environ, "CI": ""}

        def kdm(cwd, *a):
            return subprocess.run(["node", KDM, *a], cwd=cwd, capture_output=True,
                                  text=True, timeout=600, env=menv)
        pub28 = json.loads(kdm(auth, "provider", "keygen", "--json").stdout)["data"]["publicKeyB64"]
        assert kdm(auth, "provider", "sign", pdir, "--key",
                   os.path.join(auth, "keeldocs-signing-key.pem"),
                   "--signer", "acme", "--json").returncode == 0, "sign failed"
        assert kdm(work, "provider", "trust", "acme", pub28, "--json").returncode == 0, "trust failed"
        assert kdm(work, "provider", "add", pdir, "--yes", "--json").returncode == 0, "install failed"
        # Through the CLI, so the trust keys the install just wrote are actually
        # loaded - the raw extractAll would refuse the provider it installed.
        rc28 = kdm(work, "check", "--json", "--no-cache")
        env28 = node_json(rc28, "check on the malformed provider")
        assert env28["code"] != "TOOL_ERROR", \
            f"one malformed record must not fail the whole run: {env28['summary']}"
        reports = sorted(glob.glob(os.path.join(work, ".keeldocs", "out", "check-*.json")),
                         key=os.path.getmtime)
        assert reports, "check wrote no report"
        rep28 = json.load(open(reports[-1], encoding="utf-8"))
        gaps28 = [g.get("kind", "") for g in rep28.get("extractionGaps", [])]
        caps28 = rep28.get("capabilities", {}).get("db-schema", {})
        assert any(k.startswith("malformed-fact: halfwit") for k in gaps28), \
            f"the drop must be a NAMED gap in the report, not silence: {gaps28}"
        assert "halfwit@1.0.0" in (caps28.get("providers") or []), \
            f"control: the provider must actually have run: {caps28}"
        _sh28.rmtree(mt, ignore_errors=True)

        # A gap is a receipt. The normalizers read `w.kind` and fell back to the
        # single word "unknown", while the Django endpoints provider spells the
        # field `reason` - so three distinct refusals (a non-literal route, a
        # regex route it will not compose, a urlconf outside the repository) all
        # reached the report saying nothing at all. Every shipped fixture that
        # produces a gap is checked, so this cannot pass by there being none.
        kinds = set()
        dj = node_json(subprocess.run(["node", "-e", (
            'import("%s/src/facts.js").then(({extractAll}) => {'
            'const r = extractAll(process.argv[1], {});'
            'console.log(JSON.stringify(r.gaps));'
            '});') % ROOT_URL, os.path.join(ROOT, "fixtures", "django-scenario")],
            capture_output=True, text=True, timeout=600,
            env={**os.environ, "KEELDOCS_NO_CACHE": "1"}), "django gaps")
        named = [g for g in dj if g.get("file")]
        assert named, "control: the django fixture must produce at least one file-anchored gap"
        for g in dj:
            kinds.add(g["kind"])
            assert g["kind"] not in ("unknown", "unspecified"), \
                f"a gap reached the report with its reason discarded: {g}"
        gapped = len(named)
        assert any("re_path" in k or "regex" in k for k in kinds), \
            f"the django fixture's regex-route refusal must survive as words: {sorted(kinds)}"
        print(f"  PASS  provider emits: {shipped} shipped providers declare only real fact types "
              f"({len(declared_by)} of {len(vocab)} in the vocabulary), enforced at extraction; "
              f"{gapped} gap(s) keep their stated reason")
    except Exception as e:
        failures.append(f"provider emits: {why(e)}")

    # KEEL-21. `skills/` and `adapters/` ship in the tarball and nothing had ever
    # run `skills install` from one. That is the precise blind spot the command
    # exists to close: the README used to tell users to copy a directory that does
    # not exist after `npx`, and no test could see it, because every test ran from
    # the git tree where the directory does exist. So this packs, extracts, and
    # installs from the ARTIFACT - never from ROOT - and re-runs to prove the
    # documented "safe to re-run" instead of restating it.
    try:
        import shutil, tempfile, tarfile  # noqa: F401
        npm = "npm.cmd" if os.name == "nt" else "npm"
        tmp = tempfile.mkdtemp(prefix="keeldocs-tarball-")
        r = subprocess.run([npm, "pack", "--pack-destination", tmp],
                           cwd=ROOT, capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, f"npm pack rc={r.returncode}: {r.stderr[-300:]}"
        tgz = [f for f in os.listdir(tmp) if f.endswith(".tgz")]
        assert len(tgz) == 1, f"expected one packed tarball, got {tgz}"
        with tarfile.open(os.path.join(tmp, tgz[0])) as tf:
            tf.extractall(tmp, filter="data")
        pkg_root = os.path.join(tmp, "package")
        cli = os.path.join(pkg_root, "bin", "keeldocs.js")
        adapters = os.path.join(pkg_root, "adapters")
        assert os.path.isdir(adapters), "the tarball ships no adapters/ - skills install cannot run for anyone"
        agents = sorted(d for d in os.listdir(adapters)
                        if os.path.isfile(os.path.join(adapters, d, "manifest.yaml")))
        assert agents, "the tarball ships adapters/ with no manifest"
        installed = 0
        for agent in agents:
            proj = os.path.join(tmp, f"proj-{agent}")
            os.makedirs(proj)
            r = subprocess.run(["node", cli, "skills", "install", "--agent", agent, "--json"],
                               cwd=proj, capture_output=True, text=True, timeout=120)
            env = node_json(r, f"skills install --agent {agent} (from tarball)")
            assert env["ok"] and env["code"] == "INSTALLED", f"{agent}: {env['code']} - {env['summary']}"
            assert env["data"]["written"], f"{agent}: installed zero skills"
            for rel in env["data"]["written"]:
                p = os.path.join(proj, *rel.split("/"))
                # The reported path is a claim, not proof; check the file.
                assert os.path.isfile(p), f"{agent}: reported {rel}, which was not written"
                assert "/skills/skills/" not in f"/{rel}/", f"{agent}: nested install at {rel}"
                head = open(p, encoding="utf-8").read().split("---")[1]
                for field in env["data"]["stripped"]:
                    assert not re.search(rf"^{re.escape(field)}\s*:", head, re.M), \
                        f"{agent}: SKILL.md kept `{field}:`, a key this agent rejects"
                installed += 1
            before = {rel: open(os.path.join(proj, *rel.split("/")), "rb").read()
                      for rel in env["data"]["written"]}
            r2 = subprocess.run(["node", cli, "skills", "install", "--agent", agent, "--json"],
                                cwd=proj, capture_output=True, text=True, timeout=120)
            assert r2.returncode == 0, f"{agent}: second install rc={r2.returncode}: {r2.stderr[-200:]}"
            for rel, blob in before.items():
                assert open(os.path.join(proj, *rel.split("/")), "rb").read() == blob, \
                    f"{agent}: re-running skills install rewrote {rel}"
        print(f"  PASS  tarball skills smoke: {len(agents)} agent(s), {installed} SKILL.md installed "
              f"from the packed artifact, rejected frontmatter stripped, re-run byte-identical")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"tarball skills smoke: {why(e)}")

    # ---- R7: the deliberate breaking-agent-API drill, as a standing gate ----
    # The v1.0 gate used to read "Survived one breaking agent-API change" and
    # wait for the ecosystem. R7 already specified the active form, so the drill
    # in experiments/r7-break-drill/ breaks the surface on purpose - four things
    # an agent can change without asking anyone - and measures whether editing
    # ONE manifest restores conformance. Its first run found the answer was no
    # for one class in four: the listing cap was a constant in src/skillscmd.js,
    # so R7's "path-maps only" mitigation was partly false and nothing could see
    # it. It runs here because absorbability is a property that regresses
    # quietly - one hardcoded agent assumption and the adapter layer is a lie
    # again. No --record: a harness run must not write to the tree.
    try:
        drill = os.path.join(ROOT, "experiments", "r7-break-drill", "drill.py")
        assert os.path.isfile(drill), \
            "experiments/r7-break-drill/drill.py is gone - the v1.0 gate has nothing behind it"
        r = subprocess.run([sys.executable, drill, "--json"], cwd=ROOT,
                           capture_output=True, text=True, timeout=900)
        assert r.stdout.strip().startswith("{"), \
            f"drill emitted no JSON (rc={r.returncode}): {r.stderr[-300:]}"
        out = json.loads(r.stdout)
        assert out["verdict"] != "CONTROL_FAILED", (
            "the drill's control failed, so it measured nothing: "
            + json.dumps(out["control"]))
        assert out["classes"], "the drill ran zero break classes"
        for c in out["classes"]:
            # VACUOUS is its own failure: a break the shipped tree already
            # satisfies proves the adapter layer nothing.
            assert c["verdict"] == "ABSORBED", (
                f"{c['id']} ({c['agent']}): {c['verdict']} - "
                + "; ".join(c["still_broken_after_fix"] or
                            ["the unfixed tree already conformed, so this class tests nothing"]))
            assert len(c["files_changed_by_fix"]) == 1 and \
                c["files_changed_by_fix"][0].startswith("adapters/"), \
                f"{c['id']}: fix touched {c['files_changed_by_fix']}, not one adapter manifest"
        assert r.returncode == 0, f"drill exit {r.returncode} with every class absorbed"
        print(f"  PASS  R7 break drill: {len(out['classes'])} break class(es) absorbed by an "
              f"adapter manifest alone, control green on {len(out['control'])} agents")
    except Exception as e:
        failures.append(f"R7 break drill: {why(e)}")

    # ---- the disclosure ledger: one disposition per decline-to-look site ----
    # 0.4.0 found six shapes in which `check` reported CLEAN over something it
    # had not checked, 0.4.1 three more, 0.4.2 three, 0.4.3 twelve - and each fix
    # added another hand-assembled channel wired by hand into a summing
    # expression, the envelope, the report and the terminal. Nothing enumerated
    # them, so the next decline site that forgot to join was invisible in exactly
    # the way the previous ones had been. This gate holds the enumeration to
    # being the only route: the verdict is derived from it, every consumer reads
    # it, and a report key that joins neither side of it is a hard error.
    try:
        # One probe per channel, and the two sets have to match exactly - a new
        # channel with no probe fails here rather than going untested, which is
        # the same forcing property the ledger itself has.
        probes = {
            "unscanned": {"unscanned": [{"doc": "handbook/api.md", "anchors": 1, "regions": 1}]},
            "journalMalformed": {"journalMalformed": [{"line": 2, "reason": "bad-json"}]},
            "quarantined": {"quarantined": [{"doc": "docs/x.md", "line": 3, "reason": "unknown-key"}]},
            "unverified": {"findings": [{"id": "x.root.t", "kind": "gen", "state": "unverified",
                                         "doc": "docs/x.md", "line": 5, "reason": "no-recorded-hash"}]},
            "skipped": {"skipped": ["node_modules"]},
            "excludedDocs": {"excludedDocs": [{"doc": "vendor/notes.md", "anchors": 1, "regions": 0}]},
            # `file: null`, because that is what the engine emits. This probe used
            # to say `"b/schema.prisma"`, a shape no provider produces, and the
            # difference is the whole reason the gate below runs a real `check`:
            # the most common gap of all is `{"kind": "not-a-git-root", "file":
            # null}`, which every one of the 32 shipped fixtures produces, and
            # against the invented shape the emitter looked correct while
            # emitting `locations: []` for the real one.
            "extractionGaps": {"extractionGaps": [{"kind": "schema-ignored", "file": None}]},
            "scopedOut": {"meta": {"scopedOut": 3}},
        }
        probe = subprocess.run(["node", "--input-type=module", "-e", (
            'import {CHANNELS, NOT_DISPOSITIONS, CONTAINERS, ledgerOf, unreadableOf, assertClassified, disclosuresOf} from "%s/src/disclosure.js";'
            'import {toSarif} from "%s/scripts/sarif.js";'
            'const probes = JSON.parse(process.argv[1]);'
            'const out = {channels: [], notDispositions: [...NOT_DISPOSITIONS], per: {}, guard: {},'
            '  containers: Object.fromEntries(Object.entries(CONTAINERS).map(([k, v]) => [k, [...v]]))};'
            'for (const c of CHANNELS) out.channels.push({channel: c.channel, key: c.key ?? null,'
            '  envelope: c.envelope ?? null, disclosure: c.disclosure, what: c.what ?? null, why: c.why ?? null,'
            '  locate: typeof c.locate === "function", describe: typeof c.describe === "function"});'
            'for (const [name, frag] of Object.entries(probes)) {'
            '  const rep = {v: 1, meta: {}, counts: {}, findings: [], ...frag};'
            '  const led = ledgerOf(rep);'
            '  const hit = led.find((e) => e.channel === name);'
            '  const res = toSarif(rep).runs[0].results;'
            '  out.per[name] = {unreadable: unreadableOf(led), total: hit ? hit.total : -1,'
            '    items: hit ? hit.items.length : -1, all: res.length,'
            '    units: disclosuresOf(rep).filter((u) => u.channel === name).length,'
            '    placeless: disclosuresOf(rep).filter((u) => !u.path).length,'
            '    mine: res.filter((r) => r.ruleId === "keeldocs/" + name).length};'
            '}'
            'const t = (f) => { try { f(); return null; } catch (e) { return String(e.message); } };'
            'out.guard.stray = t(() => assertClassified({v: 1, meta: {}, wombat: []}));'
            # The two nested probes. `meta.scopedOut` and the `counts` tally for
            # `unverified` are channels the ledger already has, so these probes
            # are the shape of an existing disposition, not an invented one.
            'out.guard.nestedMeta = t(() => assertClassified({v: 1, meta: {unreviewed: 7}, counts: {}, findings: []}));'
            'out.guard.nestedCounts = t(() => assertClassified({v: 1, meta: {}, counts: {unswept: 3}, findings: []}));'
            # The clean control carries every key both containers can hold, so a
            # container list too NARROW is caught here rather than by a
            # TOOL_ERROR on somebody's repository.
            'out.guard.clean = t(() => assertClassified({v: 1, quarantined: [], findings: [],'
            '  meta: {engine: "keeldocs@0", head: "h", providerSetHash: "p", docsScanned: 1,'
            '         mode: "local", scopedOut: 0, excludePaths: [], since: {ref: "x"}},'
            '  counts: {clean: 1, stale: 0, dead: 0, tampered: 0, unverified: 0, unresolvable: 0,'
            '           snoozed: 0, held: 0, intentionally_removed: 0, driftTotal: 0, selfCaused: 0}}));'
            'console.log(JSON.stringify(out));') % (ROOT_URL, ROOT_URL), json.dumps(probes)],
            capture_output=True, text=True, timeout=120)
        led = node_json(probe, "disclosure ledger probe")
        names = [c["channel"] for c in led["channels"]]

        # The floor. "The ledger enumerates the channels" is a claim about an
        # empty list unless the eight the campaign produced are all in it, and a
        # gate that would pass vacuously is not a gate.
        floor = {"quarantined", "unverified", "unscanned", "journalMalformed",
                 "skipped", "excludedDocs", "extractionGaps", "scopedOut"}
        assert floor <= set(names), f"channels missing from the ledger: {sorted(floor - set(names))}"
        assert set(probes) == set(names), (
            "every channel needs a probe and every probe a channel: "
            f"unprobed={sorted(set(names) - set(probes))} stale={sorted(set(probes) - set(names))}")
        for c in led["channels"]:
            assert c["disclosure"] in ("verdict", "named"), \
                f"{c['channel']}: disclosure {c['disclosure']!r} is neither verdict nor named"
            assert c["what"] and c["why"], \
                f"{c['channel']}: a disposition that says neither what nor why discloses nothing"
            # A channel that does not say where its items are gets the fallback
            # anchor for all of them, which is a silent default - and a silent
            # default in a signature is exactly what made every post-fix
            # `skipped = null` re-arm the defect it was fixing. Declaring both is
            # cheap; inheriting them by omission is how this family propagates.
            assert c["locate"] and c["describe"], (
                f"{c['channel']}: declares no {'locate' if not c['locate'] else 'describe'} - a channel "
                "that does not say where its items are or what they say leaves both to a consumer's guess")

        # The verdict is DERIVED, and each channel decides its own half of it.
        # Both directions are asserted: a `verdict` channel alone must produce a
        # verdict, and a `named` one alone must produce none - because a gate
        # that only checked the first would pass an engine that had quietly made
        # `npm install` a build failure.
        for c in led["channels"]:
            per, ch = led["per"][c["channel"]], c["channel"]
            assert per["total"] >= 1, f"{ch}: its own probe never reached the ledger (total={per['total']})"
            if c["disclosure"] == "verdict":
                assert per["unreadable"] >= 1, \
                    f"{ch} declares `verdict` but moves no verdict - it is a channel `check` reports CLEAN over"
            else:
                assert per["unreadable"] == 0, \
                    f"{ch} declares `named` but moved the verdict: a disclosure became a finding"
            # Every channel that discloses anything reaches the Security tab, one
            # result per UNIT. Comparing against `items.length` instead is how
            # this assertion passed over `scopedOut`, which discloses a count and
            # no items: the check read `0 == 0` and a live channel emitted
            # nothing at all. A gate that passes vacuously is not a gate, so the
            # expectation comes off `disclosuresOf` - the same enumeration the
            # emitter maps - and is asserted to be non-zero first.
            assert per["units"] >= 1, \
                f"{ch}: its own probe disclosed nothing to any consumer (units=0)"
            assert per["mine"] == per["units"], \
                f"{ch}: {per['units']} disclosure unit(s) became {per['mine']} SARIF result(s)"
            # A result with no location is a result GitHub does not display:
            # "At least one location is required for code scanning to display a
            # result." `extractionGaps` items name a path only sometimes, so the
            # rest were emitted, accepted, counted, and shown to nobody.
            assert per["placeless"] == 0, \
                f"{ch}: {per['placeless']} disclosure unit(s) name no place, so code scanning shows them to nobody"
        assert led["per"]["unverified"]["all"] >= 1, \
            "a report whose only content is an unverifiable section produced an EMPTY SARIF run - " \
            "a clean Security tab for a run that exits 1 UNREADABLE"

        # The forcing function itself. This is what a fixture-based partition
        # check cannot do: channels are absent-when-empty, so a fixture only
        # notices the unjoined channels it happens to trigger.
        assert led["guard"]["stray"] and "wombat" in led["guard"]["stray"], (
            "assertClassified passed an unclassified report key - a site that declines to look at "
            f"something and joins neither CHANNELS nor NOT_DISPOSITIONS is invisible: {led['guard']['stray']!r}")
        assert led["guard"]["clean"] is None, \
            f"the guard rejected a fully classified report: {led['guard']['clean']}"

        # The same forcing function one level down, and the reason it exists.
        # `assertClassified` compared top-level keys only, and two of the eight
        # channels are not top-level keys: `scopedOut` is disclosed inside
        # `meta`, `unverified` is tallied into `counts`, and both containers are
        # in NOT_DISPOSITIONS - so the guard could not see the shape two of its
        # OWN channels have. Measured before the fix, on this tree: a ninth
        # decline site written the way `meta.scopedOut` is written produced an
        # envelope BYTE-IDENTICAL to the clean one, exit 0, CLEAN, while the
        # top-level control exited 2. Both directions are asserted, because a
        # container list too narrow would TOOL_ERROR on a real repository and a
        # list too wide would let the next one through.
        for probe_name, key in (("nestedMeta", "meta.unreviewed"), ("nestedCounts", "counts.unswept")):
            msg = led["guard"][probe_name]
            assert msg and key in msg, (
                f"assertClassified passed {key} - a disposition nested where `meta.scopedOut` and the "
                f"`counts` tally for `unverified` already live is invisible to the verdict: {msg!r}")
        # Inward, the direction the exit-3 defect survived for four releases: a
        # declared key the engine cannot produce is a list drifting away from the
        # thing it describes. `meta` is built in one object literal in check.js
        # and `counts` is one key per finding state, so every declared name has
        # to appear in one of the two files that write them.
        writers = "\n".join(open(os.path.join(ROOT, "src", f), encoding="utf-8").read()
                            for f in ("check.js", "drift.js"))
        assert led["containers"] and set(led["containers"]) == {"meta", "counts"}, (
            f"CONTAINERS no longer walks meta and counts: {sorted(led['containers'])} - the two "
            "containers a disposition has ever been disclosed in are the two this gate is about")
        for cname, keys in led["containers"].items():
            assert keys, f"CONTAINERS.{cname} is empty, so the walk over it compares nothing"
            absent = sorted(k for k in keys if not re.search(rf"\b{re.escape(k)}\b", writers))
            assert not absent, (
                f"CONTAINERS.{cname} declares key(s) src/check.js and src/drift.js never write: "
                f"{absent} - a permission list that has outlived what it permits")

        src = open(os.path.join(ROOT, "src", "check.js"), encoding="utf-8").read()
        i, j = src.index("function buildReport("), src.index("function emit(")
        producer, consumers = src[i:j], src[:i] + src[j:]

        def _decomment(s):
            s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
            return re.sub(r"(?m)//.*$", "", s)

        cons = _decomment(consumers)
        assert "unreadableOf(" in cons and "ledgerOf(" in cons, \
            "comment stripping ate the source: this check is reading nothing"
        assert "assertClassified(" in _decomment(producer), (
            "buildReport no longer calls assertClassified - the forcing function is unwired and a new "
            "report key is free to be invisible again")
        # `buildReport` is the producer and must name its channels; nothing that
        # CONSUMES the report may. Verdict, summary, envelope projection and
        # terminal rendering all read the ledger, so a channel spelled out here
        # is one the next channel will not be added to.
        spelled = sorted({n for n in names + [c["envelope"] for c in led["channels"] if c["envelope"]]
                          if re.search(rf"\b{re.escape(n)}\b", cons)})
        assert not spelled, (
            f"src/check.js hand-assembles disclosure channel(s) {', '.join(spelled)} outside buildReport - "
            "the hand-maintained sum is exactly the defect 0.4.0 through 0.4.3 each shipped a fix for")
        sar = open(os.path.join(ROOT, "scripts", "sarif.js"), encoding="utf-8").read()
        assert "disclosuresOf" in sar and "CHANNELS" in sar, (
            "scripts/sarif.js does not consume the ledger - it emitted zero results for a run that "
            "exited 1 UNREADABLE, so code scanning showed no problems for a failing run")
        # The consumer half of the rule `check.js` is already held to. The
        # emitter is not allowed to name a channel either: a special case for one
        # channel is a place the next channel will not be added to, and that is
        # how this file came to know four states out of twelve. Comments name
        # channels constantly - they are the record of which defect was where -
        # so this reads the code, through the same stripper.
        sar_code = _decomment(sar)
        assert "disclosuresOf(" in sar_code, "comment stripping ate scripts/sarif.js"
        sar_spelled = sorted({n for n in names + [c["envelope"] for c in led["channels"] if c["envelope"]]
                              if re.search(rf"\b{re.escape(n)}\b", sar_code)})
        assert not sar_spelled, (
            f"scripts/sarif.js hand-assembles disclosure channel(s) {', '.join(sar_spelled)} - a consumer "
            "that special-cases a channel is one the next channel will not be added to")
        print(f"  PASS  disclosure ledger: {len(names)} channel(s) enumerated, verdict derived from "
              f"{sum(1 for c in led['channels'] if c['disclosure'] == 'verdict')} of them and moved by no "
              f"other, every disclosure unit reaches SARIF located, an unclassified key is refused at the "
              f"top level and inside meta and counts, and neither check.js nor sarif.js names a channel")
    except Exception as e:
        failures.append(f"disclosure ledger: {why(e)}")

    # ---- the SARIF emitter, against a REAL report from a REAL check run ----
    # `scripts/sarif.js` ships in package.json files[] and action.yml uploads its
    # output to GitHub code scanning, and until now its entire coverage was one
    # unit test over a hand-written fixture - `grep -ci sarif scripts/harness.py`
    # returned 0. A hand-authored fixture is exactly how this file drifted from
    # the engine: it agreed with itself while the engine emitted shapes it had
    # never seen. The probes above are still worth having (they can trip a
    # channel a real repository cannot), but they cannot catch that, because the
    # person writing the probe and the person writing the emitter make the same
    # wrong assumption on the same day. So this builds one repository that trips
    # every channel at once, runs `check` for real, and runs the emitter as the
    # ARGV entry point action.yml calls - which had no coverage of any kind.
    try:
        import tempfile as _tf49
        tmp = _tf49.mkdtemp(prefix="keeldocs-sarif-")
        repo = os.path.join(tmp, "repo")
        for d in ("docs", "handbook", "vendor", "node_modules/left-pad", ".keeldocs"):
            os.makedirs(os.path.join(repo, *d.split("/")), exist_ok=True)
        # Each file below exists to trip exactly one channel, and the comment
        # says which, so a channel that stops firing is a legible failure rather
        # than a count that quietly drops by one.
        W(os.path.join(repo, "keeldocs.toml"),
          '[docs]\ndirs = ["docs"]\n[providers]\nexclude-paths = ["vendor/**"]\n')
        W(os.path.join(repo, "package.json"),
          '{ "name": "sarif-allchannels", "private": true,\n'
          '  "dependencies": { "express": "^4.19.0" } }\n')
        W(os.path.join(repo, "app.js"),
          "const express = require('express');\nconst app = express();\n"
          "app.get('/health', (req, res) => res.json({ ok: true }));\n"
          "app.post('/orders', (req, res) => res.json({ ok: true }));\n"
          "module.exports = app;\n")
        # scopedOut: a real endpoint the user's own exclude-paths prunes.
        W(os.path.join(repo, "vendor", "extra.js"),
          "const express = require('express');\nconst app = express();\n"
          "app.get('/vendored', (req, res) => res.json({ ok: true }));\n"
          "module.exports = app;\n")
        # unverified: a gen region carrying neither hash nor content (spec §12).
        # quarantined: a marker with a key the vocabulary does not have.
        W(os.path.join(repo, "docs", "x.md"),
          "# API\n\n"
          "<!-- keeldocs:gen id=x.health binds=fact:http-endpoints/GET /health -->\n"
          "| method | path |\n|---|---|\n| GET | /health |\n"
          "<!-- /keeldocs:gen -->\n\n"
          "<!-- keeldocs: id=x.bad wombat=1 binds=fact:http-endpoints/POST /orders -->\n")
        # unscanned: anchored, and outside every [docs] dirs scan root.
        W(os.path.join(repo, "handbook", "y.md"),
          "# Handbook\n<!-- keeldocs: id=y.orders binds=fact:http-endpoints/POST /orders hash-kind=fact -->\n")
        # excludedDocs: anchored, and suppressed by the user's own path scope.
        W(os.path.join(repo, "vendor", "notes.md"),
          "# Vendored\n<!-- keeldocs: id=v.notes binds=fact:http-endpoints/GET /vendored hash-kind=fact -->\n")
        W(os.path.join(repo, "node_modules", "left-pad", "package.json"), '{"name":"left-pad"}\n')
        # journalMalformed: a line the journal reader cannot parse.
        W(os.path.join(repo, ".keeldocs", "decisions.jsonl"), "{ not json at all\n")
        # extractionGaps needs nothing: a temp dir is not a git root, which is
        # the gap every fixture in this harness produces.

        rc = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js"), "check", "--json"],
                            cwd=repo, capture_output=True, text=True, timeout=300)
        env49 = node_json(rc, "check on the all-channels repo")
        # The control. Every assertion below is about what a FAILING run shows,
        # so a repository that stopped failing would make all of them vacuous.
        assert rc.returncode == 1 and env49["code"] == "UNREADABLE", (
            f"control: the all-channels repo must exit 1 UNREADABLE, got rc={rc.returncode} "
            f"code={env49.get('code')} - every assertion below is about a failing run")
        spill = os.path.join(repo, *env49["full"].split("/"))
        report = json.load(open(spill, encoding="utf-8"))

        # Every channel must actually be tripped by this repository. Without this
        # the per-channel comparison below is a loop over whatever happened to
        # fire, which is the shape of gate that let eight channels ship unnoticed.
        led49 = node_json(subprocess.run(["node", "--input-type=module", "-e", (
            'import {CHANNELS, ledgerOf, disclosuresOf} from "%s/src/disclosure.js";'
            'import {readFileSync} from "node:fs";'
            'const rep = JSON.parse(readFileSync(process.argv[1], "utf8"));'
            'const units = disclosuresOf(rep);'
            'const per = {};'
            'for (const c of CHANNELS) per[c.channel] = units.filter((u) => u.channel === c.channel).length;'
            'console.log(JSON.stringify({per, total: units.length,'
            '  placeless: units.filter((u) => !u.path).length,'
            '  live: ledgerOf(rep).filter((e) => e.total).map((e) => e.channel)}));') % ROOT_URL, spill],
            capture_output=True, text=True, timeout=120), "disclosuresOf on the real report")
        silent = [c for c, n in led49["per"].items() if n == 0]
        assert not silent, (
            f"the all-channels repo tripped nothing on channel(s) {', '.join(silent)} - grow the "
            "fixture until it does, or this gate checks the emitter against a report that never "
            "exercises it")

        # The emitter as action.yml runs it: argv, stdout, exit code. The module
        # export had a unit test; this entry point had nothing.
        sar = subprocess.run(["node", os.path.join(ROOT, "scripts", "sarif.js"), spill],
                             capture_output=True, text=True, timeout=120)
        assert sar.returncode == 0, \
            f"scripts/sarif.js rc={sar.returncode} on a real report: {(sar.stderr or '')[-300:]}"
        doc = json.loads(sar.stdout)
        run49 = doc["runs"][0]
        results = run49["results"]

        # This is the measurement the whole item exists for. Before: `check`
        # exited 1 UNREADABLE and this file exited 0 having emitted ZERO results,
        # so GitHub code scanning displayed "no problems found" for a failing run.
        assert results, (
            "a run that exited 1 UNREADABLE produced a SARIF with zero results - code scanning "
            "displays 'no problems found' for a failing run, which is this project's own defect "
            "wearing someone else's UI")
        by_rule = {}
        for r49 in results:
            by_rule[r49["ruleId"]] = by_rule.get(r49["ruleId"], 0) + 1
        for ch49, n49 in led49["per"].items():
            got = by_rule.get(f"keeldocs/{ch49}", 0)
            assert got == n49, (
                f"{ch49}: the report disclosed {n49} unit(s) and SARIF carried {got} - a consumer "
                "that accounts for some channels and not others is the defect 0.4.0 through 0.4.3 "
                "each shipped a fix for")
        # "At least one location is required for code scanning to display a
        # result" (GitHub SARIF support). A result with an empty `locations` is
        # emitted, accepted, counted by the emitter's own tests, and shown to
        # nobody - so it is a silence with a receipt, which is worse.
        blind = [r49["ruleId"] for r49 in results
                 if not (r49.get("locations") or [{}])[0]
                 .get("physicalLocation", {}).get("artifactLocation", {}).get("uri")]
        assert not blind, (
            f"SARIF result(s) with no location: {sorted(set(blind))} - code scanning does not "
            "display a result that names no place, so the disclosure reaches the file and not the user")
        declared = {r49["id"] for r49 in run49["tool"]["driver"]["rules"]}
        undeclared = sorted({r49["ruleId"] for r49 in results} - declared)
        assert not undeclared, f"SARIF results cite undeclared rule(s): {undeclared}"
        assert run49["tool"]["driver"]["version"] == \
            json.load(open(os.path.join(ROOT, "package.json")))["version"], \
            "the SARIF driver version is not this engine's version"
        # Determinism, on the consumer side too: the emitter reads only the
        # report, so two runs of it must be byte-identical or something in it is
        # reading the world.
        sar2 = subprocess.run(["node", os.path.join(ROOT, "scripts", "sarif.js"), spill],
                              capture_output=True, text=True, timeout=120)
        assert sar2.stdout == sar.stdout, "NONDETERMINISTIC SARIF (two runs of the emitter differ)"
        print(f"  PASS  sarif emitter vs a real check run: {len(led49['live'])} channel(s) tripped by one "
              f"repository, check exit 1 UNREADABLE, emitter exit 0 with {len(results)} result(s) - "
              f"every disclosure unit carried, every result located, every rule declared")
        rmtree(tmp)
    except Exception as e:
        failures.append(f"sarif emitter vs a real check run: {why(e)}")

    # ---------------------------------------------------------------------- #
    # The envelope-code enumeration, held to the engine and to the contracts.  #
    #                                                                          #
    # `src/envelope.js` claims to list every code the CLI can emit. A claim    #
    # like that is worth exactly what checks it, and this family has already   #
    # produced the failure in both directions: `UNREADABLE` was invented by    #
    # the 0.4.x campaign and named in no agent-facing file at all, while exit  #
    # 3 was documented as `check`'s in three of them and returned by nothing.  #
    # So the enumeration is checked against the source both ways, and the      #
    # contracts are checked against the enumeration.                           #
    # ---------------------------------------------------------------------- #
    envelope_enum, envelope_claimed, envelope_bodies = None, None, None
    try:
        envelope_enum = node_json(subprocess.run(["node", "--input-type=module", "-e", (
            'import {CODES, SOURCES, NOT_CODES, CONTRACTS, requiredCodes, envelopeSources}'
            ' from "%s/src/envelope.js";'
            'console.log(JSON.stringify({'
            '  codes: CODES.map((c) => ({code: c.code, commands: c.commands})),'
            '  sources: SOURCES, notCodes: [...NOT_CODES], files: envelopeSources(),'
            '  contracts: CONTRACTS.map((c) => ({path: c.path, covers: c.covers,'
            '    required: requiredCodes(c).map((x) => x.code)}))}));') % ROOT_URL],
            capture_output=True, text=True, timeout=120), "src/envelope.js enumeration")

        # code -> the files it may legitimately appear in, derived from the
        # commands that claim it. Nothing here is hand-listed twice.
        claimed = {}
        for c in envelope_enum["codes"]:
            for cmd in c["commands"]:
                assert cmd in envelope_enum["sources"], \
                    f'{c["code"]} names command `{cmd}`, which has no entry in SOURCES'
                claimed.setdefault(c["code"], set()).update(envelope_enum["sources"][cmd])

        bodies = {f: open(os.path.join(ROOT, f), encoding="utf-8").read()
                  for f in envelope_enum["files"]}
        not_codes = set(envelope_enum["notCodes"])
        envelope_claimed, envelope_bodies = claimed, bodies

        # Not vacuous by construction: if the scan ever reads zero files or the
        # enumeration empties out, the loops in both directions pass over
        # nothing at all and say so.
        assert len(claimed) >= 30 and len(bodies) >= 10, (
            f"the scan covered {len(claimed)} code(s) across {len(bodies)} file(s) - too few to "
            f"be reading the CLI; the file list or the enumeration has been emptied")

        # Outward: a literal the engine emits that the enumeration does not
        # carry. This is the direction `UNREADABLE` escaped through, and it is
        # the reason the scan reads the source rather than trusting the list.
        stray = []
        for f, body in bodies.items():
            for m in re.finditer(r'"([A-Z][A-Z0-9_]*)"', body):
                lit = m.group(1)
                if lit in not_codes:
                    continue
                if lit not in claimed:
                    stray.append(f'{f}: "{lit}" is emitted but is not in CODES, and is not '
                                 f'declared a non-code in NOT_CODES')
                elif f not in claimed[lit]:
                    stray.append(f'{f}: "{lit}" is enumerated, but no command claiming it '
                                 f'names {f} in SOURCES')
        assert not stray, ("the engine emits codes the enumeration does not carry:\n    "
                           + "\n    ".join(stray))
        print(f"  PASS  envelope codes the engine emits are all enumerated: {len(bodies)} "
              f"envelope-building file(s) scanned, every uppercase literal either one of "
              f"{len(claimed)} enumerated codes or one of {len(not_codes)} declared non-codes")
    except Exception as e:
        failures.append(f"envelope codes the engine emits are all enumerated: {why(e)}")

    # The other direction, in its own block so that neither failure can mask the
    # other. This is the half a one-directional gate misses, and the half that
    # let exit 3 be documented in three agent-facing files while `src/` returned
    # it from nowhere.
    try:
        assert envelope_claimed and envelope_bodies, "the enumeration did not load"
        phantom = [f'"{code}" is enumerated but appears in none of {", ".join(sorted(files))}'
                   for code, files in envelope_claimed.items()
                   if not any(f'"{code}"' in envelope_bodies[f] for f in files)]
        assert not phantom, (
            "the enumeration carries codes the engine cannot emit:\n    "
            + "\n    ".join(phantom)
            + "\n    A code documented but unreachable is the exit-3 defect: three agent-facing "
              "files described a state nothing in src/ ever returned.")
        print(f"  PASS  enumerated codes are all really emitted: {len(envelope_claimed)} code(s), "
              f"each found in the source of a command that claims it")
    except Exception as e:
        failures.append(f"enumerated codes are all really emitted: {why(e)}")

    try:
        assert envelope_enum, "the enumeration did not load; nothing to hold the contracts to"
        # The item this gate exists for. A contract that instructs an agent on a
        # command owes every code that command can emit, and `covers` is what
        # makes the requirement derived: adding a code to `sync` makes
        # skills/sync/SKILL.md owe it with nothing in the harness edited.
        missing, checked = [], 0
        for c in envelope_enum["contracts"]:
            body = open(os.path.join(ROOT, c["path"]), encoding="utf-8").read()
            assert c["required"], (
                f'{c["path"]} covers {c["covers"]} and that requires no codes at all - a '
                f'contract with nothing to state is a gate that cannot fail')
            for code in c["required"]:
                checked += 1
                if not re.search(rf"\b{re.escape(code)}\b", body):
                    missing.append(f'{c["path"]}: never names `{code}`, which '
                                   f'{" or ".join(c["covers"])} can emit')
        assert not missing, (
            "consumer-facing contracts omit codes the engine emits:\n    "
            + "\n    ".join(missing)
            + "\n    An agent that has never been told a code exists cannot act on it, and this "
              "project's distribution bet is that agents read these files.")
        print(f"  PASS  agent- and action-facing contracts vs the enumeration: "
              f"{len(envelope_enum['contracts'])} contract(s), {checked} required code "
              f"mention(s), none missing")
    except Exception as e:
        failures.append(f"agent- and action-facing contracts vs the enumeration: {why(e)}")

    # The exit column is a claim too, so it is measured rather than asserted in
    # prose. Every probe below runs a real CLI command and the (code, exit) pair
    # it comes back with must be exactly what the enumeration says - which also
    # covers `doctor`, whose code depends on the host, because the assertion is
    # about the PAIR and not about which code appears.
    tmp = None  # bound before the try, so the `finally` below cannot NameError
    try:
        assert envelope_enum, "the enumeration did not load; nothing to hold the runs to"
        exits = {}
        for c in envelope_enum["codes"]:
            for cmd, e in c["commands"].items():
                exits[(cmd, c["code"])] = e if isinstance(e, list) else [e]

        # Staged OUTSIDE the working tree, like every other gate here. This one
        # used a fixed path inside ROOT and cleaned it up only on the success
        # path, and both halves cost real evidence: two harness runs on one
        # checkout deleted each other's fixture mid-probe and reported
        # TOOL_ERROR failures that were nothing but the collision, and a failing
        # run left `.keeldocs-tmp-envelope/` behind in `git status` - untracked,
        # unignored, and indistinguishable from the run having dirtied the tree.
        # A gate whose result depends on who else is running is not a
        # measurement, so it gets a private directory and a `finally`.
        import tempfile as _tf50
        tmp = _tf50.mkdtemp(prefix="keeldocs-envelope-")
        for sub in ("clean/docs", "bad", "refused/docs"):
            os.makedirs(os.path.join(tmp, *sub.split("/")), exist_ok=True)
        W(os.path.join(tmp, "clean", "docs", "a.md"), "# Docs\n")
        W(os.path.join(tmp, "bad", "keeldocs.toml"), "this is not toml = = =\n")
        W(os.path.join(tmp, "refused", "docs", "a.md"),
          "# A\n<!-- keeldocs: id=a.b wombat=1 -->\n")

        probes = [
            ("check", ["check", "--json"], "clean", "CLEAN"),
            ("check", ["check", "--json"], "refused", "UNREADABLE"),
            ("check", ["check", "--json"], "bad", "CONFIG"),
            ("init", ["init", "--json"], "clean", "DRY_RUN"),
            ("sync", ["sync", "--json"], "clean", "NOTHING_TO_SYNC"),
            ("sync", ["sync", "--upgrade", "--json"], "clean", "NOTHING_TO_UPGRADE"),
            ("sync", ["sync", "--json"], "bad", "CONFIG"),
            # doctor's code is the host's answer, not the tree's, so the probe
            # pins the pair and deliberately not the code.
            ("doctor", ["doctor", "--json"], "clean", None),
        ]
        seen = set()
        for cmd, argv, where, expect in probes:
            r = subprocess.run(["node", os.path.join(ROOT, "bin", "keeldocs.js")] + argv,
                               cwd=os.path.join(tmp, where), capture_output=True,
                               text=True, timeout=300)
            env = node_json(r, f"{' '.join(argv)} in {where}")
            code = env["code"]
            assert (cmd, code) in exits, (
                f"`keeldocs {' '.join(argv)}` in {where} returned code {code}, which "
                f"src/envelope.js does not enumerate for `{cmd}` - a code no contract can "
                f"name because nothing knows it exists")
            assert r.returncode in exits[(cmd, code)], (
                f"`keeldocs {' '.join(argv)}` returned {code} with exit {r.returncode}; "
                f"src/envelope.js claims exit {exits[(cmd, code)]} for that pair")
            if expect is not None:
                assert code == expect, (
                    f"probe drift: `{' '.join(argv)}` in {where} was built to reach {expect} "
                    f"and returned {code} - the probe no longer tests what it names")
            seen.add((cmd, code, r.returncode))
        # A gate that observed one pair would pass while proving nothing.
        assert len(seen) >= 6, f"only {len(seen)} distinct (command, code, exit) triple(s) observed"
        print(f"  PASS  enumerated exit codes vs real runs: {len(probes)} probe(s) across "
              f"check/init/sync/doctor, {len(seen)} distinct (command, code, exit) triple(s), "
              f"every pair exactly as src/envelope.js claims")
    except Exception as e:
        failures.append(f"enumerated exit codes vs real runs: {why(e)}")
    finally:
        # On the failure path too: a gate that leaves debris behind on the way
        # out makes the NEXT run's tree-cleanliness check a lie about this one.
        if tmp:
            rmtree(tmp)

    # ---------------------------------------------------------------------- #
    # The rollup action's push decision.                                      #
    #                                                                         #
    # `ci.yml` runs `./rollup` with `dry-run: true` against THIS repository,   #
    # which is clean, and then asserted `code == NOTHING_TO_SYNC -a applied    #
    # == 0`. The second half could not fail: on a clean tree `sync` applies    #
    # nothing under EITHER branch of the action - the dry-run branch has no    #
    # `--apply-all`, and `--apply-all` with nothing to do applies nothing      #
    # either - so it read `0 == 0`, fifteen lines below a comment saying that  #
    # a verdict which is the only reachable one is not a gate.                 #
    #                                                                         #
    # What that left unguarded is the weekly PR itself. The push step runs     #
    # `if applied != '0'`, and `applied` comes out of `data.applied` in the    #
    # sync envelope. Rename that key, or change the shape of what `--apply-all`#
    # reports, and the expression returns 0 forever: the rollup stops opening  #
    # its PR, keeldocs' own regenerations stop landing, and CI stays green     #
    # because the only tree it ever measured had nothing to apply.             #
    #                                                                         #
    # So the expressions are READ OUT of `rollup/action.yml` and run against a #
    # real envelope from a repository that does have something to apply, on    #
    # both branches, with CI=true because that is the only environment the     #
    # rollup ever runs in. Retyping the expression here would build a gate on  #
    # the copy, which is the shape of mistake this whole family is made of.    #
    # ---------------------------------------------------------------------- #
    try:
        import shutil as _shrl, tempfile as _tfrl
        ry = open(os.path.join(ROOT, "rollup", "action.yml"), encoding="utf-8").read()
        expr = {}
        for _name in ("code", "applied"):
            m = re.search(rf"^\s*{_name}=\$\(node -e '([^']+)'\)\s*$", ry, re.M)
            assert m, (f"rollup/action.yml no longer derives `{_name}` from a `node -e` expression - "
                       "this gate runs the action's own expression and has none to run")
            expr[_name] = m.group(1)
        # The output is worth measuring only because the push step keys off it.
        for needle in ("steps.sync.outputs.applied != '0'", "inputs.dry-run != 'true'",
                       "git push -f origin"):
            assert needle in ry, (f"rollup/action.yml no longer contains {needle!r} - the push "
                                  "decision this gate measures has moved, so it proves nothing")

        tmp = _tfrl.mkdtemp(prefix="keeldocs-rollup-")
        dst = os.path.join(tmp, "repo")
        _shrl.copytree(os.path.join(ROOT, "fixtures", "init-scenario"), dst,
                       ignore=_shrl.ignore_patterns("golden", ".keeldocs"))
        # Its own CLI path and its own runner: `kd` from the sync integration is
        # REBOUND further down this function (line ~2400) to a helper with a
        # different signature, so a block appended here that calls it silently
        # gets the wrong one. That cost a full run to find.
        KDR = os.path.join(ROOT, "bin", "keeldocs.js")
        ini = subprocess.run(["node", KDR, "init", "--yes", "--json"], cwd=dst,
                             capture_output=True, text=True, timeout=300)
        assert ini.returncode == 0, (
            f"rollup fixture failed to init: rc={ini.returncode} "
            f"stdout={ini.stdout[:200]!r} stderr={(ini.stderr or '')[-200:]!r}")
        # Drift the tree, so the two branches have DIFFERENT answers. On a clean
        # tree they do not, and that is precisely why ci.yml's assertion held no
        # matter what the action did.
        app = os.path.join(dst, "app.js")
        W(app, open(app, encoding="utf-8").read().replace(
            "app.post('/items', (req, res) => res.status(201).end());",
            "app.post('/items', (req, res) => res.status(201).end());\n"
            "app.get('/archive', (req, res) => res.json([]));"))
        sch = os.path.join(dst, "prisma", "schema.prisma")
        W(sch, open(sch, encoding="utf-8").read().replace(
            "  status Status @default(ACTIVE)",
            "  status Status @default(ACTIVE)\n  createdAt DateTime @default(now())"))

        def docs_bytes():
            out = {}
            for root_, _dirs, files in os.walk(os.path.join(dst, "docs")):
                for f in files:
                    p = os.path.join(root_, f)
                    out[os.path.relpath(p, dst)] = open(p, "rb").read()
            return out

        def branch(*argv):
            """One branch of the action's `if`, then the action's own output
            expressions, evaluated in the directory the action evaluates them in."""
            r = subprocess.run(["node", KDR, *argv], cwd=dst, capture_output=True, text=True,
                               timeout=300, env={**os.environ, "CI": "true"})
            # the action itself only aborts at 2 - PROPOSALS legitimately exits 1
            assert r.returncode < 2, \
                f"`keeldocs {' '.join(argv)}` rc={r.returncode}: {(r.stderr or '')[-300:]}"
            W(os.path.join(dst, "kd-sync.json"), r.stdout)
            got = {}
            for _n, _e in expr.items():
                o = subprocess.run(["node", "-e", _e], cwd=dst, capture_output=True,
                                   text=True, timeout=60)
                assert o.returncode == 0, \
                    f"the action's own `{_n}` expression failed: {(o.stderr or '')[-200:]}"
                got[_n] = o.stdout.strip()
            return got

        before = docs_bytes()
        dry = branch("sync", "--json")
        # The control: if the fixture stops drifting, both branches answer the
        # same and everything below is 0 == 0 again.
        assert dry["code"] == "PROPOSALS", (
            f"the dry-run branch over a drifted tree reported {dry['code']} - the fixture no longer "
            "drifts, so both branches now have the same answer and this gate is comparing 0 with 0")
        assert docs_bytes() == before, \
            "the dry-run branch REWROTE documents it was only asked to preview"
        assert dry["applied"] == "0", (
            f"the dry-run branch reported applied={dry['applied']!r}, so the push step would commit "
            "and force-push a tree the preview never wrote")
        wet = branch("sync", "--apply-all", "--json")
        assert wet["code"] == "APPLIED", \
            f"the apply branch over a drifted tree reported {wet['code']}, not APPLIED"
        assert wet["applied"].isdigit() and int(wet["applied"]) >= 1, (
            f"the action's own expression read applied={wet['applied']!r} out of an envelope that "
            "DID apply regenerations - the push step is gated on `applied != '0'`, so the weekly "
            "rollup PR would silently stop being opened, and ci.yml's clean-tree dry run, where 0 "
            "is the right answer under either branch, could never notice")
        assert docs_bytes() != before, \
            "the apply branch changed no document, so `applied` is counting something unwritten"
        rmtree(tmp)
        print(f"  PASS  rollup push decision: the action's own code/applied expressions read "
              f"{wet['applied']} applied ({wet['code']}) from a real --apply-all envelope and 0 "
              f"({dry['code']}) from the dry-run branch, which wrote nothing")
    except Exception as e:
        failures.append(f"rollup push decision: {why(e)}")

    # `npm run smoke` was `node bin/keeldocs.js sync --json; test $? -eq 2` - an
    # assertion that `sync` is NOT IMPLEMENTED, left from the stub era and never
    # updated when it was. No workflow and no document invoked it, so nothing
    # ever ran it; measured on this tree it exits 1, which means it had been
    # failing for as long as `sync` has worked, silently, because a gate nothing
    # invokes cannot go red. package.json ships in the tarball, so it was also
    # advice to users. A script that asserts something and is run by nothing is
    # the same defect as a check reporting CLEAN over what it declined to look
    # at, so the next one has to join a workflow or be deleted deliberately.
    try:
        pkg_scripts = json.load(open(os.path.join(ROOT, "package.json"),
                                     encoding="utf-8")).get("scripts", {})
        assert pkg_scripts, "package.json declares no scripts at all - this gate has nothing to hold"
        # every workflow, not a hand-listed two: a script wired into a workflow
        # this gate had not heard of would be reported as an orphan, and a gate
        # that cries wolf is one someone eventually deletes.
        wfs = sorted(glob.glob(os.path.join(ROOT, ".github", "workflows", "*.yml"))
                     + glob.glob(os.path.join(ROOT, ".github", "workflows", "*.yaml")))
        assert wfs, ".github/workflows holds no workflow - nothing here runs anything"
        blob = "".join(open(w, encoding="utf-8").read() for w in wfs)
        orphan = []
        for _name, _body in sorted(pkg_scripts.items()):
            alt = [rf"npm (?:run|run-script) {re.escape(_name)}\b"]
            if _name in ("test", "start", "stop", "restart"):
                alt.append(rf"npm {re.escape(_name)}\b")   # npm's own shorthands
            if not any(re.search(a, blob) for a in alt):
                orphan.append(f"{_name!r} ({_body!r})")
        assert not orphan, (
            "package.json declares script(s) no workflow runs: " + "; ".join(orphan)
            + " - a script that asserts something and is invoked by nothing cannot go red. `smoke` "
              "asserted that `sync` exits 2 and had been failing since `sync` shipped, unnoticed "
              "for exactly that reason. Wire it into a workflow or delete it")
        print(f"  PASS  no orphan npm script: all {len(pkg_scripts)} package.json script(s) are "
              f"invoked by one of {len(wfs)} workflow(s), so each one can go red")
    except Exception as e:
        failures.append(f"no orphan npm script: {why(e)}")

    # Last, so every PASS above is counted. +1 is this gate's own line, which is
    # printed after the count is taken.
    try:
        # This gate had the defect it exists to prevent, and an outside reviewer
        # watched it happen. `n` counts PASS lines PRINTED, so a run in which any
        # earlier gate failed produces a lower n - and if the documents happen to
        # say that lower number, the count gate passes while the tree really has
        # more checks. The number is only meaningful when every check ran, so it
        # is only asserted then, and the skip says so rather than passing quietly.
        n = len(_PASSES) + 1
        if failures:
            _stdlib_print(f"  ----  harness check count: not asserted - {len(failures)} gate(s) "
                          f"failed, so the {n} counted here is a floor, not the count")
            raise _SkipCount()
        stale, stated = [], 0
        # Five documents now, not four. CHANGELOG's Unreleased section said
        # `104 harness checks` over a tree with 106 - written by the commit that
        # added this gate, in the one file CLAUDE.md names as the place the
        # measured before-and-after lives, and the gate could not see it because
        # it read four files and that was not one of them. Released sections stay
        # out: `0.4.3` really did have 98.
        for rel, body in tracking_docs():
            body = re.sub(r"\s+", " ", body)
            for m in re.finditer(r"\b(\d+) (?:[a-z][a-z-]* )*harness checks", body):
                stated += 1
                if int(m.group(1)) != n:
                    stale.append(f"{rel}: '{m.group(0)}' but this run made {n}")
        # The same silence as the tracking-count gate above, and the PASS line
        # made it worse by claiming EVERY tracking document says n - AGENTS.md
        # states no count at all, so the sentence was already untrue of a
        # document it named, and had the other three been reworded the gate
        # would have compared nothing and said so anyway.
        assert stated, (
            "no tracking document states a harness check count - the phrase this gate matches on is "
            f"gone, so {n} is unchecked rather than right and this line has been printing PASS over "
            "zero comparisons")
        assert not stale, "stale harness-check counts:\n    " + "\n    ".join(stale)
        print(f"  PASS  harness check count: {n} portable checks, stated in {stated} place(s) across "
              f"the tracking documents and stale in none"
              + (f" (+{len(_TIER_PASSES)} kernel-tier check(s) on this host)" if _TIER_PASSES else ""))
    except _SkipCount:
        pass
    except Exception as e:
        failures.append(f"harness check count: {why(e)}")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  FAIL  {f}")
        sys.exit(1)
    print(f"\nAll green: {len(MATRIX)} extractor + 2 check + init + sync + honesty-loop + system-map integrations + envelope smoke.")


if __name__ == "__main__":
    main()
