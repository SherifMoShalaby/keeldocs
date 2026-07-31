# 10 — Implementation audit vs. the originating brief

Audited 2026-07-31 at `4c6db18` (v0.1.0-rc.1), against the original design
prompt ("Agent-Native, Stack-Agnostic Living Documentation Tool"). This is the
honest ledger: what the brief asked for, what shipped, what was deliberately
changed with the panel's reasoning, and what is still owed. Receipts are commit
shas, design docs in this folder, fixture names, and E-series results.

Verdict in one line: **the process contract and the deterministic core were
delivered in full and validated on real repos; breadth (languages, recipes,
noise instruments, portfolio) is roadmap-scoped exactly as the panel pruned it,
and three structural promises are not yet true in code — the `.scm` declarative
tier, cross-capability fact reads, and multi-provider resolution.**

---

## 1. Process requirements (brief §0, §5, §6)

| Asked | Delivered | Receipt |
|---|---|---|
| Nine-expert panel, design only first | Yes — design docs 00–09 written before any implementation | `01-panel-transcript.md` |
| Top-3 concerns + veto conditions per expert | Yes | `01-panel-transcript.md` |
| Explicit disagreements, named and resolved | Yes — e.g. AI-engineer vs DX on the mechanical LLM boundary (mechanical won, recorded as a deliberate trade); Compilers' ~70% declarative recall estimate disqualified Express from the pattern tier; auth-model cut unanimously | `03-adrs.md` ADR-009, ADR-001 |
| ADRs (≥7 named topics) | 13 ADRs; every named topic covered: provider interface (002), resolution determinism (003/008), anchor format (spec + 008), symbol identity (007), distribution (010), LLM boundary (009). Portfolio manifest: assessed and **deferred to v0.3** rather than ADR'd as v0.1 — recorded in scope | `03-adrs.md`, `07-scope-roadmap.md` |
| Flag guesses; list falsifying experiments | Exceeded: E1–E4 were **run on real repos**, not just listed. E1 endpoint recall 100/100 (two-tier thesis confirmed); E2 anchor survival ≥98.5% over 12 months of hono+zod history, false drift 3.8% → fixed by the overload amendment; E3 was underpowered and **amended ADR-007** (relaxed S2, added S1b) — an experiment changing a decision is the process working; E4 lie-detector precision 100% after suppression tuning (raw ~6% — suppression IS the product) | `08-risks-experiments.md`, `experiments/` |
| All 11 deliverables | All present: transcript, architecture, ADR set, provider contract with worked examples, recipe schema with ERD worked end-to-end, anchor spec, v0.1 scope with the wow resolved, phased roadmap with gates, risk register, experiments, open questions | `00-INDEX.md` |
| Challenge the framing, don't preserve it | Done in several load-bearing places — see §4 below | — |

## 2. The nine non-negotiable constraints (brief §2)

1. **Stack-agnostic.** Architecture: yes — the core privileges no framework;
   everything stack-shaped lives in providers behind capabilities. Shipping
   reality: TS/JS end-to-end plus the language-agnostic providers (git-log,
   workspace, compose, SQL policies). Python is the v0.2 headline; Java/Go
   v0.3. *Honored in structure, roadmap-scoped in coverage.*
2. **Agent-native distribution.** Skills (open Agent Skills standard) +
   adapters for Claude Code/Codex/Cursor + AGENTS.md fallback + plugin
   manifests; ADR-010 chose CLI-spine + skills, **no MCP through v0.2**, with
   per-agent churn isolated to `adapters/`. One-command install exists as
   packaging (`npm pack` consumed in CI) but **npm publish is pending**
   (owner-side), and the per-agent smoke matrix (E7) has not run. *Partial.*
3. **Deterministic-first.** Fully honored, and mechanically rather than by
   prompt: the engine contains zero model-calling code; prose enters only
   through `slot-write`'s seven gates; the tool, never the model, applies the
   ⚠ inferred label; `check` is a pure function of (SHA, committed journal) in
   `--ci`. The CI matrix double-runs every extractor and reproduces goldens
   byte-identically on three OSes. *Exceeded.*
4. **Git-native.** Markdown in-repo, anchors survive without the tool,
   journal is committed and append-only (merge=union), no SaaS. *Full.*
5. **Local-first inference.** Resolved by architecture: the host agent IS the
   model, so no key ever passes through the tool; headless BYO-key/Ollama
   prose is deliberately v0.3. *Full, by boundary rather than by feature.*
6. **Never fabricate rationale.** Enforced, not requested: ADR prose is
   human-authored by definition; unresolved citations and numbers-in-prose are
   rejected by named gates; recipes without facts answer NOT_AVAILABLE;
   inferred drafts carry tool-applied labels; the lie-detector attacks
   existing fabrication with receipts. *Full.*
