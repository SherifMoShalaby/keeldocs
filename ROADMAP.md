# keeldocs — Roadmap and Status Board

**As of 2026-08-04.** Published: **`keeldocs@0.3.0` on npm** — `latest` — built by
`release.yml` on a `v*` tag under npm Trusted Publishing, with a SLSA v1
provenance attestation and no publish token anywhere. 3-OS CI green including
`action-smoke` as of `9edc841` — including the non-blocking Windows lane, red for at least twelve
runs before it and fixed the same day (§4 item 6) · 174 unit tests · 39 extractor goldens · 82 harness checks ·
**E7 passed 2 of 3, so nothing gates the `0.2.0` cut**.
*(This header names counts and the release tag, not a HEAD SHA — a header that
quotes its own commit is false the moment it lands and needs a second commit to
become true. That happened four times in one day; the fix is to stop.)*

**Nothing in this document is waiting to be built.** The two experiments that
ran on 2026-08-01 both failed and both are resolved. E11: the flagship ERD
stopped rendering between 100 and 250 tables, and `src/render.js` gained
budget-driven chunking — every size to 1,000 tables now draws every table. E8:
there was no incremental cache at all (**D1**, 100k warm 9.66s → 2.23s) and 1M
LOC died on a constant output cap (**D2**, 1M now completes). Those two were
what the failure actually required. Seven more items followed, are honestly
measured, and were past the point of need — section 6 keeps them as a record.

**One number is deliberately not claimed.** The budgets were never moved, and
the p50 has no verdict: this container's timing drifts up to **2.3× between
sessions on identical code paths** (measured on `check --no-cache`, where every
scale change is inert), which is larger than any effect the series measured.
Each optimisation has a verified same-session A/B; the *budget* does not have a
result. RAM, cold runs and completes-at-all pass at every size to 1M. Closing
R10 honestly needs one run on stable hardware plus its two-real-monorepo clause
— a measurement, in section 4, not more code. **No public material should quote
a p50 until then.**

**What is left is five owner actions, all in section 4, and all of them now
happen on a physical machine** — stable hardware (E8), a registry login, people,
and one scheduled check. The three that gated the rest — publication, E7 and the
downstream merges — are done.
Each item names the file carrying its procedure; nothing lives only in a chat
log.

**A Plane board now exists alongside this document.** Project `KEEL` in the
`appsby` workspace carries 29 tickets across 8 epics, produced 2026-08-04 by a
senior-lead review of this roadmap against the original design brief. It is
worth deciding, once, which of the two is authoritative for open work — this
file currently claims that role in its own header and in CLAUDE.md, and two
tracking systems that both claim it is how a roadmap starts lying.

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
capabilities feed eight document recipes. The engine has 174 unit tests, 39
byte-compared extractor goldens and roughly two dozen end-to-end integration
blocks that run on Linux, macOS and Windows every push. It has been run against
a real 30-table Supabase/Next.js application end to end: 482 concrete surfaces,
100% documented, `check` CLEAN, and 249 → 113 documentation lies found with
accurate receipts across four hardening rounds. What is *not* done splits
cleanly into two piles: a short list of owner actions that need a registry
login, stable hardware or people; and a set of features deliberately
refused until their evidence arrives. The pile that gated the others — first
publication, then E7 — is empty as of 2026-08-03, and the agent-native
distribution bet the whole strategy rests on is now measured on two independent
agents rather than assumed. The scale work E8 opened is **closed**:
the tool is correct at every size up to a million lines, and what R10 still owes
is a measurement on stable hardware, not more code.

---

## 2. The original brief, scored

The brief asked for eleven design deliverables and set nine non-negotiable
constraints. All eleven deliverables exist as design docs (`docs/design/00`
through `11`). The constraints are where the honest scoring lives.

