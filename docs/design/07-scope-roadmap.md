# Deliverables 7 & 8 — v0.1 Scope and Phased Roadmap with Go/No-Go Gates

## 1. v0.1 — ruthlessly minimal, with the wow resolved

**Thesis shipped:** one loop — anchor → check → sync — proven end-to-end on one ecosystem, with a zero-LLM first-run wow.

| Axis | In v0.1 | Explicitly deferred (why) |
|---|---|---|
| Languages | TypeScript/JavaScript end-to-end + all language-agnostic providers (git-log, workspace/compose parsing, SQL-DDL parsing) | Python = **the** v0.2 headline (every language doubles fixture surface — PM, upheld in rebuttal); Java/Go v0.3 |
| Capabilities | workspace-layout (pnpm/yarn/npm/single) · module-graph (ts-imports + per-ecosystem resolver) · http-endpoints (**express as code provider**, nestjs declarative) · db-schema (prisma, drizzle, rails-schema/structure.sql) · config-surface (env reads + .env.example keys; values structurally impossible) · services-topology (compose static parse only) · decision-history (git-log only) | async-messaging, helm/kustomize (need variant machinery), pr/issue-mining (network + injection + secret-resurrection; opt-in v0.3), **auth-model (cut until determinism proven — unanimous)** |
| Live DB | Postgres-wire only (covers Supabase) via tbls, `--live` flag, env-named DSN, catalog-only, **off the critical path** — slips to v0.1.1 without slipping the release (D2); static `CREATE POLICY` parsing ships regardless; Supabase RLS access-matrix where live is granted | MySQL/SQLite/Mongo live → v0.3; migration **replay engine** (unlocks flyway/alembic/liquibase at once) → v0.2 |
| Recipes | system-map, erd, endpoint-inventory, config-reference, + `new adr` capture template | module guide & onboarding-verify v0.2; data-flow v0.3; C4-component, runbook-generation, **BRD/PRD: cut permanently** |
| Commands | `init`, `check` (absorbs drift/verify/coverage; `--ci`), `sync` (post-edit nudge, weekly rollup, y/n/e/s/w), `new` | `ask` deleted (host-agent competence); `map` internal |
| Agents | Claude Code (plugin + marketplace), Codex, Cursor first-class with CI smoke tests; AGENTS.md universal fallback; standard-layout best-effort elsewhere | MCP: none through v0.2; v0.3 decision point only on concrete shell-less demand (D4) |
| LLM | zero model-calling code; host agent is the model; `slot-write` validator + draft labels + prose-stability gate ship in v0.1 | headless BYO-key/Ollama prose → v0.3 |
| Community | declarative (T0) providers via repo PRs + fixture harness (`test-provider`) — the harness is v0.1 core infrastructure, not tooling nicety | T2 installable code providers wait for signing/pinning/`provider trust` machinery (v0.2+) — Security/PM synthesis (D9) |

**The wow, resolved (ADR-012/D5).** `init` on a brownfield repo, <5 minutes, zero LLM calls: detection card (correctable) → deterministic extraction → **doc lie-detector with receipts** ("README references `scripts/setup.sh` — deleted in `8f21ac9`, 4 months ago"; "documents `REDIS_URL` — read nowhere"; "curl example hits `/api/v1/orders` — route no longer registered") → commits anchored starter artifacts + prioritized doc plan (hotspot × fan-in) → "3 things in your README are already wrong; run `check` after your next PR." The drift tripwire is armed on day one because init *committed anchored docs* — the corpus sync protects. Retention is the agent-side loop, not the wow: ambient grounding + the post-edit nudge (same-branch patch, one keystroke).

**Noise SLO ships as spec, v0.1** (ADR-012): one weekly rollup PR max, amended; nudges only for self-caused drift, ≤3/day; 21-day auto-expiry; journal-backed snooze/rejection memory; accept-rate <30%/4wk → halve frequencies, announced; CI report-only default, sticky comment; coverage = ratchet vs base branch, never a gate; waivers visible debt.

**Cut-order if the date slips** (pre-agreed, PM): compose topology → drizzle → live-pg (→ v0.1.1). Never cut: the fixture harness, the noise SLO, the redaction barrier, slot-write.

## 2. Roadmap and gates (numbers, not vibes; measurement honesty: local-first means public-repo scraping for the anchor string + opt-in ping)

### v0.1 → v0.2 gates
- `init` p50 <5 min on the fixture matrix; cold extraction ≤90s on the 100k-LOC fixture and ≤10 min on the 1M-LOC/200-package synthetic (E8); warm `check` p50 ≤5s after a 1-file change.
- Drift false-positive rate <10% across 5 fixture repos; no duplicate FP report filed >2×.
- Lie-detector precision: ≥95% of findings verifiable (each carries a receipt) on fixture + 5 real brownfield repos.
- Anchor survival ≥95% over a 6-month history replay of ≥5 real repos with zero human input; false auto-rebind <0.5%.
- Determinism: byte-identical fact files + resolution across linux/macos/windows, two runs each (CI golden test green).
- Adoption: ≥50 public repos with committed anchors; ≥30% of opt-in installs run `check`/`sync` in week 4; ≥20 externally-filed issues.

