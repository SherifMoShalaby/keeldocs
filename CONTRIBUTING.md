# Contributing to keeldocs

Apache-2.0. **DCO sign-off required (`git commit -s`), no CLA.** Governance: BDFL + CODEOWNERS until v1.0 (see docs/design/07-scope-roadmap.md §4).

## The fast path: a declarative (T0) pattern provider

The easy 80% of stack coverage is contributed as data, not code — target ≤2 hours:

1. `providers/<capability>/<your-framework>/provider.yaml` — id, detect predicates (dependency names from manifests — never source parsing in detect), declared input globs, timeout class. See `providers/http-endpoints/nestjs/provider.yaml`.
2. `endpoints.scm` (or equivalent) — a tree-sitter query. Constraints that make T0 safe-by-construction: queries are matched, never evaluated; any regex must be RE2-class (no backtracking); outputs are typed and length-capped.
3. `mapping.yaml` — captures → fact-schema fields. Fact IDs are natural keys (`fact:<capability>/<key>`), never UUIDs.
4. A fixture: `fixtures/<your-framework>-basic/` — a 10–30 file minimal app — plus its golden fact file. **Ground truth before extractor**: enumerate the true facts by hand first.
5. `python3 scripts/harness.py` must pass, including the determinism double-run (same bytes twice).

Code-tier (T1/T2) providers are maintainer-reviewed like core code and sandboxed (subprocess, no network, declared globs only — see docs/design/04-provider-contract.md §5). Community-installable code providers (T2) do not exist until the signing/pinning machinery ships (v0.2+).

## Determinism rules (CI enforces; PRs violating them are rejected)

No floats in confidence or scoring — the lattice is enumerated. No timestamps, wall clock, locale, map-iteration order, or filesystem enumeration order anywhere in extraction/resolution. Canonical JSON (RFC 8785 JCS): sorted keys, `ordered` vs `set` array fields declared in the fact schema. Provider identity goes in provenance, never inside hashed payloads. Extraction failure is `unresolvable`, never drift, never silence — emit `extraction-gap` facts.

## What we will not merge

BRD/PRD generation, hosted anything, auto-merge of generated content, telemetry, per-framework mega-providers, LLM calls inside the engine, row-value sampling into artifacts. Full kill list: docs/design/07-scope-roadmap.md §5.

## Provider certification

Tier C (community: harness-passing, registry-listed, opt-in) → Tier B (verified: ≥2 attested real repos, reviewed) → Tier A (core, FP-budgeted, capped ~10). Time-to-first-merged-provider is a tracked project metric — if review takes more than 7 days, ping the thread.