| # | Constraint | Status | Evidence / gap |
|---|---|---|---|
| 1 | Stack-agnostic | **Partial by roadmap** | TS/JS, Python, Java, Go, C#, Ruby, Dart shipped; Postgres/Supabase/MySQL-static/SQLite. Mongo and MySQL *live* are gated, not missing by accident |
| 2 | Agent-native distribution | **Done on 2 of the brief's 5 named agents** | The brief names *"Claude Code, Codex, Cursor, Gemini CLI, Copilot"*. Adapters exist for three; **Gemini CLI and Copilot have never been built and, until 2026-08-04, appeared in no section of this document — not done, not deferred, not refused.** E7 ran 2026-08-03: Claude Code 2.1.220 and Codex 0.146.0 each discovered and invoked a skill unprompted, as their first action, interactive and headless. Cursor has an adapter and is untested (no trustworthy CLI install path on the test host). 6 skills, plugin + marketplace manifests, CLI envelope contract and `keeldocs skills install` all ship. See §4 item 7 |
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

Everything in the v0.1 scope table shipped. It is tagged `v0.1.0-rc.1`. The line
that ships to users is now stable `0.3.0` on npm, so promoting the v0.1 tag is a
bookkeeping decision rather than a blocked one.

| Item | Status |
|---|---|
| `init` / `check` / `sync` / `new` command surface | **Done** |
| Anchors, regions, slots; fact-hash drift; six disjoint drift states | **Done** |
| Doc lie-detector with receipts | **Done** — 7 finding classes, four rounds of field-measured precision rules |
| Recipes: system-map, erd, endpoint-inventory, config-reference, `new adr` | **Done** |
| Providers: workspace-layout, module-graph, http-endpoints, db-schema, config-surface, services-topology, decision-history | **Done** |
| Live Postgres via tbls behind `--live` | **Done** (reclassified OBSERVED once replay landed) |
| Fixture harness (`test-provider`), noise SLO, redaction barrier, slot-write | **Done** |
| Coverage as ratchet, never a gate | **Done** |
| npm publish | **Done 2026-08-03** — four rc's, then `keeldocs@0.2.0` as `latest`; trusted publishing + provenance, no token |
| PyPI placeholder + org transfer | **Blocked (you)** — name still free, and R14's lesson is that registries move |

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
| Windows red → green | **Done, after a regression caught 2026-08-03** — the posix-emit contract, `fileURLToPath` roots and LF-pinned harness always held; what broke was the harness feeding a bare `C:/...` path to dynamic `import()`, which node rejects as a URL scheme. Green on all five jobs at `db47d6b` |
| Cut `0.2.0` release, then `0.3.0` | **Done 2026-08-03/04** — `0.3.0` adds `keeldocs skills install` and ships the rewritten README; npm serves the README from the tarball, so the page could not be corrected without a release. — `keeldocs@0.2.0` on npm as `latest`, SLSA v1 provenance naming `release.yml` at `refs/tags/v0.2.0`, no publish token. Verified cold from the registry: 130 files, 0 `.pyc`, and `meta.engine` finally reports `keeldocs@0.2.0` |

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
| ≥500 public repos with committed anchors | **Blocked, and NOT yet measurable** — `scripts/dev/adoption.py` is the instrument, and as of 2026-08-04 it returns `UNMEASURABLE` rather than a number: GitHub code search does not index this repository, which is known to carry anchors in `docs/reference/configuration.md`, so "no adopters" and "index cannot see us" produce the same 0. The previous claim here — *now measurable: the package is installable* — was wrong: being installable is not the same as being countable. Re-run the script; it reports a floor once its own control passes |
| ≥2 non-founder maintainers with merge rights | **Blocked (you)** — hard gate, no v1.0 at bus factor 1 |
| Survived one breaking agent-API change, adapters-only fix ≤1 week | **Not yet exercised** |
| Noise SLO holding in the wild (accept-rate ≥30% sustained) | **Blocked (evidence)** |

---

## 4. Blocked on you — the critical path

**Five items open; three are now done.** Section 6 is closed and section 5 is a
set of refusals, so this is the whole of what is left.

**The work has moved to a physical machine, and this is where it picks up.**
Everything that could be built in a sandbox is built, tested and pushed; nothing
is stranded in one. What remains needs things a cloud session structurally
cannot have: hardware whose clock does not drift (E8), a registry login (PyPI),
and people (the cohort). The two that gated everything else — publication, then
E7 — are both closed, **and with them the `0.2.0` cut**. Each item below names
the file that carries its procedure, so no step lives only in a chat log.