7. **Respects human edits.** Existing files are never overwritten (EXISTS);
   hand-edits to gen regions are `tampered` with a restore *proposal*;
   rejecting a proposal holds it (rejection memory) and the human edit stands;
   human regions are never touched. *Full.*
8. **Brownfield and greenfield.** Brownfield is the core loop and shipped
   (extract → prioritize by hotspot×fan-in with receipts in the plan →
   elicit-lite via `new adr`). Greenfield BRD→PRD leadership was **cut
   permanently** by the panel (spec-driven tools own it; we anchor back).
   The full interview/elicitation flow is deferred (cap-5 design, v0.2+).
   *Brownfield full; greenfield deliberately narrowed.*
9. **Low noise.** The structural half is live and fixture-proven: drift only
   on fact-hash change, surgical binds (a policy edit stales exactly
   `db.policies`, never the ERD), rejection memory, snooze/tombstone, held
   states, provider-swap immunity (provenance outside the hash). The
   *instrument* half — weekly rollup PR, accept-rate self-throttling,
   post-edit nudge — is v0.2. *Partial by roadmap.*

## 3. Architecture sections (brief §3)

- **3.1 Capabilities/providers** — implemented as specified: orthogonal
  capabilities, manifest-first detection, competing providers, two tiers.
  Live: http-endpoints (express code-tier, nestjs declarative), db-schema
  (prisma), db-policies (sql-policies), config-surface (env-readers),
  workspace-layout (auto), services-topology (compose), module-graph
  (ts-imports), decision-history (git-log). **Gaps, stated plainly:** the
  declarative tier's promised form (`.scm` tree-sitter query + capture-mapping
  YAML, regex-free contribution funnel) is **not yet real** — today's
  "declarative" providers are still Python scripts and `provider.yaml` is
  documentation while `src/registry.js` is the machine-read registry;
  cross-capability reads (`${facts:module-graph}` as declared inputs) are not
  implemented (the DAG exists only as registry order, used by ts-imports for
  package identity); resolution rules for multiple providers per capability
  are unexercised (v0.1 runs one per capability); sandboxing is
  subprocess+timeout, not the full ADR-002 contract.
- **3.2 Confidence ladder** — replaced (improved): enumerated lattice
  INTROSPECTED>PARSED>PATTERN>GENERIC>OBSERVED>INFERRED instead of three
  numeric tiers (ADR-003), carried in provenance. The panel answered the
  "feature or clutter" question: verified content renders **unbadged**; only
  inferred prose is labeled. Decided and justified as asked.
- **3.3 Anchors** — revised to identity-only anchors + hashed gen/slot
  regions; JCS canonical fact hashing with versioned `h1:` algorithm
  (ADR-008); quarantine for malformed markers; stale/dead/tampered/
  intentionally-removed/unresolvable are disjoint and all implemented,
  including journal tombstones. The lockfile question was answered: none —
  the gitignored fact cache + spilled reports serve whole-repo queries.
  Re-anchoring: S0 exact and S1b same-name move-matching (amendment 2) are
  live, **proposal-grade only**; relaxed-S2 signature similarity, S3 body
  shingles, git-rename S1 path rewriting, and the two-signal auto-rebind rule
  are specified but not in the engine. The <0.5% false-auto-rebind go/no-go
  is honored trivially: v0.1 never auto-rebinds.
- **3.4 Recipes** — pruned from the 12-type wishlist to five shipped (erd,
  endpoint-inventory, config-reference, system-map, adr) exactly as the panel
  recommended; module-guide/onboarding v0.2, data-flow v0.3, C4-component,
  runbook, BRD, PRD cut. Deterministic Mermaid (ERD, service flowchart) is
  the credibility anchor as briefed. **Gap:** recipes are engine renderers
  with `recipe.yaml` metadata; the fully pluggable recipe runtime
  (template/extract/verify per directory) is v0.2.
- **3.5 Portfolio** — assessed as asked; answer: not v0.1, owner-confirmed
  v0.3. No manifest schema shipped yet.
- **3.6 Flows** — brownfield shipped (see §2.8); partial progress persists in
  the journal and spilled reports; interview design (cap 5 questions) exists
  on paper only.
- **3.7 Distribution/packaging** — the proposed tree exists almost line for
  line (bin/skills/providers/recipes/adapters/AGENTS.md/.claude-plugin), plus
  `action.yml`. Context economy is enforced by contract: ≤8KB envelopes,
  ≤300-char summaries, full output spilled to `.keeldocs/out/`.
