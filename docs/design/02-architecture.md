# Deliverable 2 — Architecture Document

Codename: **docsmith** (must be renamed before shipping — see Open Questions).
One-sentence pitch (PM, adopted): *"Test coverage for your docs: anchors every doc section to the code it describes, deterministically flags drift, and proposes reviewable patches — any stack, any agent, no SaaS."*

## 1. System overview

The product is a **headless deterministic CLI** (the spine) wrapped by an **Agent Skills layer** (the primary distribution). The CLI is independently valuable with no agent present — CI, cron, pre-commit — because CI is where drift detection earns trust. Agents are the primary *daily consumer* of the outputs and the interactive surface for review and elicitation.

```
                        ┌────────────────────────────────────────────────┐
   repo (code, docs,    │                 ENGINE (CLI)                   │
   manifests, .git)     │                                                │
        │               │  detect ──► extract ──► normalize ──► resolve  │
        ▼               │  (manifest   (providers,   (canonical  (lattice│
  ┌───────────┐         │   index)      sandboxed)    facts)      + prec)│
  │ providers │────────►│                                                │
  │ T0 .scm   │         │        ┌──────────────┐    ┌────────────────┐  │
  │ T1 code   │         │        │ fact files   │───►│ merged graph   │  │
  └───────────┘         │        │ (JSONL, JCS) │    │ (SQLite index) │  │
                        │        └──────┬───────┘    └───────┬────────┘  │
                        │               │                    │           │
                        │        ┌──────▼───────┐    ┌───────▼────────┐  │
                        │        │ recipes      │    │ drift engine   │  │
                        │        │ render docs  │    │ (anchor index) │  │
                        │        └──────┬───────┘    └───────┬────────┘  │
                        │               │                    │           │
                        │   REDACTION BARRIER (all artifact writes)      │
                        └───────┬────────────────────────┬───────────────┘
                                ▼                        ▼
                        docs/**.md + anchors      check report / sync patches
                                ▲                        ▲
                 ┌──────────────┴────────┐   ┌───────────┴───────────┐
                 │ Agent Skills layer    │   │ CI (check --ci)       │
                 │ init/check/sync/new   │   │ exit codes, sticky    │
                 │ + slot-write for prose│   │ comment, ratchet      │
                 └───────────────────────┘   └───────────────────────┘
```

## 2. Components

**Detection.** Reads dependency manifests and infra files only (`package.json`, `pnpm-workspace.yaml`, `docker-compose.yml`, migration dirs, …) — never source — to build a `ManifestIndex`. Providers declare applicability against it in ≤100ms each. Misdetection is correctable inline before extraction runs.

**Providers** (full contract: Deliverable 4). Two tiers. *Declarative (T0):* tree-sitter query files (`.scm`) + a small YAML manifest mapping captures to fact-schema fields; safe by construction (patterns matched, never evaluated; RE2-class regex only; typed, length-capped output). *Code (T1 first-party; T2 community, v0.2+):* sandboxed subprocesses for anything needing I/O or cross-statement reasoning — live DB catalog reads, migration replay, Express router-mount resolution. Both tiers emit the identical fact schema with identical provenance; there are no second-class outputs.

**Fact store — layered (ADR-004).** Canonical *derived* layer: per-(capability, shard) JSONL fact files, JCS-canonical, deterministic natural-key fact IDs, gitignored. Merged layer: a SQLite graph index for cross-capability joins (endpoint→symbol→module→service), rebuilt per dirty shard, disposable. Cross-shard edges are emitted as half-edges with symbolic targets and joined by a linker at merge time, so a shard's cache never depends on another shard's content.

**Resolution (ADR-003).** A pure fold over facts sorted by `(fact_id, provider_id)`: enumerated confidence lattice `INTROSPECTED > PARSED > PATTERN > GENERIC > OBSERVED > INFERRED`, then a versioned static precedence table per capability, then lexicographic provider id as a total-order backstop. Lattice semantics: only *repo-derived* facts enter canonical resolution. `INTROSPECTED` means introspection of a database instance that is itself repo-derived — the v0.2 ephemeral migration-replay engine, or a committed declared baseline snapshot; ad-hoc live-environment reads are `OBSERVED`, are excluded from canonical resolution entirely, and surface only as disagreement facts (ADR-005). This keeps the lattice consistent with "declared beats live." Same-tier conflicts become first-class conflict facts with all claims + the deciding rule, surfaced in `check`, pinnable in `docsmith.toml`. Output is byte-identical across runs and OSes; a `resolution-report.json` records every decision.

**Drift engine (ADR-008).** A doc section is a derived artifact: `section = render(facts)`; drift = the fact-hash an anchor binds changed. Never source bytes, never LLM judgment. The anchor index (doc → anchor → symbol/fact IDs → hashes) is a gitignored derived cache; whole-repo drift is an indexed hash comparison (≤2s over 500 docs). Extraction failure is `unresolvable` (tooling health), never drift. Hash-algorithm versions are embedded (`h1:`); version bumps re-baseline silently instead of flagging the world.