**~~1. npm publication~~ — DONE 2026-08-03.** `keeldocs` is on npm.
`0.2.0-rc.4` publishes from `.github/workflows/release.yml` on a `v*` tag under
npm Trusted Publishing, with a SLSA v1 provenance attestation naming the tag,
the repo and the workflow path — **and no publish token in existence**, which is
the form R9 asked for. `latest` and `rc` both point at `0.2.0-rc.4`;
`npx keeldocs init` works from a cold machine. **E7 is unblocked**, and with it
the `0.2.0` cut and every adoption number.

*What it cost, because the lesson is about gates and not about npm:* four
release candidates. rc.1 by hand (trusted publishing configures on a per-package
page that does not exist until the package does). rc.2 died because `npm@latest`
is npm 12 and declares node ≥22.22 — "install the newest CLI" is not
version-pin-independent, and the workflow now pins npm 11 and *asserts* the
11.5.1 floor. rc.3 died because `release.yml` never ran `npm ci`, so the suite
gating publication was a strictly weaker suite than the one gating every push —
seven checks silently absent. rc.4 green. Every one of those was invisible to
review and only findable by releasing; the throwaway rc is what kept them out of
the `0.2.0` cut.

**~~2. Run E7~~ — DONE 2026-08-03, PASSED 2 of 3. The `0.2.0` gate is cleared.**
Claude Code 2.1.220 and Codex 0.146.0 each passed Test A and Test B. Six runs;
in every one the agent discovered the skill and invoked it as its **first**
action, then reported drift from the engine's envelope rather than from its own
reading of the code. Codex never opened `docs/` or `routes/` at all, so it could
not have hand-derived its answer. R7's uniformity assumption is a measurement
now, not a bet — on two implementations. Cursor is untested and remains R7's
third column, along with the breaking-change drill; neither is on the critical
path. **Cutting `0.2.0` is now a decision, not a blocker.**

*What it cost, because the lesson is about instrumentation and not about agents:*
seven defects, three of which would have produced a **confidently wrong verdict**
rather than no verdict. `prep-fixture.py` left its own answer in the tree — doc,
line, state and both fact hashes — where an agent could have quoted the engine's
receipts having never invoked it, a false pass more convincing than the
markdown-hand-reading one the runbook warns about. A missing extractor runtime
makes `check` return `TOOL_ERROR` instead of `DRIFT_FOUND`, and the first Codex
run failed exactly that way while behaving *correctly* — it refused to claim the
docs were accurate. Codex also runs commands through a login shell that discards
a `PATH` set at launch, so the fix that works for Claude Code does not work for
it. All of it is now in `prep-fixture.py` and `RUNBOOK.md`, including the
three-signal method for telling a real pass from a false one, rather than in
anyone's memory.

*Still worth doing, unblocked, small:* the shipped `AGENTS.md` tells agents that
skills live in `skills/`, and no adapter installs there — it is `.claude/skills`,
`.agents/skills`, `.cursor/skills`. One word, in the one file whose whole job is
to orient an agent that has no skill support.
3. **Claim `keeldocs` on PyPI and crates.io.** Five minutes, both still free as
   of 2026-08-03, and R14 exists because "undrift" was taken between the pick
   and the lock. Publication made the name findable; that cuts both ways.
**~~4. Merge the four open Tareeqna branches~~ — DONE 2026-08-03.** All four
   landed as PRs #17-20 in dependency order: the report-only CI gate, the RPC
   correction with its two-overload note, the REST-and-routines surface, then
   views, PUT and PK markers. Two corrections to what this entry used to say:
   there were **five** keeldocs branches, not four — `keeldocs/init-docs` was
   already merged as #16 — and **both** pairs stack, not just the last two, so
   the stated order was right for a broader reason than the one given. The
   downstream repo had no PRs open for any of them; the branches existed and
   were simply never proposed.
5. **Recruit an interview beta cohort** — the ≥50% card-completion gate has no
   data.