### v0.2 (headline: Python GA; interview/elicitation; replay engine; module-guide + onboarding-verify recipes; T2 trust machinery) → v0.3 gates
- Python: fixture matrix green; drift FP <10% on 2 real Python repos.
- Contribution economics: first external provider merged with <4h total maintainer effort; ≥3 external providers merged; time-to-first-merged-provider ≤7 days (tracked via PR labels).
- Drift FP <5%; ≥10 public repos running `check --ci` in Actions.
- Interview: resumable across sessions purely from files; ≤5 cards / ≤1,500 tokens per batch; rejected candidates never re-asked (journal-verified); ≥50% card-batch completion rate in the beta cohort.
- Replay engine: replayed migration chains produce schemas byte-identical (post-normalization) to a real live migration run on ≥10 fixture chains across flyway/alembic/liquibase.
- T2 trust machinery: signed-provider install E2E green; unsigned/hash-mismatched provider install provably refused; E10 injection red-team passed.

### v0.3 (portfolio mode via `export --backstage`; Java/Go; helm/kustomize variant machinery; async-messaging; MySQL/Mongo live; headless prose; MCP decision point) → v1.0 gates
- Portfolio: started only after ≥3 distinct real multi-repo users request it (PM gate); join demo across ≥2 stacks with zero cross-language analysis.
- Variant topology: helm chart corpus renders with declared values; unknowns schema'd, never guessed.
- New languages (Java/Go): same bar as Python — fixture matrix green + drift FP <10% on 2 real repos each, per language, before GA.
- async-messaging: E1-style labeled corpus; ≥90% recall / ≥98% precision on declared topics before the data-flow recipe unlocks.
- MySQL/Mongo live: Security's least-privilege recipes reviewed per dialect; Mongo sampler ships only if the OBSERVED-tier pilot (3 real repos) shows drift-chatter FP <10%.
- Headless prose (BYO key/Ollama): slot-write rejection rate <20% with a 7B local model on the fixture corpus, else the feature stays agent-only.
- MCP decision point: build the shim only if a named shell-less surface with ≥25 requesting users exists; the shim must be generated from the CLI command table, never hand-written.

### v1.0
- Anchor spec frozen at 1.0, published standalone, with a written migration policy.
- ≥500 public repos with anchors; ≥2 non-founder maintainers with merge rights (**hard gate — no v1.0 at bus factor 1**).
- Survived one breaking agent-API change with an adapters-only fix shipped ≤1 week.
- Noise SLO holding in the wild: accept-rate ≥30% sustained, or self-throttle demonstrably engaging.

## 3. Positioning (one line each — PM, verified July 2026)
- **Not Swimm:** Swimm pivoted to enterprise legacy-modernization services; docsmith is free, in-repo, no services motion — and fixes Swimm's three killers (proprietary fragility, new surface, no daily consumer).
- **Not DeepWiki:** hosted, whole-repo-regenerated browsing wiki; docsmith is git-native, incremental, draft-gated, air-gap-friendly.
- **Not Mintlify:** hosted docs-site + writing agent for published product docs; docsmith maintains internal engineering docs with deliberately no hosting layer.
- **Not Spec Kit:** forward (spec→code); docsmith is backward (code→docs) and anchors onto Spec Kit's spec files rather than replacing them.
- **Not Backstage TechDocs:** TechDocs renders markdown in a portal; docsmith is what keeps that markdown true — and exports catalog metadata to it.

## 4. Governance, license, contribution economics (PM, adopted)
Apache-2.0 (explicit patent grant eases enterprise CI adoption; zero adoption cost vs MIT). DCO sign-off, **no CLA** (CLAs suppress exactly the drive-by provider PRs the model lives on). BDFL + CODEOWNERS until v1.0, then a 3-person core team. Pattern-provider contribution target: 1 `.scm` + 1 mapping YAML + 1 fixture, ≤2 hours effort. Certification: Tier C community (harness-passing, registry-listed, opt-in) / Tier B verified (≥2 attested real repos, reviewed) / Tier A core (in-box, FP-budgeted, capped at ~10 to protect the maintainer). Monthly release train; a broken adapter is dropped, never blocking.

## 5. Kill list (refuse even when requested)
Hosted dashboard/web UI · docs-site generation or themes · auto-merge of any generated content · general code chat/Q&A · code-review bot · translation/i18n · a VS Code extension (second churn treadmill) · per-framework mega-providers (Option A through the back door) · required telemetry · live-DB write access, ever · row-value sampling into committed artifacts, ever · BRD/PRD generation, ever.
