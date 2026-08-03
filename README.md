# keeldocs

**Test coverage for your docs.** keeldocs anchors every doc section to the code it describes, deterministically flags drift with receipts — *"README references `scripts/setup.sh` — deleted in `8f21ac9`, 4 months ago"* — and proposes reviewable, section-level patches. Any stack, any agent, no SaaS.

> Status: **`0.2.0-rc.1` on npm** — `npx keeldocs init` works today. Design (nine-expert panel, 13 ADRs) → validation experiments on real repos → all four commands live, **35 providers across 10 capabilities** feeding 5 doc recipes, real-app beta, cross-OS CI determinism matrix, GitHub Action with SARIF, publish-ready packaging. **151 unit tests + 39 extractor goldens + 80 harness checks**, double-run determinism gates on every one.

## Why

AI agents optimize the forward direction: spec → plan → code. Nothing maintains the backward direction: code → accurate, current documentation. Existing tools generate once and rot, or regenerate everything and destroy human edits. The gap is not generation — it is **continuous, verifiable accuracy**.

## How it works (the short version)

- **Deterministic spine.** Providers extract typed facts (endpoints, schema, env vars, services, packages, symbols, policies) from your repo — sandboxed, cache-keyed, byte-identical across runs. Facts, not prose, define truth.
- **Anchors.** Doc sections carry tiny identity-only HTML comments binding them to facts (`fact:http-endpoints/GET /orders`) or symbols (`ds <pkg> . src/auth.ts/login().`). Drift = the bound fact-hash changed. Formatting churn never pages anyone; a moved symbol gets an evidence-backed rebind proposal.
- **Write barrier.** Every machine-generated body passes the redaction barrier before hashing: secret patterns + entropy scan, `[REDACTED:rule]` substitution, loud envelope reporting — a matched secret never lands in a committed doc. Env **values** are structurally absent from every schema.
- **Draft-only LLM.** The engine contains zero model-calling code. Your agent writes prose only through a validating gate (`slot-write`); the tool applies the `⚠ inferred` label; verified facts render unbadged.
- **Noise SLO.** Journal-backed rejection memory (a rejected proposal is never re-made), snooze/tombstone decisions, surgical binds (a policy edit stales the policy table, never the ERD). Coverage is a ratchet, never a gate.

## Quickstart

Requires Node ≥ 20, Python 3 (extractor runtime: `pip install -r providers/requirements.txt`), git.

```bash
npx keeldocs init          # dry-run: detection card + doc lie-detector with receipts
npx keeldocs init --yes    # write anchored starter docs (born clean, never overwrites)
npx keeldocs check         # drift + verify + coverage; exit 0/1/2
npx keeldocs sync          # review section-level proposals; --apply/--reject/--snooze
```

Published as a pre-release: `latest` and `rc` both point at `0.2.0-rc.1`. Running from a clone works identically — `node bin/keeldocs.js <command>`.

### CI (GitHub Action)

```yaml
permissions: { contents: read, security-events: write, pull-requests: write }
steps:
  - uses: actions/checkout@v6
  - uses: SherifMoShalaby/keeldocs@main   # check --ci + SARIF + one sticky PR comment
```

Coverage never gates; drift does (`fail-on-drift: "false"` to soften). Findings land in code scanning as `keeldocs/stale|dead|tampered`.

### Config (`keeldocs.toml`, optional)

```toml
[providers]
disable = ["compose"]        # provider ids to skip in this repo

[docs]
dirs = ["docs", "handbook"]  # scan roots (default ["docs"]); README.md always scanned
```

Schema-strict: a typo'd key is a CONFIG error (exit 2), never a silent no-op.

### Live Postgres (`--live`, opt-in)

```toml
[live]
dsn-env = "SUPABASE_DB_URL"  # the NAME of the env var holding the DSN - never the DSN itself
```