6. **Windows: fixed 2026-08-03; the promotion check is dated two days early.** The lane
   had failed on **all twelve of the most recent runs on `main`** while every one
   of those runs reported success, because `continue-on-error` masks it and the
   only symptom was `list index out of range` — a message naming neither the
   subprocess nor the ESM error on the stderr the harness discarded. Cause: the
   harness passed a bare `C:/...` path to dynamic `import()`, where node reads
   `c:` as a URL protocol. Fixed with `pathlib.as_uri()`, and the subprocess
   boundary now reports rc and stderr instead of an IndexError. **Green on all
   five jobs at `db47d6b`.**

   The scheduled task fires **2026-08-29**, which is 26 days after the fix, so
   it lands two days BEFORE the four weeks it claims to check (2026-08-03 green
   → 2026-08-31). Either move the task to 2026-08-31 or read its result as
   "26 days green" and decide on that. It checks a four-week green streak before
   deleting the `continue-on-error` line. That streak began 2026-08-03 — one green run
   is not four weeks, and the reminder should be read as a question, not a
   go-ahead. Had it fired against the previous state it would have promoted a
   silently red lane to a blocking one and stopped every merge.
7. **Decide Gemini CLI and Copilot: adapter, or refusal with a threshold.** The
   brief's constraint 2 names five agents; three have adapters and two have
   never been mentioned anywhere in this document. That is the one place the
   brief asked for something and the tracking silently lost it, rather than a
   decision being made and recorded.

   It is now cheap and de-risked: E7 proved the adapter contract on two
   independent implementations, `keeldocs skills install` reads
   `adapters/<agent>/manifest.yaml` generically, and an adapter is that one
   file. But the sequencing argument against building them immediately is
   sound and came from the team lead — **Cursor already has an adapter nobody
   has tested**, so adding a fourth and fifth multiplies an unmeasured surface.
   Test Cursor first, then decide. Either outcome is acceptable; leaving them
   untracked is not.

8. **Run E8 once on hardware that is not this container** (was "D10"). Not a
   build — a measurement. This container's timing drifts up to 2.3× between
   sessions on identical code paths, which is more than any optimisation in the
   scale work, so R10's warm-check budgets currently have **no verdict**. One
   run of `experiments/e8-scale/bench.py` on a stable machine, plus R10's own
   "2 real monorepos" clause, is the only thing that can close that row. Until
   then no public material should quote a p50 figure.

One thing left to decide, and it is now the easy version of the question: E7
supplied the evidence, so **cutting `0.2.0` no longer needs to rest on
judgement**. Also still open and unrelated: whether a **public-facing
view being writable through PostgREST** is intended — keeldocs surfaced it, but it is
a schema decision, not a docs one.

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

**`auth-model` — cut, and missing from this list until 2026-08-04.** The
original brief names it as a capability (keycloak-oidc, supabase-auth, auth0,
firebase, custom) and the panel cut it unanimously: design doc 07 records
*"auth-model (cut until determinism proven — unanimous)"*. The decision was
sound and the bookkeeping was not — this section claims to be the record of
such decisions, and for months it did not contain this one, so the only place
a reader could learn the capability had been considered at all was a table
cell in a design doc. Threshold to revive: a provider that can determine an
auth model deterministically, on a labeled corpus, without inferring intent
from configuration that merely looks like an auth setup.

**Fenced code blocks in the lie-detector — exempted, not overlooked.**
`src/anchors.js` masks fences so an anchor shown as an example is not parsed
as structure (that bug shipped, and the dogfood gate caught it). `src/lies.js`
deliberately does NOT do the same. An anchor inside a fence is unambiguously a
parser error; a *claim* inside a fence may be a real instruction to the reader
— `npm run deploy` in a README fence is a claim. Blanket-suppressing fenced
claims would trade precision measured over four E9 rounds for a guess.
Threshold to revisit: a field-measured false-positive rate attributable to
fenced examples, on a real corpus, not a hypothetical.

The standing kill list is unchanged and refuses even on request: hosted
dashboard, docs-site generation, auto-merge of generated content, general code
Q&A, code-review bot, translation, a VS Code extension, per-framework
mega-providers, required telemetry, live-DB write access, row-value sampling
into committed artifacts.

---

## 6. Scale work (the D-series) — CLOSED 2026-08-02

