# keeldocs — Roadmap and Status Board

**As of 2026-08-02.** `main` at `fcd2c3b` · 74 commits · engine `0.2.0-dev.0` ·
tagged `v0.1.0-rc.1` at `927b4cb` · 3-OS CI green (Windows non-blocking) ·
146 unit tests · 39 extractor goldens · 80 harness checks.

**E8 and E11 ran on 2026-08-01 and everything they found is now fixed except
the 1M p50.** E11's flagship ERD stopped rendering between 100 and 250 tables →
budget-driven chunking. E8 found no incremental cache at all → **D1** (100k warm
9.66s → 2.23s); then 1M LOC dying on a constant output cap → **D2** (1M now
completes); then one changed file re-parsing a provider's whole input set →
**D4** for `ts-imports` and **D6** for `express` (11,288ms → **737ms** at 1M).

**Every provider on the edit path is now incremental** (D9 finished the set),
and D8 + D11 cut what the largest of them moves by **64%** — `ts-imports`
output 46.86 MB → 17.03 MB, measured in **bytes** rather than seconds, which is
the only currency this container can still count honestly.
The budgets have never been touched — but the p50 result must be stated
carefully, and the reason is itself a finding: **this container's speed drift
between sessions (2.3x, measured on `check --no-cache` where every D-series
change is inert) now exceeds every effect being measured.** The same code
measured 3.65s for a 100k one-file-edit check in one session and 7.74s in the
next. So the honest position is that D1/D2/D4/D6/D9 each have a verified
same-session A/B effect, and that **the 100k p50 budget is not established** on
hardware this noisy. R10's other half — two real monorepos, off this container —
has gone from nice-to-have to the only way that budget can be honestly called
met.

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
capabilities feed eight document recipes. The engine has 149 unit tests, 39
byte-compared extractor goldens and roughly two dozen end-to-end integration
blocks that run on Linux, macOS and Windows every push. It has been run against
a real 30-table Supabase/Next.js application end to end: 482 concrete surfaces,
100% documented, `check` CLEAN, and 249 → 113 documentation lies found with
accurate receipts across four hardening rounds. What is *not* done splits
cleanly into three piles: a short list of owner actions that gate publication
and therefore gate every adoption metric; a set of features deliberately
refused until their evidence arrives; and — new as of 2026-08-01, from running
E8 — one measured scale item, because a loop that is correct and fast on an
unchanged tree still re-parses far too much when a single file changes.

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

None of these can be met from a build environment. **They are now the only
reason v1.0 is not close**: the engine side of v0.3 is complete, and every
remaining v1.0 gate is about people, publication or elapsed time.

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
2. **Merge the four open Tareeqna branches**, in this order because the last
   two stack: `keeldocs/ci-drift-gate` (report-only CI gate),
   `keeldocs/tsd-search-rides-fix` (the RPC correction plus the two-overload
   note), `keeldocs/postgrest-surface` (REST + routine docs), then
   `keeldocs/views-and-put` (views, PUT, PK markers — branched off the
   previous one).
3. **Recruit an interview beta cohort** — the ≥50% card-completion gate has no
   data.
4. **Windows promotion to a blocking lane** — a scheduled task fires 2026-08-29
   to check the four-week green streak and remind you it is a one-line deletion
   in `ci.yml`.

Two things worth deciding while you are in there, both cheap: whether to **cut
`0.2.0` on E7's evidence or on your own judgement** (the gate was yours, and the
tree has moved a long way past what `0.2.0` originally meant), and whether the
**`users_public` view being writable through PostgREST** is intended — keeldocs
surfaced it, but it is a schema decision, not a docs one.

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

Created by E8 on 2026-08-01, all with measured baselines rather than estimates.

