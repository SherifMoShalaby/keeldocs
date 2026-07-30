# keeldocs

**Test coverage for your docs.** keeldocs anchors every doc section to the code it describes, deterministically flags drift with receipts — *"README references `scripts/setup.sh` — deleted in `8f21ac9`, 4 months ago"* — and proposes reviewable, section-level patches. Any stack, any agent, no SaaS.

> Status: **v0.1 surface complete.** Design (nine-expert panel, 13 ADRs) -> validation experiments on real repos -> all four commands live: `init` (lie-detector + born-clean starter docs), `check` (deterministic drift/verify/coverage), `sync` (the retention loop with journal-backed decision memory), `new` + `slot-write`/`approve` (the mechanical LLM boundary). 22 unit tests + 9 harness suites under CI determinism gates. Next: publish placeholders, real-repo beta, full E-series corpus runs.

## Why

AI agents optimize the forward direction: spec → plan → code. Nothing maintains the backward direction: code → accurate, current documentation. Existing tools generate once and rot, or regenerate everything and destroy human edits. The gap is not generation — it is **continuous, verifiable accuracy**.

## How it works (the short version)

- **Write barrier.** Every machine-generated body passes the redaction barrier before hashing: secret patterns + entropy scan, `[REDACTED:rule]` substitution, loud envelope reporting - a matched secret never lands in a committed doc.
- **Deterministic spine.** Providers extract typed facts (endpoints, schema, env vars, services) from your repo — sandboxed, cache-keyed, byte-identical across runs. Facts, not prose, define truth.
- **Anchors.** Doc sections carry tiny identity-only HTML comments binding them to symbols/facts. Drift = the bound fact-hash changed. Formatting churn never pages anyone.
- **Draft-only LLM.** The engine contains zero model-calling code. Your agent writes prose only through a validating gate (`slot-write`); the tool applies the `⚠ inferred` label; verified facts render unbadged.
- **Noise SLO.** One weekly rollup PR max, self-caused-drift nudges only, journal-backed rejection memory, accept-rate self-throttling. Coverage is a ratchet, never a gate.

## Planned v0.1 surface

| Command | Does |
|---|---|
| `keeldocs init` | **LIVE.** Detection card → **doc lie-detector with receipts** → anchored starter docs (born clean, never overwrites) + plan. Dry-run by default, `--yes` applies. Zero LLM. |
| `keeldocs check` | **LIVE.** Drift + verify + coverage. Deterministic, CI-ready: exit 0/1/2/3, `--json` envelope. |
| `keeldocs sync` | **LIVE.** Reviewable proposals (regenerate/restore/rebind/tombstone) with evidence; `--apply`/`--reject`/`--snooze` + interactive `y/n/s/w`; journal-backed rejection memory; human edits never overwritten. |
| `keeldocs new <type>` | **LIVE.** erd · endpoint-inventory (born clean, never overwrite) · adr capture; plus `slot-write` (7-gate prose validator, tool-applied draft labels) and `approve` (human attestation). system-map/config-reference honestly NOT_AVAILABLE until their providers land. |

## Repo layout

```
bin/            CLI entry - init/check/sync/new + slot-write/approve, all live
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
