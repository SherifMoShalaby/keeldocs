# keeldocs — Roadmap and Status Board

**As of 2026-08-01.** `main` at `97c53ac` · 57 commits · engine `0.2.0-dev.0` ·
tagged `v0.1.0-rc.1` at `927b4cb` · 3-OS CI green (Windows non-blocking).

This is the single tracking document. It reconciles three things that had been
living in separate places: the original design brief's deliverables, the phased
roadmap with its go/no-go gates (design doc 07), and what has actually been
built. Every line carries a status and, where the status is "done", the evidence
that makes it checkable.

**How to read the status column.** **Done** means shipped on `main` with a test
or measurement that would fail if it regressed. **Partial** means the mechanism
ships but something named is missing. **Blocked (you)** means the next action is
the owner's and cannot be done from a build environment. **Gated** means
deliberately not started because its evidence threshold has not been met —
these are not backlog items, they are refusals with conditions. **Open** means
buildable now and not yet built.

---

## 1. Where the project is, in one paragraph

The core loop the whole design stands on — extract facts deterministically →
anchor docs to those facts → detect drift by fact-hash → propose section-level
patches → apply without destroying human writing — is **built, tested and
proven on a real production repo**. Thirty-four providers across ten
capabilities feed eight document recipes. The engine has 102 unit tests, 39
byte-compared extractor goldens and roughly two dozen end-to-end integration
blocks that run on Linux, macOS and Windows every push. It has been run against
a real 30-table Supabase/Next.js application end to end: 438 concrete surfaces,
100% documented, `check` CLEAN, and 249 → 113 documentation lies found with
accurate receipts across four hardening rounds. What is *not* done splits
cleanly into three piles: a short list of owner actions that gate publication
and therefore gate every adoption metric; a set of features deliberately
refused until their evidence arrives; and no remaining engineering debt that a build environment can close.

---

## 2. The original brief, scored

The brief asked for eleven design deliverables and set nine non-negotiable
constraints. All eleven deliverables exist as design docs (`docs/design/00`
through `11`). The constraints are where the honest scoring lives.

| # | Constraint | Status | Evidence / gap |
|---|---|---|---|
| 1 | Stack-agnostic | **Partial by roadmap** | TS/JS, Python, Java, Go, C#, Ruby, Dart shipped; Postgres/Supabase/MySQL-static/SQLite. Mongo and MySQL *live* are gated, not missing by accident |
| 2 | Agent-native distribution | **Partial (blocked)** | 6 skills, plugin + marketplace manifests, CLI envelope contract all ship; cross-agent smoke (E7) needs a published package |
| 3 | Deterministic-first | **Done** | Zero model-calling code in the engine. Byte-identical output across 3 OSes × 2 runs, enforced every CI run |
| 4 | Git-native | **Done** | Markdown in-repo, anchors in HTML comments, no service dependency, no lock-in |
| 5 | Local-first inference | **Done** | The host agent is the model; headless BYO-key prose is gated on a measurement, not shipped half-done |
| 6 | Never fabricate rationale | **Done** | Structural: inferred content cannot enter a fact; `mine` produces *candidates* that a human confirms; the `⚠ inferred` tier is the only badged one |
| 7 | Respects human edits | **Done** | `sync` proposes; `restore` requires consent; recipe migration inserts without rewriting; prose lives in slots the engine never authors |
| 8 | Brownfield and greenfield | **Narrowed with rationale** | Brownfield is excellent and proven. Greenfield (docs-lead-code) was deliberately narrowed — it competes with Spec Kit rather than complementing it |
| 9 | Low noise | **Done, unmeasured in the wild** | Noise SLO ships as tested spec (rollup, throttle, snooze/rejection memory, self-caused nudge). The <5% field FP number needs users |

---

## 3. Phase board

### v0.1 — the loop, proven on one ecosystem

Everything in the v0.1 scope table shipped. It is tagged `v0.1.0-rc.1` and has
not been promoted to `v0.1.0` only because publication is blocked.

| Item | Status |
|---|---|
| `init` / `check` / `sync` / `new` command surface | **Done** |
| Anchors, regions, slots; fact-hash drift; six disjoint drift states | **Done** |
| Doc lie-detector with receipts | **Done** — 8 finding classes, four rounds of field-measured precision rules |
| Recipes: system-map, erd, endpoint-inventory, config-reference, `new adr` | **Done** |
| Providers: workspace-layout, module-graph, http-endpoints, db-schema, config-surface, services-topology, decision-history | **Done** |
| Live Postgres via tbls behind `--live` | **Done** (reclassified OBSERVED once replay landed) |
| Fixture harness (`test-provider`), noise SLO, redaction barrier, slot-write | **Done** |
| Coverage as ratchet, never a gate | **Done** |
| npm/PyPI publish + org transfer | **Blocked (you)** |

