# Deliverable 11 — Open Questions

Updated 2026-07-30: the owner answered every decision-shaped open question (all with the panel's recommended option). Resolutions are recorded first; what remains open is now purely empirical — resolvable by experiments and reading, not by preference.

## Resolved by owner decision (2026-07-30)

1. **Name → "keeldocs"** (the keel is what keeps a ship from drifting). The first pick, "undrift", passed npm/PyPI but died at the GitHub check: an existing company (Undrift/Tether CRM) actively distributes a CLI named `undrift` via its own Homebrew tap — a live same-name CLI collision. "veridocs" also has an existing GitHub org. keeldocs is verified free on npm, PyPI, and GitHub (2026-07-30); still-free fallbacks: anchordocs, docanchor, moordocs, steadydocs. Remaining: crates.io + trademark sweep, and publish the placeholders promptly (R14).
2. **Diagnostic command → `check`** (CI-friendly; "drift" remains the report vocabulary). → ADR-012.
3. **Portfolio timing → v0.3 deferral stands**, even though the owner is himself the multi-repo user — single-repo facts must be trusted before a cross-repo map multiplies their errors; the owner's fleet becomes the v0.3 pilot. → ADR-011.
4. **Mongo → ODM-declared models only** (Mongoose/Prisma as declared facts); the opt-in shape sampler waits for the v0.3 pilot's noise data. → ADR-005.
5. **Windows → reduced trust, documented.** All provider tiers run with best-effort isolation and a plainly stated weaker guarantee; AppContainer/Job Object hardening is a later prototype, not a launch blocker. → ADR-013.
6. **Cross-repo DB identity → user-declared resource IDs** (`db.resource: "acme-main-pg"` in `docsmith.toml`); fingerprint clustering rejected as primary (silently-wrong heuristic joins are the failure class the tool exists to prevent) but may later *suggest* declarations. → ADR-011.
7. **Coverage denominator → concrete surfaces only** (endpoints, tables, env vars, services — natural keys, objective existence); exported-symbol coverage excluded from the metric and the ratchet. → ADR-012.
8. **Interview batch cap → 5 cards/session**, calibrated against the v0.2 beta's ≥50% completion gate.

## Still open — empirical, with the evidence that resolves each

1. **The "~46% / Continuous Documentation Synchronizer top rank" figure.** The N=860 Microsoft survey is real ("AI Where It Matters," Oct 2025, arXiv 2510.00762); the specific figure/name could not be verified from abstracts and may live in the 2026 follow-up ("To Copilot and Beyond"). Resolve: E12 full-text read. Don't use the number publicly until then.
2. **Auto-invoke reliability across agents.** Agent Skills adoption is verified; *uniform trigger behavior* is not. Resolve: E7 smoke matrix; where reliability is poor, that adapter documents explicit-invoke as primary.
3. **tbls licensing (believed MIT) and npm optionalDependencies binary distribution; gitleaks ruleset embedding terms.** Resolve: license checks + a distribution spike before v0.1 code freeze.
4. **pglite viability for no-Docker migration replay** (cheapest path for the v0.2 replay engine). Resolve: spike replaying 3 real Flyway/Alembic chains; fall back to Docker replay if WASM Postgres diverges from real DDL semantics.
5. **Agent-native path exclusion.** Whether each first-class agent exposes a deny mechanism the `exclude:` config can map onto (the tool enforces its own side regardless). Resolve: adapter audit during E7; document per-agent honesty in the README.
6. **Mongo sampler noise** (now explicitly post-v0.3): does sampled shape churn produce drift chatter? Resolve: 3-real-repo pilot; ships only if OBSERVED-tier FP <10%.
7. **Interview completion in the wild.** The 5-card cap is now a decision, but abandonment behavior is still unmeasured. Resolve: instrumented v0.2 beta against the ≥50% completion gate; adjust order/phrasing (not the cap) first if it misses.
8. **Remaining name checks for "keeldocs":** crates.io re-verify at publish time + formal trademark sweep (see Resolved #1; GitHub/npm/PyPI verified 2026-07-30).

## Flagged guesses that shipped as defaults (assumption register)

- Re-anchoring thresholds (0.95/0.85/0.90/0.75, ≥0.15 margin) are design targets, not measurements — E3 calibrates.
- Perf budgets (5s/15s/90s/10min/2GB) are budgets, not measured throughput — E8 validates.
- The ~25-entity ERD readability ceiling is practitioner experience — E11 tests.
- "Declarative tier ≥90% recall on decorator frameworks" is an estimate — E1 is the first thing to run.
- Accept-rate ≥30% as the noise-health line is borrowed intuition, not literature — E9 calibrates.
- SCIP grammar stability (position-independence of descriptors) taken from spec reading; verify against scip.proto before freezing the anchor spec at 1.0.
- Drizzle snapshot format details; nx graph-export flags; helm default-values rendering coverage; gradle literal-`include()` prevalence — all marked ASSUMPTION by the respective experts; each has a cheap verification during its provider's build.
- The MCP context-cost arithmetic behind ADR-010 (1.5–2.7k resident tokens/session; ~6× idle multiplier) is estimation from schema sizes at ~4 chars/token, not measurement — measure during E7 before citing publicly. The distribution decision does not hinge on the exact number (CI-headlessness and the open standard carry it), but the number should stop being a guess.

## Sources (key verified facts the design leans on)

- Agent Skills open standard + multi-vendor adoption: agentskills.io; code.claude.com/docs/en/skills; developers.openai.com/codex/skills; cursor.com/docs/context/skills
- SCIP grammar: raw.githubusercontent.com/sourcegraph/scip/main/scip.proto · stack-graphs archived: github.com/github/stack-graphs
- tree-sitter query predicates are binding-implemented: tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html
- Swimm's pivot: swimm.io · sw.md fragility: swimm.io/blog/docs-as-code-understanding-swimm-sw-md-markdown-format
- Dependabot deprecation study: arxiv.org/abs/2206.07230 · Microsoft survey: arxiv.org/abs/2510.00762
- Backstage descriptor format: backstage.io/docs/features/software-catalog/descriptor-format · OpenAPI 3.2: spec.openapis.org/oas/v3.2.0.html · AsyncAPI 3.1: asyncapi.com/docs/reference/specification/v3.1.0
- tbls: github.com/k1LoW/tbls · Atlas licensing: atlasgo.io/community-edition · Prisma introspection limits: prisma.io/docs/orm/prisma-schema/introspection
- Mermaid limits: mermaid.js.org/config/schema-docs/config.html · Mermaid C4 experimental: mermaid.js.org/syntax/c4.html
- Shai-Hulud npm worm / CISA: cisa.gov/news-events/alerts/2025/09/23 · npm provenance: docs.npmjs.com/generating-provenance-statements
- Spec Kit: github.com/github/spec-kit · Diátaxis on generated reference: diataxis.fr/reference · GitHub OSS survey: opensourcesurvey.org/2017
- Name availability: npm + PyPI (registry checks) and GitHub (page checks) for "keeldocs" + alternates, 2026-07-30 from this session; undrift collision: github.com/undrift/homebrew-tap.