**This section is a record, not a queue.** Nothing in it is waiting to be
built, and no reader should treat a "D" number as an outstanding task.

E8's scale benchmark failed on 2026-08-01. Two things had to be fixed for the
tool to be correct at scale, and they were: **D1** gave it an incremental cache
it had never had (100k warm check 9.66s → 2.23s), and **D2** replaced a constant
output cap with an input-proportional one, after which **1M LOC completed
cleanly for the first time**. That is where the goal was met — the tool is
correct at every size, and comfortable at the size a beta cohort will bring.

Seven further items followed. They are real improvements, honestly measured, and
they were **past the point of need**. Profiling always finds a next-largest
bottleneck; a list generated that way has no natural end, and letting it read
like a backlog was a mistake in how this document was kept. The engine side of
scale is done. What remains for R10 is not code — it is **one measurement on
hardware that is not this container**, and that belongs in section 4 with the
other things only the owner can do.

### The record

| # | What | Outcome |
|---|---|---|
| D1 | Incremental extraction, keyed on the resolved input set by content hash | **The one that mattered.** Warm check 5.61s → 1.40s @10k, 9.66s → **2.23s** @100k; 33 ms overhead. Content hashes, not git blob hashes — the index needs stat-based dirty detection, whose failure mode is a silently stale answer |
| D2 | Input-proportional output cap, `clamp(6 × declared input bytes, 5MB, 256MB)` | **The other one that mattered. 1M LOC completes**: rc 0, CLEAN, 38,047 surfaces. The register's named remedy — sharding — was measured and rejected as *unsound*: a shard boundary silently turns 1,000 internal edges external |
| D4 | Per-file parse cache (`incremental: per-file`), `ts-imports` | Past the point of need. 28.0s → 13.7s on a 1M edit. Cost +300 MB RSS. *Its filed premise ("12 providers re-run") was wrong — three do* | <!-- counts:ignore -->
| D6 | `express` adopts it | 11,288 ms → 737 ms on a 1M edit. Refactor proven byte-identical on every fixture before any cache existed |
| D9 | `env-readers` adopts it | 4,663 → 4,136 ms at 100k. The one case where the advance description held, and only because it was checked |
| D8 | `ts-imports` wire format | 46.86 → 25.81 MB. Two of the three largest things on the wire were not information |
| D11 | Symbols grouped under their file | 25.81 → 17.03 MB; **−64% cumulative**. `kind` deliberately not hoisted — uniform in the synthetic, varies in real code |
| D3 | `--affected` | **Already built by D1**, better. Its remaining half is 7% of a warm check and is the part that decides whether a document is lying. A profile redirected it: chunked fact-file writes, warm 1M extraction 8,592 → 5,409 ms |
| D7 | Sandbox setup per run | **Mostly refused.** Filed figure wrong by ~5× (118–250 ms/miss, not 29%). One free part built; persisting and sharing views both refused — they cost a stated safety property |
| D5 | Streaming provider output | **Not needed.** RSS is 914 MB against a 2 GB budget across a 100× size range; memory is not the binding constraint |
| D12 | Write only the fact files something reads | **Not queued.** Would take ~27% of a warm run, but ADR-004 defines the JSONL as the canonical derived store and eight gates read it back. If it is ever done it starts as an ADR amendment, not a performance change |

### What this cost and what it taught

Two items were filed on numbers that turned out to be wrong, both the same way:
a residual was subtracted from a total and named after the most plausible
suspect. D4's "12 providers re-run" (three do) and D7's "29% is sandbox setup" <!-- counts:ignore -->
(2–6%). **A residual is not a measurement.** The third correction is larger: the
container's own timing drifts up to 2.3× between sessions on identical code
paths — more than any single optimisation in this list — so only same-session
A/B toggling one variable is trustworthy here, and the R10 budget verdicts are
**not established** by anything measured in it.

The honest statement of what keeldocs handles: **a million lines / 200 packages,
correct at every size**. No absolute timing figure belongs in public material
until it is measured somewhere stable — including this one, which is why the
sentence that used to quote a 100k warm check here has been removed.