| # | Item | Status | Measurement |
|---|---|---|---|
| D1 | **Incremental extraction** — cache the provider subprocess, keyed on the exact resolved input set by content hash | **Done** (`src/cache.js`, 20 unit tests, harness gate) | warm check 5.61s → **1.40s** @10k, 9.66s → **2.23s** @100k; overhead 33ms (3% of a warm run) |
| D2 | **Input-proportional output cap** — `clamp(6 × declared input bytes, 5MB, 256MB)` | **Done** (`src/facts.js`, 7 unit tests, harness gate) | **1M LOC completes**: rc 0, CLEAN, 38,047 surfaces, 914 MB, warm check **8.9s** (was exit 2). The roadmap's named remedy — sharding — was measured and rejected as *unsound*: ts-imports resolves imports against the walked file set, so a shard boundary silently turns 1,000 internal edges external. The provider's 46.9 MB is 2.02× its own declared input; the constant was the defect |
| D4 | **Per-file parse cache** — `incremental: per-file`, keyed by content digest, handed to the provider like a fact read | **Done for `ts-imports`** (`src/cache.js` + the provider, 7 unit tests, harness gate) | `ts-imports` at 1M: **28.0s → 13.7s** on an edit. A/B on the manifest key alone: 100k edit 6.49s → **5.51s**, 1M edit 48.96s → **39.34s**. Costs +300 MB RSS at 1M (914 → 1212 MB), the first change in this series that spends memory rather than saving it. *Correction: the earlier "12 providers re-run" figure was wrong — it counted providers whose globs match, not ones that run. Three do.* |
| D6 | **`express` adopts `incremental: per-file`** | **Done** (provider refactor + `incremental: per-file`, harness gate) | `express` at 1M: **11,288 ms → 737 ms** on an edit. A/B on the manifest key alone at 100k: extraction 3,503 ms → **2,576 ms**. The refactor (per-file anon numbering; scan and publish separated) was proven **byte-identical on every fixture before any cache existed** — a flagship extractor should be provably neutral on its own first. Its key carries a **path-set digest** as well as content, because `resolve_import` probes the filesystem mid-scan: an edit re-scans one file, an add or delete re-scans everything. Gated through EDIT, ADD and DELETE, including a mount declared in a different file than the router it points at |
| D8 | **`ts-imports` data movement** | **Done** (2 unit tests, golden regenerated, harness green) | Measured in BYTES, not seconds — the one item this container can still decide honestly. Output **46.86 MB → 25.81 MB (−45%)**, handoff 18.5 → 13.6 MB, provider on a one-file edit 7,069 → **1,836 ms** (within-process). Two of the three largest things on the wire were not information: `indent=1` whitespace (10.16 MB and 1,046 ms to produce — 4.8× slower than compact) and `nameless` (10.71 MB, a pure function of `(name, sigs)`, exact on 190,400/190,400 — now derived by the engine, field kept optional so other providers are unaffected). Facts byte-identical everywhere |
| D11 | **Group symbols under their file** | **Done** (3 unit tests, golden regenerated, harness green) | **25.81 MB → 17.03 MB (−34%), and −64% cumulative from the original 46.86 MB.** Measuring first beat the estimate: `package` hoists as well as `path`, verified constant within a file on all 5,200. `kind` deliberately does NOT hoist — it is uniform per file across the entire 1M synthetic and varies per file in real code, so a purely benchmark-driven decision would have flattened it, saved 3.09 MB, and lost information on every real repository with nothing failing to say so. A unit test now pins that. Both shapes are the contract; only ts-imports moved |
| D9 | **`env-readers` adopts `incremental: per-file`** | **Done** (harness gate) | A/B on the manifest key at 100k: extraction 4,663 ms → **4,136 ms**; 545 ms at 1M on an edit. Genuinely the simple case, and *checked* rather than assumed — its only non-content dependency is the FILENAME, which decides whether the file is scanned as `.env.example` or as code. The gate asserts the difference from express: an ADD re-scans **1** file and a DELETE re-scans **0**, where express redoes everything. If that ever changes, `incremental: per-file` has become a false claim for this provider |
| D10 | **Benchmark on hardware that is not this container** | **Open** — now the highest-value measurement left | Session-to-session drift of 2.3x on identical code paths exceeds every optimisation in this series. R10's "2 real monorepos" clause is the fix and is still owed |
| D3 | **`--affected`** | **Open, and demoted** | Skips providers a diff cannot have affected. The measurement shows this is the smaller half of the remaining cost — the expensive providers genuinely do read the changed file |
| D7 | **Sandbox setup per provider run** | **Open, newly sized** | ~29% of a one-file edit at 100k is `unshare` + the minimal-root mount dance + view construction, paid once per cache miss. Nothing about it is wrong; it is simply the next-largest slice once parsing is dealt with, and no per-provider work will touch it |
| D5 | **Streaming provider output** | **Deferred on evidence, not forgotten** | D2's 256 MB ceiling binds at ~42.7 MB of declared input (~1.9M LOC), so the wall moved rather than vanished. NDJSON on a spooled descriptor would remove it, but RSS is 914 MB against a 2 GB budget across a 100× size range — memory is not the binding constraint at any size being asked about today |

Re-run E8 after each; `experiments/e8-scale/RESULTS.md` holds the baseline and
the numbers after D1, D2 and D4, and the R10 budgets have never been touched.
The honest statement of what keeldocs handles is **a million lines / 200
packages**, with a one-file-edit check that has been measured between 3.65s and
7.74s at 100k *for the same code* depending on how loaded this container was.
No public material should quote a p50 figure until D10 produces one on stable
hardware. What IS established is every same-session A/B in the table above, and
that the tool completes correctly at every size.

