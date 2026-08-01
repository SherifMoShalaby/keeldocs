# Design doc 11 — v0.3 Plan

Written 2026-07-31, the day the tree went three-OS green and `v0.1.0-rc.1`
was tagged at `927b4cb`. This plan does two jobs the roadmap (doc 07) cannot
do from 2026-07-29: it reconciles what v0.2 **actually shipped** against what
the v0.2 roadmap line promised, and it sequences v0.3 so the rolled-forward
debt is paid before new surface is opened. Same rules as every doc in this
set: numbers not vibes, gates not dates, honest accounting over momentum.

## 0. Where the tree actually stands

Shipped in the v0.2 batch (all landed on `main`, 3-OS CI green, receipts in
doc 10's per-item updates): the `.scm` declarative tier through the shared
tsq runtime; Python end-to-end (FastAPI mount-graph resolver, E6-measured
23/23 on real code; py-imports with `__all__`/`@overload` amendment); noise
instruments (`check --since` / `sync --self` with fact-level self-caused
classification, applied-journal, quiet throttle, one-PR-max rollup);
re-anchoring S1/S2/S1b with the two-signal AUTO gate (E5-measured: survival
99.92–99.97%, 0 false auto-rebinds on 30 real orphans); cross-capability
reads (`${facts:cap}`, env-delivered, implied needs edges); live-Postgres
via tbls behind `--live` with declared-beats-live; ADR-003 multi-provider
resolution (lattice + versioned precedence + conflicts-as-facts, exercised
by the polyglot corroboration fixture); the interview/elicitation
deterministic slice (cap-5 cards, committed resumable state,
journal-verified never-re-ask); Windows from reduced-trust red to green
(posix-emit contract, `fileURLToPath` roots, LF-pinned harness).

**Not shipped, though the v0.2 roadmap line promised it** — this is the debt
this plan exists to name:

| Promised for v0.2 | Status | Why it slipped |
|---|---|---|
| Migration-replay engine | not built | the pglite spike (open question #4) was never run; tbls-live shipped instead as the off-critical-path live wedge |
| T2 trust machinery (signing, pinning, `provider trust`, E10 red-team) | not built | no third-party provider existed yet to secure; subprocess+timeout is the only sandbox |
| module-guide + onboarding-verify recipes | not built | prioritized below the audit's owed list |
| interview ≥50% completion, drift FP <5%, contribution economics, adoption gates | unmeasurable here | need field users — riding on owner-side publishing + E7/E9 |

The audit's own owed list (doc 10 §6) is fully executed — items 1–7 and
9–11 landed or measured, item 8 (portfolio) deferred by owner decision. The
unshipped rows above were roadmap-line promises *outside* that list. Both
accountings are true; only together are they honest.

## 1. Rolled-forward debt (build first — R-track)

**R1. Migration-replay engine.** The biggest unkept v0.2 promise and the
highest-leverage one: it unlocks flyway/alembic/liquibase in one move, and
it is what makes the `INTROSPECTED` tier honest — ADR-003 reserves that tier
for *repo-derived* database instances, which a replayed chain is and a live
DSN is not. Landing it resolves the deviation flagged in the ADR-003
amendment: `tbls-live` reclassifies from `INTROSPECTED` to `OBSERVED`, live
reads leave canonical resolution entirely, and declared-vs-live disagreement
becomes the published disagreement fact ADR-005 designed. Start with the
OQ#4 spike: replay 3 real flyway/alembic chains on pglite; if WASM Postgres
diverges from real DDL semantics, fall back to Docker replay. Gate
(unchanged from doc 07): ≥10 fixture chains byte-identical
post-normalization to a real live migration run.

**R2. T2 trust machinery.** Signed provider install, content-hash pinning,
`provider trust`, provable refusal of unsigned/mismatched installs; E10
injection red-team against anchors/fact-files/mined text as attack surface.
Gates unchanged. Sequencing note: T2 gates the *third-party* funnel, not
first-party work — R1/N1 do not wait for it, but no community code provider
is installable before it lands. This is the Security veto ("auto-fetch/
execute of third-party providers") finally discharged rather than deferred.

**R3. The two v0.2 recipes.** Module guide (deterministic skeleton + one
labeled prose slot) and onboarding-verify (the machine *verifies* human
tutorials — commands exist, versions match — and never authors sequencing).
Both consume machinery that now exists (slots, lie-detector receipts,
symbol facts); neither needs new extraction.

**R4. Interview v2: `mine`.** The deferred half of design §10: candidate
rationale cards from commit subjects and PR titles, scored evidence-strength
× doc-value, run *outside* agent context into the gitignored mined cache,
evidence quotes capped and redaction-scanned. Plus completion
instrumentation so the ≥50% card-batch completion gate (OQ#7) is measured in
the beta rather than asserted. PR-title mining is the first network-touching
feature in the tool: it ships opt-in, read-only, and inside R2's injection
posture (mined text is attacker-influenceable by definition — E10 covers it).

## 2. New v0.3 surface (N-track, each behind its gate)

**N1. Drizzle as the second static db-schema provider.** Small, and it
completes what audit item 11 deliberately left honest: the resolver's
disagreement path is unit-tested but has never met a real pair. Drizzle vs
prisma produces the first genuine same-id conflicts, which is the evidence
gate for the first non-empty `PRECEDENCE` entry (bump to
`PRECEDENCE_VERSION 2`) and for `keeldocs.toml` conflict pinning — both
deferred precisely because pinning without a conflict-producing pair is
untestable surface. Drizzle snapshot-format details are a flagged assumption
in doc 09; verify against real drizzle-kit output before freezing the
fixture.

**N2. Java and Go, at the Python bar.** Fixture matrix green + drift FP
<10% on 2 real repos, per language, before GA. Method follows the E1/E6
lesson, not framework enthusiasm: run an E1-style recall probe per framework
*first*, then choose tier — spring-web annotations look `.scm`-shaped (the
nestjs pattern); gin/echo route registration is dynamic and will likely need
a mount-graph resolver (the express lesson). Symbol identity: `ds` grammar
already carries both languages; py-imports is the porting template.

**N3. Variant topology (helm/kustomize).** Renders with *declared* values
only; every unresolved value is schema'd as unknown, never guessed — the
Platform veto on silently-chosen variants stands. Compose stays the v0.1
static parse.

**N4. async-messaging + data-flow recipe.** Gated on an E1-style labeled
corpus at ≥90% recall / ≥98% precision on declared topics before the recipe
unlocks. Kafka/SQS/rabbit declarations first; no broker introspection.

**N5. MySQL/Mongo live.** Per-dialect least-privilege recipes reviewed
(Security), and the Mongo sampler ships only if the OBSERVED-tier pilot on
3 real repos shows drift-chatter FP <10% — sampled shape presented as
anything but OBSERVED remains fabrication (Data veto).

**N6. Headless prose (BYO key / Ollama).** Only if slot-write rejection
rate <20% with a 7B local model on the fixture corpus; otherwise the
feature stays agent-only. The mechanical LLM boundary does not move.

**N7. Portfolio (`export --backstage`).** The PM gate is unchanged and
hard: work starts only after ≥3 distinct real multi-repo users request it.
Until the gate trips, the only obligation remains versioned fact schemas
(already true since v0.1).

**N8. MCP decision point.** Unchanged: build the shim only for a named
shell-less surface with ≥25 requesting users, and generate it from the CLI
command table, never by hand.

## 2b. Landed status (2026-07-31, same-day execution)

Phase A and Phase B were executed the day this plan was written, each as a
green 3-OS CI milestone: **R1** `sql-replay` on pglite (E13: 10/10 chains
byte-identical to PostgreSQL 16; tbls-live reclassified OBSERVED - the
ADR-003 deviation is closed); **R2** T2 refusal-first install machinery +
the first permanent E10 red-team gate (unsigned/untrusted/tampered provably
refused; marker-forgery dropped at the fact boundary); **N1** drizzle
(snapshot format verified against real drizzle-kit; the first real conflict
pair, plus `[resolve]` pins); **N2** Java + Go probe-first (E14: spring
17/17 declarative via the new member-association mode; gin 15/15 code-tier
group-chain resolver; workspace + env parity; module-graph/ds symbols for
both languages named as follow-up); **R3** module-guide recipe (born-clean
skeleton + one slot; per-package region binds turned out to need a SPEC
decision, not a patch - endpoint identity carries no package and bind
values cap at 200 chars, so package-scoped sections wait on
package-scoped fact identity) and onboarding-verify lie classes (make
targets, version floors); **R4** `mine` (local commit subjects only, HEAD-anchored
window, gitignored cache) feeding `rationale` interview cards. Still open
from the ADR-002 amendment: the OS-level sandbox, permission-manifest
display, output caps. Phase C remains gated as designed; the hygiene bumps
(action majors, CodeQL v4) are deliberately unbundled from this batch so a
version guess could not redden a green tree.

## 2c. Phase C status (2026-08-01, gate-by-gate)

**N3 variant topology — SHIPPED.** helm (declared-values render; undeclared
values become explicit `<unknown:…>` tokens plus named gaps; template
control flow is itself a gap) and kustomize (bases parsed, overlays named
rather than rendered). The Platform veto holds mechanically.

**N4 async-messaging + data-flow — SHIPPED, gate met.** E15: 10/10 declared
channels across five transports, 100% recall/precision on the committed
labeled corpus, the computed topic held as a gap; the ground truth is
asserted every CI run. The data-flow recipe unlocked with it.

**N5 MySQL/Mongo live — still gated, correctly.** MySQL live needs the
per-dialect least-privilege recipe reviewed (Security) and a real MySQL to
verify against; Mongo ships only after the 3-real-repo OBSERVED pilot shows
FP <10%. Neither gate can be met from a fixture.

**N6 headless prose — still gated.** The gate is a *measurement* against a
7B local model on the fixture corpus (rejection rate <20%); no model, no
number, and shipping the feature without the number would invert the rule
that made every other decision here defensible.

**N7 portfolio / N8 MCP — untouched by design.** Both are demand gates
(≥3 real multi-repo users; ≥25 named shell-less users). Building either
before the gate trips would be the exact scope indiscipline the panel's PM
lens exists to prevent.

**Sandbox (ADR-002 residue) — one item left.** Network deny-all, read-only
repo, and the 5MB cap all ship and are CI-proven; per-glob READ scoping
(bubblewrap-class minimal root) and permission-manifest display remain.

**Coverage denominator — RESOLVED (owner decision 2026-08-01): widened.**
Client routes and messaging channels now count, and a screens inventory
recipe shipped with the change so routes are documentable rather than
merely counted. Existing repos re-baseline once on upgrade (a React app's
denominator grows by its route count); the ratchet compares against the
base branch and `provider_set_hash` already invalidates cross-version
comparisons, so this is a re-baseline, not drift. Symbols stay excluded.

## 3. Sequencing

Phase A — *pay the debt that undermines the thesis*: R1 (replay; long pole,
start with the pglite spike), R2 (T2; parallel, mostly security
engineering), N1 (drizzle; small, makes resolution real). These three are
parallel-friendly and none blocks the others.

Phase B — *breadth on proven machinery*: N2 (Java/Go, probe-first), R3
(recipes), R4 (`mine` — after R2's injection posture exists, because mined
text is hostile input by definition).

Phase C — *gated extras, in whatever order their gates trip*: N3–N8. None
of these starts on momentum; each starts on its stated evidence.

The kill list (doc 07 §5) is unchanged and nothing above touches it.

## 4. Experiments

E10 injection red-team (gates R2/R4). E11 ERD readability ceiling (~25
entities; the drizzle/replay fixture growth supplies the corpus). E12
survey full-text read (before any public use of the ~46% figure). E13
replay-vs-live equivalence corpus (the R1 gate measurement: ≥10 chains,
byte-identical post-normalization). Standing owner-side debt from v0.2:
E7 cross-agent skill smoke matrix and the E9 field trial — nearly every
FP/adoption number in this plan is measured by them, and they need
published packages and real repos, not this environment.

## 5. Release mechanics and hygiene

`v0.1.0-rc.1` is tagged at `927b4cb` (package and engine versions match the
tag; release.yml runs the full suite at the tag and publishes with
provenance — it needs `NPM_TOKEN` or npm Trusted Publishing configured,
which is owner-side). Promote to `v0.1.0` by tagging the same tree after
the rc soaks and the OQ#8 name re-checks pass at publish time. Cut `0.2.0`
from current `main` (engine is at `0.2.0-dev.0`) once E7 smoke passes on ≥2
agents; bump `main` to `0.3.0-dev.0` immediately after. Hygiene carried
forward: Windows is green but non-blocking per the reduced-trust owner
decision — recommend promoting it to a blocking lane after four consecutive
green weeks (a one-line ci.yml change, noted there); bump the deprecated
node20 action majors when their node24 releases land; CodeQL v3→v4 before
its December 2026 deprecation.

## 6. Owner decision points opened by this plan

Whether Windows promotes to blocking (and when); whether `0.2.0` cuts
before or after the first external-provider PR lands (contribution
economics measurement wants a published package); whether the interview
beta cohort is recruited before `mine` ships (completion data on the
deterministic slice alone is cheaper and earlier); and the standing three —
npm/PyPI publish credentials, org transfer, E7/E9 execution.
