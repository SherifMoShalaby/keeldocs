# keeldocs

**Test coverage for your docs.** keeldocs anchors every doc section to the code it describes, deterministically flags drift with receipts — *"README references `scripts/setup.sh` — deleted in `8f21ac9`, 4 months ago"* — and proposes reviewable, section-level patches. Any stack, any agent, no SaaS.

> Status: **pre-0.1 scaffold.** The design is complete (nine-expert panel, 13 ADRs), the core assumptions passed their validation experiments on real repos, and the anchor engine and `keeldocs check` are real and running today - drift (stale/dead/tampered/intentionally-removed/unresolvable), tamper detection, journal semantics, coverage, envelope + exit codes, all under CI determinism gates. `init`/`sync`/`new` land next.

## Why

AI agents optimize the forward direction: spec → plan → code. Nothing maintains the backward direction: code → accurate, current documentation. Existing tools generate once and rot, or regenerate everything and destroy human edits. The gap is not generation — it is **continuous, verifiable accuracy**.

## How it works (the short version)

- **Deterministic spine.** Providers extract typed facts (endpoints, schema, env vars, services) from your repo — sandboxed, cache-keyed, byte-identical across runs. Facts, not prose, define truth.
- **Anchors.** Doc sections carry tiny identity-only HTML comments binding them to symbols/facts. Drift = the bound fact-hash changed. Formatting churn never pages anyone.
- **Draft-only LLM.** The engine contains zero model-calling code. Your agent writes prose only through a validating gate (`slot-write`); the tool applies the `⚠ inferred` label; verified facts render unbadged.
- **Noise SLO.** One weekly rollup PR max, self-caused-drift nudges only, journal-backed rejection memory, accept-rate self-throttling. Coverage is a ratchet, never a gate.

## Planned v0.1 surface

| Command | Does |
|---|---|
| `keeldocs init` | Detect stack → deterministic repo map (system map, ERD, endpoint inventory, config reference) → **doc lie-detector with receipts** → anchored starter docs + plan. Zero LLM, <5 min. |
| `keeldocs check` | **LIVE.** Drift + verify + coverage. Deterministic, CI-ready: exit 0/1/2/3, `--json` envelope. |
| `keeldocs sync` | Section-level reviewable patches (`y/n/e/s/w`); human edits never overwritten. |
| `keeldocs new <type>` | erd · system-map · endpoint-inventory · config-reference · adr |

## Repo layout

```
bin/            CLI entry (envelope + exit codes live; commands stubbed)
skills/         Agent Skills (open standard) — init/check/sync/new + core rules
adapters/       per-agent install manifests (Claude Code, Codex, Cursor)
providers/      capability providers — declarative (.scm + mapping) and code-tier
recipes/        doc types (ERD fully specified; others stubbed)
fixtures/       tiny fixture repos + golden fact files — the contribution test bed
scripts/        harness.py — fixture matrix + determinism double-run (CI runs this)
spec/           anchor specification (versioned, standalone)
docs/design/    the full panel design: architecture, 13 ADRs, scope, risks
experiments/    E1/E2/E4 validation prototypes + results (they passed; receipts inside)
```

## Contributing

Pattern providers are the funnel: one tree-sitter query + one mapping YAML + one fixture, target ≤2 hours (see `CONTRIBUTING.md`). Run `python3 scripts/harness.py` — no agent required. Apache-2.0, DCO, no CLA.

## Design principles (non-negotiable)

Deterministic-first (no LLM, no network, no clock in the `check` path) · never fabricate rationale (inferred content is always visibly labeled) · patch, don't rewrite (human edits are sacred) · git-native, local-first, no SaaS · low noise or death.