One methodological note that now matters more than any single number: this
container's run-to-run variance is large — `check --no-cache`, which exercises
identical code paths, moved 43% between two sessions. Only same-session A/B
toggling one variable is trustworthy evidence here, and that is how D4's effect
is stated above. `KEELDOCS_TIME=1` prints per-provider timings to stderr and has
now settled two of these questions by measurement rather than argument.

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
| E8 scale benchmark (1M LOC) | "warm check ≤5s p50" | **Run 2026-08-01 → FAILED; D1 and D2 built and re-measured after each → 3 of 4 budgets now pass at every size including 1M LOC.** No incremental cache existed (D1 built one: 100k warm 9.66s → 2.23s); then 1M LOC died on a constant output cap (D2 made it input-proportional: 1M now completes CLEAN at 8.9s warm, 914 MB). One budget still fails — warm p50 at 1M — and the one-file-edit case (6.24s @100k, 39.70s @1M) is D4. Budgets never moved. Both fixes departed from the mitigation the register named, on measurement, and both departures are recorded in the ADRs |
| E9 noise SLO field trial | the adoption bet | **Four rounds run** on a real production repo; the 4-week accept-rate number still needs a cohort |
| E10 injection red-team | "artifact-borne injection cannot reach an action" | **Passed, permanent CI gate** |
| E11 ERD scale rendering | "the flagship diagram survives 500 tables" | **Run 2026-08-01 → FAILED, REDESIGNED, PASSES.** The flat ERD crossed `maxTextSize` between 100 and 250 tables — real Supabase and Rails schemas live there, and the failure renders *nothing*. Chunking shipped; 1,000 tables now render with every table drawn. Gated by 8 unit tests against Mermaid's real ceilings plus a 260-table end-to-end harness check |
| E12 study full-text verification | the ~46% positioning claim | **Not run** — must happen before that number appears in any public material |
| E13 replay vs live equivalence | "WASM Postgres matches real DDL semantics" | **Passed** — 10/10 byte-identical to PostgreSQL 16 |
| E14 JVM/Go probes | tier choice per framework | **Passed** — spring 17/17, gin 15/15 |
| E15 async-messaging corpus | "declared channels are extractable" | **Passed** — 10/10, 100% recall and precision |

---

**Validation debt, precisely.** Two experiments have never run. **E7**
(cross-agent smoke) needs a published package — owner-blocked, on the critical
path. **E12** (full text of the ~46% study) must happen before that number
appears in any public positioning material — a writing gate, not a build one.

E8 and E11 came off this list on 2026-08-01, and they are worth reading as a
pair, because they are the two ways an experiment pays. E11 found a defect that
no amount of code review would have surfaced — the renderer was correct, the
*budget* was absent — and it was fixable in an afternoon, so the fix shipped
with the finding. E8 found that a mitigation the risk register has listed since
day one was never implemented, and no afternoon closes that. The tempting move
was to relax a budget nobody outside this repo would ever check. Doc 08's rule
is explicit that the correct move is redesign, not adjustment of the threshold,
so the budgets stand, the failure is written down with its numbers, and section
6 carries the work. An experiment that only ever confirms is not an experiment.

E8's residual is also named rather than quietly dropped: the R10 gate says
*"1M-LOC synthetic + 2 real monorepos"*, and the two real monorepos were not
run. They belong after D1–D3, not before — on today's engine they would
re-measure the same missing cache on a lumpier tree.

## 8. Inventory, for orientation

34 shipped providers across 10 capabilities (workspace-layout, module-graph,
http-endpoints, db-schema, db-policies, config-surface, services-topology,
decision-history, client-routes, async-messaging) · 8 document recipes · 6
agent skills · 110 unit tests · 39 byte-compared extractor goldens · ~25
end-to-end integration blocks · 13 ADRs · 15 experiments.

Field deployment: one real production application (Next.js App Router +
Supabase, 19-file migration chain, 30 tables, 4 views) running the full loop —
482 concrete surfaces at 100% coverage, `check` CLEAN — with four documentation
branches open.

Sandbox on Linux: network denied, repository read-only, readable set equal to
the provider's declared globs minus a security exclusion set, and the rest of
the host masked. Each tier probed per host and reported honestly when it
degrades.

---

## 9. Keeping this current

This file is the tracking artifact; design doc 11 holds the reasoning behind
each phase decision and design doc 10 holds the implementation audit. When an
item moves, move it here first and name the evidence — a status without
evidence is the thing this whole project exists to argue against.