**Recipes (Deliverable 5).** `recipe.yaml` + template with three slot kinds — `deterministic` (machine-owned gen regions), `llm-prose` (validated, labeled, fact-bound), `human` (never touched). Diagrams are emitted canonically (sorted nodes/edges) in stable Mermaid syntaxes (flowchart, erDiagram — not the experimental C4 syntax).

**LLM boundary (ADR-009).** The engine contains zero model-calling code; the host agent is the model. Prose enters docs only through `slot-write`, a deterministic validator that rejects unknown slots, gen-region intrusion, over-length text, unresolvable identifier citations, and prose changes whose underlying fact-hash didn't change (the anti-thrash gate). The *tool*, never the model, applies the `⚠ inferred draft` label; `approve` records human attestation.

**Redaction barrier (ADR-013).** One choke point through which every byte destined for a committed artifact passes: structural denial (the config-surface schema has no value field), gitleaks-ruleset pattern scan, entropy scan, `[REDACTED:<rule>]` substitution with a human-ack finding. Git-history/PR excerpts are scanned before entering context or state.

**Skills layer (ADR-010).** Four intent skills — `init`, `check`, `sync`, `new` — plus a small non-invocable knowledge skill; Agent Skills open-standard format installed into each agent's discovery path by `init`; an AGENTS.md block is the universal fallback. Heavy work always runs in the CLI outside the context window and returns a capped JSON envelope (≤8KB, summary ≤300 chars, spill to `.docsmith/out/`, exit codes 0/1/2/3).

## 3. What lives where (the canonical/derived line)

| Location | Contents | Why |
|---|---|---|
| **Committed** | `docs/**` with identity-only anchors | The product; survives without the tool |
| **Committed** | `docsmith.toml` | Config: provider pins, resolution overrides, topology variant declarations, exclusions, noise SLO |
| **Committed** | `.docsmith/decisions.jsonl` | Append-only journal of *human decisions only*: tombstones, rejections, snoozes, waivers, adjudicated rebinds. JCS lines, `merge=union`, read-only in CI, gc via reviewable PR (D1 synthesis) |
| **Committed, deliberately** | declared baselines from live bootstrap (e.g. a labeled schema snapshot) | Environment-derived observations are *not reproducible from the repo*; if kept, they are promoted to declared sources, explicitly labeled `source: live-snapshot, env, at` |
| **Gitignored** | `.docsmith/cache/facts/**`, `graph.db`, anchor index, mined candidates, `out/` | Pure functions of repo content + provider set; rebuildable; committing them creates a second source of truth (Architect veto, Platform veto) |

Rule that resolves the panel's sharpest structural fight: **derived state is never committed; human decisions are never gitignored.**

## 4. Data flow for the three core loops

**First run (`init`, zero LLM, <5 min):** detection card (correctable) → sharded extraction (hotspot-sampled on huge repos, honest partial results) → **doc lie-detector**: existing README/docs claims checked against facts, each finding with a receipt (commit SHA, file:line) → commit starter anchored artifacts (system-map, ERD, endpoint inventory, config reference) + a prioritized doc plan (change-frequency × fan-in) → drift tripwire armed.

**Daily (agent session):** the skill auto-consults fact files/docs for grounding (passive value); when the session's own edits touch anchored symbols, a post-edit nudge offers to patch the affected sections in the same branch — the habit-former. All other drift is pull, batched into one weekly rollup PR (amended, never multiplied) with per-section suggestion blocks.

**CI (`check --ci`):** deterministic only — no LLM, no network, no live DB, ever. Incremental via affected-package closure; sticky PR comment updated in place; exit 0 clean / 1 findings / 2 tool error (always fails — misconfiguration must never masquerade as "no drift") / 3 budget-degraded (warns). Coverage is a ratchet vs the base branch, never a hard gate; blocking on tier-1/2 contradictions is opt-in.

## 5. Where the determinism boundary sits

Deterministic by contract (byte-identical across runs/OSes, CI-golden-tested): detection, extraction, normalization, resolution, fact files, graph, anchors, hashes, drift computation, diagram emission, coverage arithmetic, redaction, envelopes. Banned inputs: floats, timestamps, map iteration order, locale, filesystem enumeration order, wall clock.

Non-deterministic, quarantined and labeled: LLM prose (slot-write-gated, draft-labeled, prose-stability-gated), live-environment observations (labeled with env + time, compared against declared facts to produce *disagreement facts* — the delta is the documentation, ADR-005), interview answers (human-attested facts with author + date).

The single most load-bearing consequence: **anything in the drift/check path is on the deterministic side.** An LLM call in `check` is a veto from three experts and the chair.

One boundary subtlety, reconciled: fact extraction and resolution ban the wall clock outright, but *policy* evaluation (snooze expiry, 21-day proposal aging) is inherently time-aware. Rule: policy state is reported in separate sections from drift facts, and in CI it is evaluated against the HEAD commit timestamp, not wall clock — so `check --ci` output is a pure function of the SHA and the committed journal, reproducible on re-run.

## 6. Monorepo and scale design