### v0.2 — Python GA, interview, replay, trust machinery

| Item | Status |
|---|---|
| Declarative `.scm` tier through a shared runtime | **Done** — the contribution funnel is real: one query + one manifest + one fixture, zero code |
| `provider.yaml` as the machine-read registry | **Done** |
| Python end-to-end (FastAPI mount graph, py-imports) | **Done** — E6: 23/23 on real code |
| Noise instruments (rollup, throttle, `--since`, `sync --self`) | **Done** |
| Re-anchoring S1/S2/S1b with the two-signal auto gate | **Done** — E5: 99.92–99.97% survival, 0 false auto-rebinds on 30 real orphans |
| Cross-capability reads (`${facts:cap}`) | **Done** |
| ADR-003 multi-provider resolution + conflicts-as-facts | **Done** — exercised by a real drizzle-vs-prisma conflict pair |
| Migration-replay engine (pglite) | **Done** — E13: 10/10 chains byte-identical to real PostgreSQL 16 |
| T2 trust machinery + E10 red-team | **Done** — unsigned / untrusted-signer / tampered all provably refused, permanent CI gate |
| module-guide + onboarding-verify recipes | **Done** |
| Interview (`interview` / `answer`) + `mine` | **Done** |
| Windows red → green | **Done** — posix-emit contract, `fileURLToPath` roots, LF-pinned harness |
| Cut `0.2.0` release | **Blocked (you)** — waits on E7, which waits on publication |

### v0.3 — breadth, each behind its own gate

| Item | Status | Note |
|---|---|---|
| N1 drizzle (second static db-schema provider) | **Done** | produced the first real same-id conflicts |
| N2 Java + Go | **Done** | E14: spring 17/17 declarative, gin 15/15 code-tier; `ds` symbols for both |
| N3 helm / kustomize variant topology | **Done** | undeclared values render as explicit `<unknown:…>`, never guessed |
| N4 async-messaging + data-flow recipe | **Done** | E15: 10/10 channels across five transports, 100% recall/precision on the labeled corpus |
| client-routes capability + screens recipe | **Done** | react-router, next-routes, angular-router, vue-router |
| PostgREST derived surface + database routines | **Done** | E9 round 4: route claims 5 → 0 on the field repo |
| PostgREST views + PUT (catalog-verified) | **Done** | writability and keys read from the catalog, never assumed; field repo 438 → 482 surfaces |
| Recipe migration (`sync --upgrade`) | **Done** | validated retroactively: byte-identical to a delete-and-regenerate, without the delete |
| Per-glob read scoping | **Done** | `inputs` is now an enforced contract; undeclared files do not exist inside a provider's namespace |
| Package-scoped fact identity (`pkg:<name>#<cap>/*` binds) | **Done** | monorepo guides are disjoint; editing one package leaves the others byte-identical |
| Sandbox minimal root | **Done** | the host outside the repository is masked; probed per host, degrades with a named reason; ~0.5s/run |
| Permission-manifest display at `provider trust` | **Done** | `provider show`; `add` stops at `CONSENT_REQUIRED` and states the enforcement this host really applies |
| N5 MySQL / Mongo live | **Gated** | needs a real MySQL + a 3-repo OBSERVED pilot at FP <10% |
| N6 Headless prose (BYO key / Ollama) | **Gated** | needs slot-write rejection <20% with a 7B local model |
| N7 Portfolio (`export --backstage`) | **Gated** | needs ≥3 distinct real multi-repo users asking |
| N8 MCP shim | **Gated** | needs a named shell-less surface with ≥25 requesting users |

### v1.0 — the gates that are not about features

None of these can be met from a build environment. They are the honest reason
v1.0 is not close, regardless of how much engine exists.

| Gate | Status |
|---|---|
| Anchor spec frozen at 1.0, published standalone with a migration policy | **Open** — spec is stable in practice, not yet frozen |
| ≥500 public repos with committed anchors | **Blocked (you)** — needs publication |
| ≥2 non-founder maintainers with merge rights | **Blocked (you)** — hard gate, no v1.0 at bus factor 1 |
| Survived one breaking agent-API change, adapters-only fix ≤1 week | **Not yet exercised** |
| Noise SLO holding in the wild (accept-rate ≥30% sustained) | **Blocked (evidence)** |

---

## 4. Blocked on you — the critical path

These four items gate more than they look like they do. The first one gates a
chain of three.

1. **npm Trusted Publishing, then re-run the release job.** `release.yml` is
   written and runs the full suite at the tag; it needs credentials configured
   in repo settings. Until the package publishes, E7 (cross-agent skill smoke)
   cannot run; until E7 passes on two agents, `0.2.0` should not cut; until
   there is a published package, every adoption and contribution-economics
   number stays unmeasurable.