`experiments/e8-scale/RESULTS.md` holds every baseline, profile and A/B behind
the table above. `KEELDOCS_TIME=1` prints per-provider timings to stderr and
settled two of these questions by measurement rather than argument.

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
| E7 agent adapter smoke matrix | the distribution bet | **Run 2026-08-03 → PASSED at threshold, 2 of 3; gate cleared.** Claude Code 2.1.220 and Codex 0.146.0 each green on Test A and Test B — six runs, the skill discovered and invoked as the **first** action in every one, drift reported from the engine's envelope rather than from the agent's own reading. Codex never opened `docs/` or `routes/` at all. Cursor untested (absent; no trustworthy unattended install), so R7's third column is still open, as is its breaking-change drill. Seven defects found first, three of which would have produced a *wrong* verdict rather than none — a fixture leak letting an agent quote the engine's receipts having never run it, and two environment faults that make a correctly-behaving agent look like a failure. `experiments/e7-agent-matrix/RESULTS.md` |
| E8 scale benchmark (1M LOC) | "warm check ≤5s p50" | **Run 2026-08-01 → FAILED; D1 and D2 built and re-measured after each → 3 of 4 budgets now pass at every size including 1M LOC.** No incremental cache existed (D1 built one: 100k warm 9.66s → 2.23s); then 1M LOC died on a constant output cap (D2 made it input-proportional: 1M now completes CLEAN at 8.9s warm, 914 MB). One budget still fails — warm p50 at 1M — and the one-file-edit case (6.24s @100k, 39.70s @1M) is D4. Budgets never moved. Both fixes departed from the mitigation the register named, on measurement, and both departures are recorded in the ADRs |
| E9 noise SLO field trial | the adoption bet | **Four rounds run** on a real production repo; the 4-week accept-rate number still needs a cohort |
| E10 injection red-team | "artifact-borne injection cannot reach an action" | **Passed, permanent CI gate** |
| E11 ERD scale rendering | "the flagship diagram survives 500 tables" | **Run 2026-08-01 → FAILED, REDESIGNED, PASSES.** The flat ERD crossed `maxTextSize` between 100 and 250 tables — real Supabase and Rails schemas live there, and the failure renders *nothing*. Chunking shipped; 1,000 tables now render with every table drawn. Gated by 8 unit tests against Mermaid's real ceilings <!-- counts:ignore --> plus a 260-table end-to-end harness check |
| E12 study full-text verification | the ~46% positioning claim | **Not run** — must happen before that number appears in any public material |
| E13 replay vs live equivalence | "WASM Postgres matches real DDL semantics" | **Passed** — 10/10 byte-identical to PostgreSQL 16 |
| E14 JVM/Go probes | tier choice per framework | **Passed** — spring 17/17, gin 15/15 |
| E15 async-messaging corpus | "declared channels are extractable" | **Passed** — 10/10, 100% recall and precision |

---

**Validation debt, precisely.** One experiment has never run: **E12** (full text
of the ~46% study), which must happen before that number appears in any public
positioning material — a writing gate, not a build one. **E7** came off this
list on 2026-08-03, unblocked and then run the same day, passing 2 of 3. Its
residual is named rather than dropped: Cursor is untested, so "uniform across
the matrix" is a two-thirds claim; the runs are single samples, not a
reliability rate, which is why R7 specifies a weekly re-run; and the
breaking-change drill has not been exercised.

E7 is also the third entry in this document's small collection of experiments
that paid by finding something other than what they were looking for. It was
pointed at the agents and found seven defects in the *harness around* them —
three of which would have produced a confident wrong answer rather than an
obvious failure. The worst was self-inflicted: the prep script left its own
verification output in the fixture, so an agent could have quoted the engine's
receipts having never run the engine, and that pass would have been
indistinguishable from a real one. A gate that can be satisfied by an artifact
the gate itself created is not a gate.

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

35 shipped providers across 10 capabilities (workspace-layout, module-graph,
http-endpoints, db-schema, db-policies, config-surface, services-topology,
decision-history, client-routes, async-messaging) · 8 document recipes · 6
agent skills · 174 unit tests · 39 byte-compared extractor goldens · ~25
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