Shard = workspace member (fallback: top-level directory). Cache key = `(provider@ver, shard, merkle(blob_shas of glob-matched files))` using git-index blob hashes — change detection at `git status` speed. Invalidation matrix (provider globs × shards) precomputed; a one-file edit in a 200-package workspace re-extracts exactly (matching providers × one shard). Half-edge linking keeps cross-package edges from cascading invalidation. Per-package docs live in `<pkg>/docs/` (move with the package, CODEOWNERS-routable); root `docs/` holds cross-cutting artifacts only. Scoping: `--filter`, and `--affected` (merge-base diff → owning packages → dependents closure) as the CI default.

Budgets (go/no-go gates, 1M-LOC / 200-package fixture): warm `check` after a 1-file change p50 ≤5s / p95 ≤15s; cold `init` ≤10 min on 8 cores; anchor verification over 500 docs ≤2s; peak memory ≤2GB. No daemon/watcher in v0.1 — revisit only if the p95 gate fails on real repos.

## 7. Unified graph: the justification asked for in §3.1

The brief asked: one unified graph or separate artifacts? The panel's unanimous answer is **layered, and the layering is load-bearing**, not a compromise: per-capability fact files are the provider contract (independently testable, contributable, cacheable, failure-isolated — one provider bug cannot corrupt other capabilities) while `check`/`coverage`/recipes need cross-capability joins, which is precisely a derived index's job. A unified-graph-only design imposes write contention, all-or-nothing invalidation, and a god-schema every contributor must understand; per-capability-only pushes join logic into every consumer. SQLite is disqualified as the *canonical* format (not byte-stable across library versions; single-writer lock vs parallel shard extraction) and ideal as the disposable index.

## 8. Topology honesty (the platform correction to §3.1)

`services-topology` is a function of (values, overlay, profile, env), not a fact. Resolution context is declared in `docsmith.toml` and recorded in provenance; providers emit per-variant facts plus schema'd `unknowns[]` (`id, reason, resolution_hint`); docs render the common core and tabulate variants; unresolved edges render dashed/labeled, never guessed, and unknowns count in coverage denominators. Three node types are never conflated: **package** (workspace member), **service** (independently deployable unit: compose service with `build:`, k8s workload), **external-dependency** (image-only pulls like `postgres:16` — drawn distinctly, never counted in coverage). v0.1 ships compose static parsing only; helm/kustomize wait for the variant machinery (v0.3).

## 9. Cross-repo / portfolio seam (deferred, designed)

Manifest-level stitching is the right seam — the join keys (URL prefixes, topic names, DB identifiers, env-var names) are exactly what the capabilities already extract; cross-language analysis is a tar pit. Nothing is invented: a thin envelope embeds OpenAPI 3.2 / AsyncAPI 3.x fragments, plus a `docsmith export --backstage` projection to `catalog-info.yaml` (Component/API/Resource, `providesApis`/`consumesApis`/`dependsOn`, gaps via `metadata.annotations`) so portal users get it free. Timing v0.3, gated on ≥3 distinct real multi-repo users requesting it; the only v0.1 obligation is versioned fact schemas, needed anyway (D6). Full reasoning: ADR-011.

## 10. Interview / elicitation flow (designed now; ships v0.2)

Brownfield rationale is elicited, never asserted (brief §3.6). `mine` runs outside agent context, scoring candidates from git-log/PR titles by evidence strength × doc value (hotspot × fan-in × recipe demand); mined material lives in gitignored `.docsmith/cache/mined/`. State that must survive sessions is committed: `.docsmith/interview/queue.yaml` (open question cards — teammates can answer) and `answers.jsonl` (append-only: qid, verdict ∈ confirm/correct/reject/unknown, text, author, date; answers become human-attested facts; rejected candidates are tombstoned via the journal and never re-asked). In-session: `interview --next` emits ≤5 cards totaling ≤1,500 tokens — each a candidate claim phrased as a question ("Retry cap = 3 — related to the 2024 incident in PR #212?") with at most two capped, redaction-scanned evidence quotes and the four verdict options; the skill uses the agent's native structured-question UI, records via `docsmith answer`, then fetches the next batch. A full interview turn stays <4k tokens; progress ("14/38") resumes across sessions purely from the committed files. Unconfirmed candidates may appear only in an off-by-default, labeled "Unconfirmed leads" appendix — never inline as rationale.

## 11. Explicit wrap-don't-rebuild inventory

Wrapped: **tree-sitter** (parsing + query runtime, pinned, with a conformance predicate list), **SCIP symbol grammar** (the ID scheme, not the indexer toolchain), **tbls** (live DB catalog introspection, single Go binary via npm optionalDependencies), **git** (blob hashes, rename detection, history), **gitleaks ruleset** (redaction patterns), **Mermaid** (rendering; stable syntaxes only), **RFC 8785 JCS** (canonical JSON), **Agent Skills standard** (distribution), **Backstage catalog format + OpenAPI/AsyncAPI** (portfolio projection). Explicitly not wrapped: SchemaCrawler (JVM prerequisite), Atlas binary (non-OSS license; its community edition lacks the needed features), SCIP indexers (per-language build toolchains kill one-command install), stack-graphs (archived).
