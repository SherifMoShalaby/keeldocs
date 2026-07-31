# keeldocs

**Test coverage for your docs.** keeldocs anchors every doc section to the code it describes, deterministically flags drift with receipts — *"README references `scripts/setup.sh` — deleted in `8f21ac9`, 4 months ago"* — and proposes reviewable, section-level patches. Any stack, any agent, no SaaS.

> Status: **v0.2.0-dev** (v0.1.0-rc.1 taggable at `927b4cb`). Design (nine-expert panel, 13 ADRs) → validation experiments on real repos → all four commands live, all seven v0.1 capabilities live (plus the static RLS surface), real-app beta, cross-OS CI determinism matrix, GitHub Action with SARIF, publish-ready packaging. 32 unit tests + 9 extractor goldens + 8 integration suites, double-run determinism gates on every one.

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

Until the npm package is published, clone and run `node bin/keeldocs.js` the same way.

### CI (GitHub Action)

```yaml
permissions: { contents: read, security-events: write, pull-requests: write }
steps:
  - uses: actions/checkout@v4
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

## v0.1 surface

| Command | Does |
|---|---|
| `keeldocs init` | Detection card → **doc lie-detector with receipts** → anchored starter docs (born clean, never overwrites) + doc plan ranked hotspot × fan-in. Dry-run by default, `--yes` applies. Zero LLM. |
| `keeldocs check` | Drift + verify + coverage. Deterministic, CI-ready: exit 0/1/2/3, `--json` envelope ≤8KB, `--ci` uses HEAD commit time (pure function of the SHA). |
| `keeldocs sync` | Reviewable proposals (regenerate/restore/rebind/tombstone) with evidence; `--apply`/`--reject`/`--snooze` + interactive `y/n/s/w`; journal-backed rejection memory; human edits never overwritten. |
| `keeldocs new <type>` | erd · endpoint-inventory · config-reference · system-map (all born clean, never overwrite) · adr capture; plus `slot-write` (7-gate prose validator, tool-applied draft labels) and `approve` (human attestation). A type without facts in your repo is honestly NOT_AVAILABLE. |

Capabilities (all live): http-endpoints (Express + **FastAPI** code-tier, NestJS pure-`.scm` declarative) · db-schema (Prisma) · db-policies (static `CREATE POLICY` replay) · config-surface (env reads + `.env.example` incl. `os.environ`/`os.getenv`, value-blind) · workspace-layout (pnpm/npm/yarn/pyproject/single) · services-topology (compose, owned-vs-external) · module-graph (ts-imports **and py-imports**: import edges + `ds` symbol identities with S1b move-matching, `__all__` honored) · decision-history (git-log churn, HEAD-anchored window).

## Repo layout

```
bin/            CLI entry - init/check/sync/new + slot-write/approve
action.yml      GitHub Action (composite): check --ci + SARIF + sticky PR comment
skills/         Agent Skills (open standard) — init/check/sync/new + core rules
adapters/       per-agent install manifests (Claude Code, Codex, Cursor)
providers/      capability providers + requirements.txt (pinned extractor runtime)
recipes/        doc types - erd, endpoint-inventory, config-reference, system-map, adr
fixtures/       tiny fixture repos + golden fact files — the contribution test bed
scripts/        harness.py (fixture matrix + determinism double-runs), sarif.js
spec/           anchor specification (versioned, standalone)
docs/design/    the full panel design: architecture, 13 ADRs, scope, risks
experiments/    E1/E2/E4 validation prototypes + results (they passed; receipts inside)
```

## Contributing

Pattern providers are the funnel, and it is real: one `.scm` tree-sitter query + a `provider.yaml` manifest + one fixture — zero code (`providers/http-endpoints/nestjs/` is the worked example; the shared runtime is `providers/_runtime/tsq.py`). `provider.yaml` is the machine-read registry: drop a provider in, it runs. Run `python3 scripts/harness.py` — no agent required. CI runs the same harness on Linux, macOS, and Windows (reduced-trust tier). Apache-2.0, DCO, no CLA.

## Design principles (non-negotiable)

Deterministic-first (no LLM, no network, no clock in the `check` path) · never fabricate rationale (inferred content is always visibly labeled) · patch, don't rewrite (human edits are sacred) · git-native, local-first, no SaaS · low noise or death.
