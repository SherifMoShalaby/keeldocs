# keeldocs

**Test coverage for your documentation.**

[![npm](https://img.shields.io/npm/v/keeldocs)](https://www.npmjs.com/package/keeldocs)
[![license](https://img.shields.io/npm/l/keeldocs)](https://github.com/SherifMoShalaby/keeldocs/blob/main/LICENSE)
[![CI](https://github.com/SherifMoShalaby/keeldocs/actions/workflows/ci.yml/badge.svg)](https://github.com/SherifMoShalaby/keeldocs/actions/workflows/ci.yml)

Your tests tell you when your code breaks. Nothing tells you when your **docs** break. keeldocs ties each documented claim to the code it describes and tells you exactly which claims stopped being true, with the evidence for each one.

It runs in your repo, writes plain Markdown, and calls no model and no network.

## See it

Point it at a repo you already have. Before writing anything, it audits the docs you already wrote:

```console
$ npx keeldocs init

keeldocs init - DRY_RUN

  stack: init-scenario-fixture | async-messaging:absent | client-routes:absent | config-surface:ok (env-readers@0.1.0) | db-policies:ok (sql-policies@0.1.0) | db-schema:ok (prisma@0.1.0) | decision-history:ok (git-log@0.1.0) | http-endpoints:ok (express@0.1.0,fastapi@0.2.0) | services-topology:absent | workspace-layout:ok (workspace-auto@0.1.0) | module-graph:ok (py-imports@0.2.1,ts-imports@0.2.0) | 12 facts

  Doc lie-detector - 4 finding(s) (2 candidate(s) suppressed):
    [file-claim] README.md:8  "scripts/seed.js"
      receipt: not found in the repo; no deletion record in reachable history
    [env-claim] README.md:9  "ITEMS_CACHE_URL"
      receipt: read nowhere in code (scanned 3 files for process.env.ITEMS_CACHE_URL / env("ITEMS_CACHE_URL"))
    [script-claim] README.md:16  "npm run deploy"
      receipt: no "deploy" in package.json scripts (lint, start)
    [route-claim] README.md:20  "GET /api/items"
      receipt: no matching route registration in extracted endpoints  did you mean: fact:http-endpoints/GET /items

  would write: docs/reference/endpoints.md, docs/architecture/data-model.md, docs/reference/configuration.md
  coverage: 0% -> 0% of 7 surfaces
  plan: 7 surface(s) still undocumented (full report has the list)

  apply with: keeldocs init --yes
```

Every finding carries a **receipt** — the specific check that produced it. Nothing is guessed, and nothing is written until you pass `--yes`.

Afterwards, drift reads like a failing test:

```console
$ npx keeldocs check

keeldocs check - DRIFT_FOUND
1 drift finding(s) [stale 1, dead 0, tampered 0] across 1 doc(s); 1 clean; 3/3 surfaces documented (100%)

  STALE     docs/reference/endpoints.md:7  api.inventory.table

cache: 1/4 provider(s) reused from .keeldocs/cache (--no-cache to re-extract)

full report: .keeldocs/out/check-8ff08e6d.json
```

That section is stale because a route it documents was renamed — not because someone reformatted the file. `keeldocs sync` then proposes a fix for that one section, which you accept or reject.

## Commands

| Command | What it does |
|---|---|
| `keeldocs init` | Audits existing docs for false claims, then writes anchored starter docs. Dry-run by default; never overwrites a file you already have. |
| `keeldocs check` | Reports drift, verification and coverage. Exit `0` clean, `1` findings, `2` error. Built for CI. |
| `keeldocs sync` | Proposes section-level fixes with evidence — `--apply`, `--reject`, `--snooze`, or interactive. Your prose is never overwritten. `--upgrade` migrates docs written by an older recipe. |
| `keeldocs new <type>` | Generates a document: `erd`, `endpoint-inventory`, `config-reference`, `system-map`, `module-guide`, `data-flow`, `screens`, `adr`. |
| `keeldocs doctor` | Preflight: checks Node, git, Python and every provider's declared requirements, then prints the exact install command for your machine. Run it first, or when `check` reports a tooling error. Exit `0` ready, `1` blocked, `3` degraded. |
| `keeldocs noise` | Prints how many proposals you accepted and rejected, in counts only — no paths, no titles, no ids. For sharing a noise report without sharing your repo. Nothing is sent anywhere. |
| `keeldocs skills install` | Installs the Agent Skills for your coding agent — see [below](#use-it-from-your-coding-agent). |

## Install

Try it with no install at all:

```bash
npx keeldocs init
```

Or install it, so `keeldocs` is on `PATH` in scripts — **`npx` leaves no binary behind**, so prefix every command with `npx` if you skip this:

```bash
npm install -D keeldocs
```

### Prerequisites

Node ≥ 20, git, and **Python 3 with the extractor runtime**. The Python part is not optional: without it every language extractor fails and `check` reports a tooling error instead of an answer.

```bash
python3 -m pip install --user -r https://raw.githubusercontent.com/SherifMoShalaby/keeldocs/main/providers/requirements.txt
```

On Homebrew or system Python add `--break-system-packages`; `--user` keeps it out of the managed prefix. On Windows use `py -m pip` — there is often no `python3` shim. Verify with `python3 -c "import tree_sitter_typescript"`. The canonical pin list is [`providers/requirements.txt`](https://github.com/SherifMoShalaby/keeldocs/blob/main/providers/requirements.txt).

### What to commit

keeldocs writes to `.keeldocs/` in your repo. Commit the journal, ignore the rest:

```gitignore
.keeldocs/cache/
.keeldocs/out/
```

`.keeldocs/decisions.jsonl` records every accept, reject and snooze. **Commit it** — otherwise CI re-proposes changes you already declined.

## How it works

**It extracts facts, not text.** Small extractor programs read your repo and emit typed facts — HTTP routes, database tables, env vars, services, packages, symbols, RLS policies. They write nothing and produce byte-identical output on every run. On Linux they run inside a read-only, network-less minimal root; on macOS and Windows the isolation is best-effort and the guarantee is the code rather than the kernel.

**Doc sections are anchored to those facts** by a small HTML comment that survives editing:

```markdown
<!-- keeldocs: id=api.inventory binds=fact:http-endpoints/* hash-kind=fact -->

<!-- keeldocs:gen id=api.inventory.table hash=h1:630e607ba8467056 -->
| method | path | source |
|---|---|---|
| GET | `/api/orders` | routes/api.js:5 |
<!-- /keeldocs:gen -->

Everything outside those markers is yours. keeldocs never touches it.
```

A section is stale when the fact it binds to changes — not when the file is touched. Reformat freely; nothing pages you.

**Fixes are proposals, not rewrites.** Only the block between the markers is regenerated. Your writing sits in slots the tool never authors.

**Nothing is invented.** The engine contains no model-calling code. If your coding agent writes prose, it passes through a validator that checks each claim against a known fact and labels anything inferred. A claim with no fact behind it cannot render as verified.

## What it can document

| Capability | Providers |
|---|---|
| HTTP endpoints | Express · NestJS · FastAPI · Django · Rails · Spring · Gin · ASP.NET · Supabase Functions · PostgREST |
| Database schema | Prisma · Drizzle · SQL replay · live Postgres (opt-in) |
| Database policies | static `CREATE POLICY` replay |
| Module graph | TypeScript · Python · Go · Java — imports and symbol identities |
| Async messaging | Kafka · RabbitMQ · Redis Pub/Sub · SQS/SNS · Supabase Realtime |
| Client routes | React Router · Next.js · Vue Router · Angular Router |
| Services topology | Docker Compose · Helm · Kustomize |
| Config surface | env var reads and `.env.example` — **names only, never values** |
| Workspace layout | pnpm · npm · yarn · pyproject · single-package |
| Decision history | git log (churn, HEAD-anchored) |

34 providers across 10 capabilities. On a stack with no matching provider, `init` writes nothing and `check` reports zero surfaces — that is the honest answer, not a failure.

## In CI

```yaml
# .github/workflows/keeldocs.yml
name: keeldocs
on: { push: { branches: [main] }, pull_request: }
jobs:
  docs:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v6
      - uses: SherifMoShalaby/keeldocs@v0.4.2
```

Drift fails the build; coverage never does. Findings appear in GitHub code scanning, plus one sticky PR comment that edits itself instead of posting again. Set `fail-on-drift: "false"` to report without failing.

There is also a scheduled **rollup** action that keeps at most one open PR applying deterministic regenerations — never a rebind or a tombstone, which always need a human.

## Use it from your coding agent

keeldocs ships as [Agent Skills](https://code.claude.com/docs/en/skills), so an agent working in your repo can answer *"are my API docs still accurate?"* by running the engine instead of reading the Markdown and forming an impression.

```bash
npx keeldocs skills install --agent claude-code   # or codex, cursor
```

Each agent looks in a different directory and rejects different frontmatter, so this reads the per-agent manifest rather than copying files — and it is safe to re-run.

This was measured, not assumed: Claude Code and Codex each discovered and invoked the skill unprompted, in both interactive and headless modes, and reported drift from the engine's output rather than their own reading. Cursor is not yet tested — there was no trustworthy install path for its CLI on the test machine. Method and results: [`experiments/e7-agent-matrix`](https://github.com/SherifMoShalaby/keeldocs/tree/main/experiments/e7-agent-matrix).

## Configuration

Optional, in `keeldocs.toml`:

```toml
[providers]
disable = ["compose"]              # skip a provider in this repo
exclude-paths = ["fixtures/**"]    # paths that never become facts

[docs]
dirs = ["docs", "handbook"]        # scan roots (default ["docs"]); README.md always scanned

[resolve]
pin = ["db-schema:prisma"]         # when two providers claim one capability

[trust]
keys = ["acme:<spki-base64>"]      # trusted signers for third-party providers
```

A misspelled key is an error, never a silent no-op.

`exclude-paths` is what you want for `fixtures/`, `examples/`, `vendor/` or
`testdata/`: those directories are real code, so providers extract them, and your
docs end up describing your test fixtures as though they were your application.
Disabling the provider is too blunt — you still want your own env vars. A fact
read from both an excluded and an included path survives with the excluded read
site dropped, and `check` reports how many facts the scope removed, because a
blind spot the report does not name is indistinguishable from an empty one.

### Live database introspection (opt-in)

```toml
[live]
dsn-env = "DATABASE_URL"           # the NAME of the env var holding the DSN — never the DSN
```

`keeldocs init --live` adds catalog-only introspection via [tbls](https://github.com/k1LoW/tbls), which you install separately. Live tables join the ERD with `INTROSPECTED` confidence, and declared beats live — a table already covered by Prisma is never duplicated. The DSN travels environment-to-environment, never through argv and never into a report. `--live` is refused in CI, because the check path stays free of network by design.

## What it deliberately does not do

- **It does not write your documentation for you.** It maintains what is derivable from code and leaves the reasoning to you.
- **It does not explain *why*.** Intent is not in the source, so keeldocs will not invent it.
- **It does not auto-merge.** Every change is a proposal a human accepts.
- **It has no hosted service, dashboard or account.** Markdown in your repo, anchors in HTML comments, nothing to sign up for.

Secrets are structurally excluded: env **values** never enter a fact, and every generated body passes a redaction scan before it can be written. If you stop using keeldocs, the anchors are inert HTML comments — delete them or leave them.

## Status

`0.4.2`, Apache-2.0. **Upgrading from `0.3.0`, `0.4.0` or `0.4.1`?** `check` can now fail on repositories it used to pass — every such case is one where it was reporting clean while checking nothing. [`CHANGELOG.md`](https://github.com/SherifMoShalaby/keeldocs/blob/main/CHANGELOG.md) has the measured before-and-after table.

`0.4.2`, Apache-2.0. Covered by 184 unit tests, 40 byte-compared extractor goldens and 95 end-to-end harness checks, with double-run determinism gates on Linux and macOS. Windows runs the same matrix and reports rather than gates.

Verified at scale: a synthetic 200-package, 1M-line repository extracts and checks end to end inside a 2 GB memory budget. Warm and cold runs produce byte-identical facts, gated on every fixture in the harness. **No speed figure is claimed** — that measurement is not yet trustworthy.

## Learn more

- [Design docs](https://github.com/SherifMoShalaby/keeldocs/tree/main/docs/design) — architecture, 13 ADRs, scope and risk register
- [Anchor specification](https://github.com/SherifMoShalaby/keeldocs/blob/main/spec/anchor-spec.md) — versioned and standalone
- [Roadmap](https://github.com/SherifMoShalaby/keeldocs/blob/main/ROADMAP.md) — what is done, what is deliberately refused, and why
- [Experiments](https://github.com/SherifMoShalaby/keeldocs/tree/main/experiments) — validation runs, including the scale benchmark and the ERD renderer that both failed first

## Contributing

Most new providers need no engine code beyond a short extractor: one tree-sitter query, one `provider.yaml`, one fixture. A few frameworks need nothing more than the query — `providers/http-endpoints/nestjs/` is the no-code worked example — while most need a Python extractor of around a hundred lines. Run `python3 scripts/harness.py` to test; no agent or API key required. Apache-2.0, DCO, no CLA.