`keeldocs init --live` / `check --live` add catalog-only introspection via [tbls](https://github.com/k1LoW/tbls) (`brew install k1LoW/tap/tbls`): live tables land as schema-qualified facts (`fact:db-schema/public.orders`) with INTROSPECTED confidence and join the ERD. Declared beats live: a table already covered by Prisma is skipped, never duplicated. The DSN travels env-to-env (`TBLS_DSN`), never argv, never any report. `--live` is refused in CI - network never enters the pure-function check path - and docs initialized with `--live` should be checked with `--live`.

## v0.1 surface

| Command | Does |
|---|---|
| `keeldocs init` | Detection card → **doc lie-detector with receipts** → anchored starter docs (born clean, never overwrites) + doc plan ranked hotspot × fan-in. Dry-run by default, `--yes` applies. Zero LLM. |
| `keeldocs check` | Drift + verify + coverage. Deterministic, CI-ready: exit 0/1/2/3, `--json` envelope ≤8KB, `--ci` uses HEAD commit time (pure function of the SHA). |
| `keeldocs sync` | Reviewable proposals (regenerate/restore/rebind/tombstone) with evidence; `--apply`/`--reject`/`--snooze` + interactive `y/n/s/w`; journal-backed rejection memory; human edits never overwritten. |
| `keeldocs new <type>` | erd · endpoint-inventory · config-reference · system-map (all born clean, never overwrite) · adr capture; plus `slot-write` (7-gate prose validator, tool-applied draft labels) and `approve` (human attestation). A type without facts in your repo is honestly NOT_AVAILABLE. |

### Capabilities and providers (all live)

| Capability | Providers |
|---|---|
| `http-endpoints` | aspnet · django · express · fastapi · gin · nestjs · rails · spring · supabase-functions · supabase-postgrest |
| `db-schema` | prisma · drizzle · rails-sql · sql-replay · tbls-live (`--live`, opt-in) |
| `db-policies` | sql-policies (static `CREATE POLICY` replay) |
| `module-graph` | ts-imports · py-imports · go-symbols · java-symbols — import edges + `ds` symbol identities with S1b move-matching |
| `async-messaging` | kafka · rabbitmq · redis-pubsub · sqs-sns · supabase-realtime |
| `client-routes` | react-router · next-routes · vue-router · angular-router |
| `services-topology` | compose · helm · kustomize (owned-vs-external) |
| `config-surface` | env-readers — env reads + `.env.example`, incl. `os.environ`/`os.getenv`, **value-blind** |
| `workspace-layout` | workspace-auto (pnpm/npm/yarn/pyproject/single) |
| `decision-history` | git-log (churn, HEAD-anchored window) |

Code-tier providers parse real call sites; declarative-tier providers are pure `.scm` tree-sitter queries with no code at all. Both are sandboxed subprocesses that emit JSON and write nothing.

**Monorepo scale.** A synthetic 200-package, 1M-line repo extracts and checks end to end inside the 2 GB memory budget, and every fact is byte-identical between a warm and a cold run (`experiments/e8-scale/`). No warm-check latency figure is claimed yet — that measurement needs hardware whose own timing does not drift, and it is the one thing R10 still owes.

## Repo layout

```
bin/            CLI entry - init/check/sync/new + slot-write/approve
action.yml      GitHub Action (composite): check --ci + SARIF + sticky PR comment
skills/         6 Agent Skills (open standard) - init/check/sync/new/interview + core rules
adapters/       per-agent install manifests (Claude Code, Codex, Cursor)
providers/      capability providers + requirements.txt (pinned extractor runtime)
recipes/        doc types - erd, endpoint-inventory, config-reference, system-map, adr
fixtures/       27 tiny fixture repos + 39 golden fact files - the contribution test bed
scripts/        harness.py (fixture matrix + determinism double-runs), sarif.js
spec/           anchor specification (versioned, standalone)
docs/design/    the full panel design: architecture, 13 ADRs, scope, risks
experiments/    11 experiment dirs + VALIDATION-REPORT.md - receipts, including the two that failed first (E8 scale, E11 ERD)
```

## Contributing

Pattern providers are the funnel, and it is real: one `.scm` tree-sitter query + a `provider.yaml` manifest + one fixture — zero code (`providers/http-endpoints/nestjs/` is the worked example; the shared runtime is `providers/_runtime/tsq.py`). `provider.yaml` is the machine-read registry: drop a provider in, it runs. Run `python3 scripts/harness.py` — no agent required. CI runs the same harness on Linux, macOS, and Windows (reduced-trust tier). Apache-2.0, DCO, no CLA.

## Design principles (non-negotiable)

Deterministic-first (no LLM, no network, no clock in the `check` path) · never fabricate rationale (inferred content is always visibly labeled) · patch, don't rewrite (human edits are sacred) · git-native, local-first, no SaaS · low noise or death.