- **3.8 Command surface** — the panel collapsed nine commands to four
  (`init`, `check` absorbing drift/verify/coverage, `sync`, `new`) plus two
  plumbing verbs (`slot-write`, `approve`); `map` internalized; `ask` deleted
  (host-agent competence). The single highest-value command question was
  answered with evidence: `init`'s lie-detector wow, validated at 100%
  finding precision (E4) and later hardened by dogfooding fixes (doc-relative
  links, prose script-claims, colon tokens).

## 4. Where the original framing was challenged (as instructed)

Numeric confidence tiers → enumerated lattice. Anchor frontmatter carrying
symbols/recipe/confidence/human-edited → slimmed to identity + binds, with
state living in hashes and the journal. Nine slash commands → four. BRD/PRD →
cut permanently. auth-model capability → cut until determinism is provable.
MCP → rejected for v0.1/v0.2 on context-cost grounds. Live DB introspection →
off the critical path (static `CREATE POLICY` parsing shipped instead, with
migration-replay semantics). Separate lockfile → rejected. "docsmith" name →
replaced after collision diligence (npm/PyPI/live-CLI conflicts) with
keeldocs.

## 5. Beyond the brief (unrequested but in its spirit)

Redaction barrier as a write-path invariant (ADR-013: rules + entropy scan
before content-hashing, so redacted docs are still born clean). Born-clean as
a tested invariant everywhere. Cross-OS determinism matrix that caught two
real bugs in its first hours (filesystem-order-dependent extractor emission;
a stale-report pick in the harness) — ADR-003's thesis earning its keep.
GitHub Action with SARIF + sticky PR comment, dogfooded per-push. Schema-
strict `keeldocs.toml`. A real-app beta (22-table production schema verified
against the live catalog; RLS matrix; zero DB writes). 20 commits, 15 CI
runs ending green at `4c6db18`.

## 6. Owed — ranked, with destinations

1. **Declarative tier as promised** (`.scm` + mapping YAML + registry loader
   reading `provider.yaml`): the contribution funnel depends on it — v0.2.
2. **Python end-to-end** (v0.2 headline) — constraint 1's breadth.
3. **Noise instruments**: rollup PR, accept-rate throttle, post-edit nudge —
   v0.2 (needs the Action's PR plumbing).
4. **Re-anchoring S1/S2/S3 + two-signal auto-rebind** under the <0.5% gate —
   v0.2, with the E3 corpus rerun at power.
5. **Cross-capability reads + provider sandbox/trust tiers** (ADR-002 in
   full) — v0.2.
6. **Live-Postgres via tbls (`--live`)** — v0.1.1 remainder, off critical
   path by design.
7. **Interview/elicitation flow** (cap 5, resumable) — v0.2/v0.3.
8. **Portfolio manifests** — v0.3.
9. **Validation debt**: full E-series corpus runs, E7 per-agent skill smoke
   matrix, E9 field trial on a real owner repo. *(Update 2026-07-31: E5
   corpus rerun and E6 FastAPI validation measured - see experiments/; the
   skill-budget lint runs in every CI pass. Cross-agent E7 behavior and the
   E9 field trial remain owner-side.)*
10. **Windows** from reduced-trust red to green (path separators are the
    likely culprit); **npm publish + placeholders + org transfer** — owner
    actions. *(Update 2026-07-31: root-caused exactly as predicted - URL
    .pathname engine roots and native-separator emission. Fixed at the
    contract level: everything keeldocs emits is posix-slash on every OS
    (src/paths.js), engine roots use fileURLToPath, harness writes pin LF,
    fixture repos pin autocrlf=false. npm publish/org transfer remain
    owner actions.)*
11. **Multi-provider resolution** exercised with a second db-schema provider
    (drizzle is the natural candidate). *(Update 2026-07-31: the ADR-003
    resolver is implemented and wired - enumerated lattice, versioned
    per-capability precedence table (v1, deliberately empty), lexicographic
    backstop; disagreements emit conflict records in reports and counts on
    the capabilities card, corroboration keeps one fact silently. Exercised
    in CI by the polyglot fixture (express + fastapi both claiming
    `GET /health`) plus unit coverage of every disagreement path. A second
    db-schema provider to produce REAL disagreements remains v0.3 - drizzle
    still the natural candidate.)*

## 7. Scoreboard

Process contract: 11/11 deliverables, exceeded on validation. Constraints:
5 full (3,4,5,6,7), 3 partial-by-roadmap (1,2,9), 1 narrowed-with-rationale
(8). Architecture: implemented with three named structural gaps (declarative
tier form, cross-capability reads, multi-provider resolution). The brief's
two-year test — "still correct when agent APIs have changed" — is the part
most robustly satisfied: everything agent-facing sits behind skills/adapters
and a stable CLI envelope, and the deterministic core has no agent surface
at all.