2. **Merge the three open Tareeqna PRs** — `keeldocs/ci-drift-gate` (report-only
   CI gate), `keeldocs/tsd-search-rides-fix` (the RPC correction plus the
   overload note), `keeldocs/postgrest-surface` (regenerated REST + routine
   docs).
3. **Recruit an interview beta cohort** — the ≥50% card-completion gate has no
   data.
4. **Windows promotion to a blocking lane** — a scheduled task fires 2026-08-29
   to check the four-week green streak and remind you it is a one-line deletion
   in `ci.yml`.

---

## 5. Gated, not backlogged

The difference matters. Each of these has a written evidence threshold, and
starting one before its threshold trips would be exactly the scope indiscipline
the design's PM lens exists to prevent. Listing them here is not a to-do list —
it is a record of decisions already made.

MySQL/Mongo live · headless prose · portfolio export · MCP shim · C4-component
recipe (cut: component boundaries are human abstractions) · runbook generation
(cut: remediation knowledge is not in code) · BRD/PRD generation (**cut
permanently** — intent precedes code).

The standing kill list is unchanged and refuses even on request: hosted
dashboard, docs-site generation, auto-merge of generated content, general code
Q&A, code-review bot, translation, a VS Code extension, per-framework
mega-providers, required telemetry, live-DB write access, row-value sampling
into committed artifacts.

---

## 6. Open engineering debt — buildable now

**None.** Every item that was buildable from a build environment is built. What
remains is the two piles above: owner actions that gate publication, and
features deliberately refused until their evidence arrives.

Two sandbox residuals are recorded rather than open, because closing them buys
nothing at the current threat model: `/proc`, `/sys` and `/dev` stay the host's
(they leak machine shape, not user data, and removing them breaks interpreters),
and the minimal root is a masked root rather than a pivoted one. Both are named
in ADR-002's fourth FS amendment.

---

## 7. Experiment ledger

The design named twelve validation experiments; the build added three more. The
principle was that each falsifies a load-bearing assumption, run before or
alongside the build rather than after.

| Experiment | What it falsifies | Status |
|---|---|---|
| E1 extraction recall/precision | the two-tier provider thesis | **Passed** — NestJS 100/100, Express code-tier 100/100, naive declarative control collapsed to 78% exactly as predicted |
| E2 fact-hash stability over 12 months | "fact-hash drift is low-noise" | **Passed** — anchor survival 99.5% / 98.5%, false drift 3.8% |
| E3 re-anchoring accuracy | "evidence-gated rebinding is safe" | **Passed at power in E5**; the original run was underpowered and changed the design (name, not signature, is the strong re-anchor key) |
| E4 lie-detector wow | "deterministic verification wows on first run" | **Directional pass** — full user test needs users |
| E5 determinism goldens | "byte-identical output across OSes" | **Passed, permanent** — runs every CI push |
| E6 redaction adversarial corpus | "the write barrier catches realistic leaks" | **Passed** |
| E7 agent adapter smoke matrix | the distribution bet | **Blocked (you)** — needs a published package |
| E8 scale benchmark (1M LOC) | "warm check ≤5s p50" | **Not run** |
| E9 noise SLO field trial | the adoption bet | **Four rounds run** on a real production repo; the 4-week accept-rate number still needs a cohort |
| E10 injection red-team | "artifact-borne injection cannot reach an action" | **Passed, permanent CI gate** |
| E11 ERD scale rendering | "the flagship diagram survives 500 tables" | **Not run** |
| E12 study full-text verification | the ~46% positioning claim | **Not run** — must happen before that number appears in any public material |
| E13 replay vs live equivalence | "WASM Postgres matches real DDL semantics" | **Passed** — 10/10 byte-identical to PostgreSQL 16 |
| E14 JVM/Go probes | tier choice per framework | **Passed** — spring 17/17, gin 15/15 |
| E15 async-messaging corpus | "declared channels are extractable" | **Passed** — 10/10, 100% recall and precision |

---

## 8. Inventory, for orientation

34 shipped providers across 10 capabilities (workspace-layout, module-graph,
http-endpoints, db-schema, db-policies, config-surface, services-topology,
decision-history, client-routes, async-messaging) · 8 document recipes · 6
agent skills · 102 unit tests · 39 byte-compared extractor goldens · ~24
end-to-end integration blocks · 13 ADRs · 15 experiments.

Field deployment: one real production application (Next.js App Router +
Supabase, 19-file migration chain, 30 tables) running the full loop, with three
documentation pull requests open.

---

## 9. Keeping this current

This file is the tracking artifact; design doc 11 holds the reasoning behind
each phase decision and design doc 10 holds the implementation audit. When an
item moves, move it here first and name the evidence — a status without
evidence is the thing this whole project exists to argue against.
