# E8 — Scale benchmark (risk R10)

**Question (doc 08 §E8).** Does keeldocs stay usable on a monorepo? The gate
in R10 is four budgets: **warm check p50 ≤5s**, **warm check p95 ≤15s**,
**cold run ≤10 min**, **RAM ≤2GB**.

**Method.** A synthetic monorepo generator (`gen.py`) at three sizes, then
`bench.py` timing `init`, two consecutive `check` runs, and one `check` after
a single-file edit. Peak RSS is the child's own high-water mark, not a sample,
so a spike between samples cannot be missed.

Shape mattered more than size. A million lines of `// filler` measures
nothing, so the generator emits real npm workspace manifests, cross-package
imports, express route registration, `process.env` reads, an `.env.example`,
and a 41-table SQL migration chain — the surfaces the capabilities actually
extract. The reported surface counts confirm the tree is doing real work.

**Environment.** Linux container, Node 20.19.5, 2026-08-01. Sandbox at the
`minimal-root` tier (the strictest, ~15% slower than no sandbox — measured
separately). No incremental cache exists; see below.

## Reproduce

```
python3 experiments/e8-scale/gen.py  /tmp/e8-10k   50  5  40
python3 experiments/e8-scale/bench.py /tmp/e8-10k  10k
python3 experiments/e8-scale/gen.py  /tmp/e8-100k 200  6  83
python3 experiments/e8-scale/bench.py /tmp/e8-100k 100k
python3 experiments/e8-scale/gen.py  /tmp/e8-1m   200 26 192
python3 experiments/e8-scale/bench.py /tmp/e8-1m   1m
```

## Results

| size | packages | files | LOC | surfaces | init | check #1 | check #2 | check after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|---|---|---|---|
| 10k | 50 | 302 | 10,200 | 2,097 | 5.96s | 5.91s | 5.61s | 5.72s | 905 MB | 0 / clean |
| 100k | 200 | 1,402 | 100,400 | 16,247 | 9.66s | 10.44s | 9.66s | 9.97s | 900 MB | 0 / clean |
| 1M | 200 | 5,402 | 999,200 | — | 33.59s | 32.45s | 32.56s | 31.80s | 905 MB | **2 / TOOL_ERROR** |

At 1M LOC every run ends:

```
tooling error: ts-imports: output cap exceeded (5MB, ADR-002)
```

## Verdict against the four budgets

| budget | result | |
|---|---|---|
| RAM ≤ 2 GB | **PASS**, with room | 900 MB and **flat across a 100× size increase** — memory is not the wall |
| cold run ≤ 10 min | **PASS** on wall-clock | worst cold run 34s, two orders of magnitude inside the budget |
| warm check p50 ≤ 5s | **FAIL at every size** | 5.6s at 10k LOC, 9.7s at 100k, 32.6s at 1M |
| warm check p95 ≤ 15s | **PASS to 100k, FAIL at 1M** | 10.4s at 100k; 32.5s at 1M |
| completes at all at 1M | **FAIL** | exit 2, no output produced |

**E8 does not pass.** Two of four budgets are missed and the largest
configuration does not complete. Per doc 08's own rule — *"If any fails its
threshold, the correct move is redesign, not adjustment of the threshold"* —
the budgets stay as written and the gap is recorded as debt.

## Why: there is no warm path

The most important finding is not a number. Grepping `src/facts.js` confirms
**no incremental cache exists at all.** Nothing keys extraction on git blob
hashes; nothing is reused between runs. So:

- "warm" and "cold" are the same operation. The near-identical check #1 /
  check #2 times at every size are not cache hits — they are the same full
  extraction run twice.
- **a one-file edit costs a full re-extraction.** 5.72s at 10k, 9.97s at
  100k, 31.8s at 1M — statistically indistinguishable from the untouched
  runs. This is the exact scenario R10's p50 budget was written for, and it is
  the scenario with no optimisation behind it whatsoever.

R10's stated mitigation — *"shard cache on git blob hashes; invalidation
matrix; half-edge linker; `--affected`"* — was never built. E8 did not
discover a slow cache; it discovered a missing one. The p50 miss is therefore
not a tuning problem, and no amount of profiling the current path will close
it.

## Why the 1M run fails, and why that is the right failure

`ts-imports` produces more than 5 MB of JSON on 5,402 TypeScript files and
hits the per-provider output cap in ADR-002. The cap is deliberate: an
unbounded provider can exhaust the parent's memory, and the flat ~900 MB RSS
across all three sizes is that cap working.

The behaviour on hitting it is correct in every respect that matters:

- it **fails closed** — exit 2, `TOOL_ERROR`, no documents written
- it **names the provider, the limit, and the ADR** that set it
- it is **not a partial result presented as complete**, which for a
  documentation tool would be worse than failing

A tool that quietly documented 60% of a monorepo and exited 0 would be a
correctness bug. This is a capability gap wearing the right error message.

## What this buys, stated honestly

keeldocs today is comfortable to about **100k LOC / 200 packages**: a ~10s
check, 900 MB, correct results. That is most repositories, and it is the size
the beta cohort will bring. It is not the "1M-LOC monorepo" the design gate
was written against, and the README should not imply otherwise until sharding
lands.

*(Superseded by the D1 section below: a warm check at that size is now 2.2s.
The 1M sentence still stands.)*

## Debt this experiment creates (measured, not estimated)

1. **Incremental extraction keyed on git blob hashes** — the missing warm
   path. Target: a one-file edit re-extracts one file. Everything below
   depends on this. → **built 2026-08-01 as D1; re-measured below.**
2. **Provider output sharding** — `ts-imports` (and any provider) must stream
   or shard rather than buffer one JSON blob into the 5 MB cap. This is what
   unblocks 1M LOC.
3. **`--affected`** — scope a check to what a diff touched, the shortest path
   from a 10s p50 to a sub-second one.
4. **Re-run E8 after each.** The numbers above are the baseline they are
   measured against; the gate is unchanged.

---

# Re-run after D1 (incremental extraction) — 2026-08-01

`src/cache.js`. The cache boundary is the provider subprocess: raw stdout,
keyed on provider identity, the provider's own code, the exact resolved input
set by content hash, upstream capability facts, argv and sandbox tier. Content
hashes rather than git index blob hashes — the index needs git's stat-based
dirty detection to describe the working tree, and its failure mode is a
silently stale answer. Hashing every file in the 1M-LOC tree costs 155 ms.

The bench gained a `--no-cache` column so cold and warm are measured in the
same invocation, on the same machine, in the same minute. That matters: this
container's run-to-run variance is ±20%, large enough to manufacture or hide a
1-second effect across separate runs.

| size | cold (`--no-cache`) | warm #1 | warm #2 | after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|
| 10k | 6.91s | **1.32s** | **1.40s** | **2.24s** | 897 MB | 0 |
| 100k | 11.85s | **2.13s** | **2.23s** | **6.32s** | 891 MB | 0 |
| 1M | 35.18s | 19.48s | 20.25s | 31.10s | 896 MB | **2 / TOOL_ERROR** |

Against the pre-D1 baseline (`baseline-*.json`, same generator, same gates):
the 100k warm check went from **9.66s to 2.23s**, and the one-file edit from
**9.97s to 6.32s**.

## Verdict after D1

| budget | 10k | 100k | 1M |
|---|---|---|---|
| RAM ≤ 2 GB | PASS | PASS | PASS |
| cold ≤ 10 min | PASS | PASS | PASS |
| warm p50 ≤ 5s (unchanged tree) | **PASS** 1.40s | **PASS** 2.23s | FAIL 20.25s |
| warm p95 ≤ 15s | **PASS** | **PASS** | FAIL |
| warm p50 ≤ 5s (one-file edit) | **PASS** 2.24s | **MISS** 6.32s | FAIL |
| completes at all | PASS | PASS | **FAIL** (D2) |

**E8 still does not pass, and the gate is still not moved.** What changed is
where it fails. Before D1 every budget except RAM and cold-run failed at every
size; now the failures are two specific, named things: the 1M configuration
still dies on the ADR-002 output cap (that is D2, untouched), and a one-file
edit at 100k is 1.3 seconds over p50.

## Why the one-file edit is still 6.32s, precisely

Editing one `.ts` file in the 100k tree invalidates **12 providers**, because
twelve manifests declare a glob that matches it. Measured individually:

| provider | re-run cost | files it re-parsed | bytes it emitted |
|---|---|---|---|
| react-router | 1,890 ms | 1,400 | **35** |
| express | 1,353 ms | 1,400 | 1,757,760 |
| ts-imports | 1,232 ms | 1,400 | 4,375,314 |
| nestjs | 959 ms | 1,400 | 38 |
| env-readers | 195 ms | 1,401 | 147,534 |
| seven others (messaging, other routers) | 55–63 ms each | 1,400 | ~37 each |

Subtotal 6,046 ms — which is the 6.32s, almost exactly.

The finding worth keeping: **react-router is the single most expensive provider
on this edit and it emits 35 bytes.** It re-parses 1,400 files to conclude
there are no react-router routes here. D1 made the *provider* the unit of
caching, and that was the right first cut — it took the unchanged-tree case
from 9.66s to 2.23s. But a provider's unit of work is still its entire declared
input set, so one changed file costs a full re-parse of every file that
provider declared.

That is a different problem from the one D1 solved, and it does not have the
same shape: closing it means either per-file results in the provider contract
(providers emit results keyed by input file, the engine reassembles) or an
engine-supplied changed-file list that providers may narrow to. Both are
contract changes, not engine changes, and both should be designed rather than
improvised. Filed as a new debt item rather than folded into D3, which is a
different mechanism (skip providers a diff cannot have affected — no help here,
since this provider genuinely reads the changed file).

## What D1 cost

Directly measured on the 100k tree: the repo walk is 9 ms and the whole-run
hash pass is 23 ms over 1,603 files — **33 ms, 3% of a warm run**. Cold runs
with the cache on versus off, back to back on the same tree, came out at 11.54s
vs 10.49s and then 10.14s vs 10.14s: the write cost is inside this container's
noise floor. Nothing was traded away for the warm-path win.

## Reproduce

```
python3 experiments/e8-scale/gen.py  /tmp/e8-100k 200  6  83
python3 experiments/e8-scale/bench.py /tmp/e8-100k 100k
```

`baseline-*.json` are the pre-D1 measurements; `d1-*.json` are these.

## Residual risk

The synthetic tree is uniform: equal-sized packages, a regular import graph,
one migration chain. A real monorepo is lumpier, and the R10 gate also names
*"2 real monorepos"* which this run did not cover. Two of the three budget
results (RAM, cold) have enough margin that lumpiness will not flip them; the
p50 result is already failing and cannot get better on a harder tree. The real
monorepo pass is still owed, and belongs after sharding rather than before —
it would only re-measure the same missing cache.

---

# Re-run after D2 (input-proportional output cap) — 2026-08-01

**1M LOC completes.** `rc=0`, `CLEAN`, 38,047 surfaces documented, 914 MB peak
RSS. That was D2's entire target and it is met.

## What the measurement said, before anything was built

The roadmap's D2 read *"provider output sharding / streaming — `ts-imports`
must stream or shard rather than buffer one JSON blob into the 5 MB cap."*
That framing blamed the provider. Measuring first said otherwise, twice.

**The output is not bloat; it is proportional.** At 1M LOC `ts-imports` emits
46.9 MB — from **23.24 MB of declared input**, a ratio of **2.02×**. For a
symbol extractor emitting one signature per declaration (190,400 symbols across
5,400 files), that is what correct looks like. Across every provider at that
size, 2.02× is the largest ratio on any non-trivial input:

| provider | declared files | input | output | out/in |
|---|---|---|---|---|
| ts-imports | 5,400 | 23.24 MB | **46.86 MB** | **2.02×** |
| express | 5,400 | 23.24 MB | 4.03 MB | 0.17× |
| env-readers | 5,401 | 23.25 MB | 0.49 MB | 0.02× |
| every other provider | — | — | < 0.03 MB | — |

Only one provider ever crossed the constant. The constant was the defect: a
fixed byte count cannot express "do not let a provider run away", because what
counts as runaway depends on how much the provider was handed. 5 MB from a
ten-file repo is obviously runaway; 5 MB from a million lines obviously is not.

**And sharding would have been unsound, not merely awkward.** `ts-imports`
resolves import specifiers against the walked file set — in the 100k tree,
**1,000 of 1,400 modules carry a resolved cross-file edge**. Any shard boundary
silently reclassifies an internal edge as external. The run would complete, the
exit code would be 0, and the module graph would quietly be missing a thousand
edges. That passes every test that only asks whether the run finished, which is
exactly the class of failure this project exists to refuse. The same objection
applies to `express`, whose mount-graph resolution is why E1 put it in the code
tier in the first place.

## What was built

`clamp(6 × declaredInputBytes, 5MB, 256MB)`, with the declared input set taken
from the same per-provider resolution the sandbox and the D1 cache already use.

- **Floor 5 MB** — the old constant. Nothing that passes today can fail
  tomorrow, and a provider whose input cannot be sized (git-log's `.git/`
  directory grant) keeps precisely today's behaviour.
- **Ratio 6×** — three times the largest ratio measured at scale.
- **Ceiling 256 MB** — derived, not chosen. Capturing 46.9 MB moved RSS by
  94 MB and parsing it by 50 MB more (~3× the output), so 256 MB of output is
  ~750 MB of RSS, about 2× inside R10's 2 GB budget.

The kill *mechanism* is unchanged — `maxBuffer` still terminates the child — so
runaway protection is rescaled, not weakened. The failure message now names
which of the three rules bound, because claiming the ratio when the floor is
what actually bound would be an explanation that is not true:

```
flood-schema: output cap exceeded (5.0MB, ADR-002: the 5.0MB floor
              - 0.0MB of declared input would allow less)
```

## Results

| size | init | cold (`--no-cache`) | warm #1 | warm #2 | after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|---|
| 10k | 10.53s | 7.40s | 1.31s | 1.25s | 1.93s | 893 MB | 0 |
| 100k | 11.14s | 10.59s | 2.14s | 2.45s | 6.24s | 895 MB | 0 |
| 1M | 46.35s | 41.97s | **8.82s** | **8.91s** | 39.70s | 914 MB | **0 / CLEAN** |

The 1M row is the whole point: it was `2 / TOOL_ERROR` in both previous runs.
Born-clean also survives a million lines — `init` wrote four documents covering
38,047 surfaces and the immediately following `check` was CLEAN.

## Verdict against the four budgets

| budget | 10k | 100k | 1M |
|---|---|---|---|
| RAM ≤ 2 GB | PASS 893 MB | PASS 895 MB | PASS 914 MB |
| cold ≤ 10 min | PASS | PASS | PASS 46s |
| completes at all | PASS | PASS | **PASS** (was FAIL) |
| warm p95 ≤ 15s | PASS | PASS | **PASS 8.91s** (was FAIL) |
| warm p50 ≤ 5s, unchanged tree | PASS 1.25s | PASS 2.45s | **FAIL 8.91s** |
| warm p50 ≤ 5s, one-file edit | PASS 1.93s | MISS 6.24s | FAIL 39.70s |

**E8 still does not fully pass.** Three of the four R10 budgets now pass at
every size including 1M LOC. The one that does not is warm p50 at 1M, and the
one-file-edit case misses at 100k and fails badly at 1M — 39.7s, because twelve
providers declare a glob matching the changed file and each re-parses all 5,400
of its declared files. That is D4, unchanged and now measured at the size where
it hurts most: **D2 did not improve the edit case at all, and was never going
to.** The budgets have not been touched.

## Residual: the wall moved, it did not vanish

The 256 MB ceiling binds at ~42.7 MB of declared input — roughly **1.9M LOC**
for a provider of `ts-imports'` shape. Past that, a well-behaved provider is
killed by a memory limit rather than by an arbitrary constant, which is better
but still a wall. The real fix is streaming output (NDJSON on a spooled
descriptor, so engine memory stops tracking provider output at all); that is a
provider-contract change and belongs designed rather than improvised. A unit
test pins the knee, so changing any of the three constants surfaces as a test
failure rather than as a quietly different wall.

Streaming was considered now and rejected on evidence: RSS is 914 MB against a
2 GB budget across a 100× size range, so **memory is not the binding
constraint** at any size this tool is being asked about today. Building a
zero-dependency streaming JSON path to solve a problem the measurements say we
do not have would be the wrong trade.

## Reproduce

```
python3 experiments/e8-scale/gen.py  /tmp/e8-1m 200 26 192
python3 experiments/e8-scale/bench.py /tmp/e8-1m  1m
```

`baseline-*.json` pre-D1 · `d1-*.json` after D1 · `d2-*.json` after D2.

---

# Re-run after D4 (per-file parse cache) — 2026-08-02

D1 made an unchanged tree free. D4 attacks what happens the moment one file
changes: the provider re-runs, and its unit of work is its *entire* declared
input set.

## First, a correction to the D2-era write-up

The roadmap recorded "one `.ts` edit invalidates 12 providers." That was wrong,
and it was wrong in a way worth naming: the measurement counted providers whose
**globs match** the changed file, not providers that actually **run**. Nine of
the twelve are excluded by dependency detection — `react-router`, `nestjs`,
`vue-router`, `angular-router` and the messaging providers all declare
`deps: [...]` that the synthetic repo does not have. Only **three** re-run:
`ts-imports`, `express`, `env-readers`.

Re-measured properly, a 100k one-file edit costs **~64% provider parsing, ~29%
sandbox setup, ~7% view construction**. Parsing is still the thing to attack,
but for a smaller and more specific reason than the number implied.

## The mechanism

The obvious move — run the provider on only the changed files and merge — is
wrong for exactly the providers that cost the most, and wrong in the same way
D2's sharding was: `ts-imports` resolves import specifiers against the walked
file set and `express` resolves a mount graph across files. Feed either a
subset and internal edges silently become external.

So the split is *inside* the provider: **parsing is per-file, analysis is not.**
The engine caches the per-file parse, keyed by content digest, and hands it back
through the same channel as a cross-capability fact read. The provider
re-parses only what it has no entry for, then does its cross-file work over the
complete merged set exactly as before. Nothing about the analysis narrows.

A provider opts in with `incremental: per-file`, because only the provider knows
whether its parse of a file is really independent of the others. The engine
cannot check that claim — so the harness does.

Three details that turned out to matter:

- **Keys are `<digest>[|<discriminator>]`.** The digest says which bytes; the
  discriminator says anything else that changes the parse of those bytes.
  `ts-imports` appends the grammar, because a `.tsx` and a `.ts` file with
  identical content do not parse the same.
- **Intermediates are path-free.** The first implementation stored the path
  inside the cached parse, and the 200 identical `m0.ts` files in the synthetic
  monorepo — one digest, 200 paths — collapsed onto a single entry. **596 facts
  vanished.** Caught by the equality test before it reached a commit; the path
  is now stamped on use, so identical files legitimately share one parse.
- **`_parsed` is stripped before anything else sees it**, so a provider cannot
  smuggle cache plumbing into a document, and the D1 entry stores the real
  output rather than the output plus its own cache.

## What it buys

Measured inside a real extraction at 1M LOC (`KEELDOCS_TIME=1`, same process):

| provider | cold run | on a one-file edit |
|---|---|---|
| **ts-imports** (adopted) | 28,012 ms | **13,733 ms** |
| express (not adopted) | 12,078 ms | 11,288 ms |
| env-readers (not adopted) | 2,201 ms | 1,975 ms |

A/B on the same tree, toggling only the manifest key:

| | with `incremental: per-file` | without |
|---|---|---|
| 100k, one-file edit | **5,513 ms** | 6,492 ms |
| 1M, one-file edit | **39,339 ms** | 48,962 ms |

## Results

| size | init | cold (`--no-cache`) | warm #1 | warm #2 | after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|---|
| 10k | 11.81s | 8.74s | 1.50s | 1.48s | 2.29s | 907 MB | 0 |
| 100k | 13.46s | 12.42s | 2.68s | 2.48s | 6.44s | 899 MB | 0 |
| 1M | 74.19s | 59.87s | 16.60s | 12.91s | 47.21s | 1212 MB | 0 |

**These absolute numbers are weaker evidence than the A/B above, and the report
should say so.** `check_cold` runs with `--no-cache`, where D4 is inert — and it
moved from 41.97s to 59.87s between the D2 session and this one, +43%, on
identical code paths. That is the container's variance, not a regression, and
it is large enough to swamp the effect being measured. Only same-session A/B is
trustworthy here.

## Verdict against the four budgets

| budget | 10k | 100k | 1M |
|---|---|---|---|
| RAM ≤ 2 GB | PASS | PASS | PASS 1.2 GB |
| cold ≤ 10 min | PASS | PASS | PASS |
| completes at all | PASS | PASS | PASS |
| warm p95 ≤ 15s | PASS | PASS | PASS 12.9s |
| warm p50 ≤ 5s, unchanged tree | PASS 1.48s | PASS 2.48s | FAIL 12.9s |
| warm p50 ≤ 5s, one-file edit | PASS 2.29s | **FAIL 6.44s** | FAIL 47.2s |

**E8 still does not pass.** D4 moved the one-file edit meaningfully — ~15% at
100k, ~20% at 1M, and 51% off the provider it was applied to — without moving
it across the line. The budgets have not been touched.

## What D4 cost

**+300 MB of peak RSS at 1M** (914 MB → 1212 MB): the handoff is 18.5 MB, the
provider's stdout carries its new parses alongside its output, and the parsed
intermediates live in the engine's heap for the duration. Still inside R10's
2 GB budget, but this is the first change in the series that spends memory
rather than saving it, and at some larger size it will be the binding
constraint before the clock is.

## What is left, precisely

`express` is now the single most expensive provider on an edit — 11,288 ms at
1M, ~1,556 ms at 100k — and it has **not** adopted the mechanism. It could: its
`FileScan` is per-file and its mount-graph resolution is cross-file, exactly the
split D4 is built around. It has not, for a stated reason rather than an
oversight: `FileScan` accumulates into four module-level collections rather than
returning its contribution, so adopting D4 means refactoring the flagship
endpoint extractor — the one E1 measured at 100% recall and 100% precision, and
the one with a byte-compared golden. That refactor should be done deliberately,
with the golden as the gate, and not squeezed in behind a benchmark.

Doing it is the obvious next step, and on these numbers it would take the 100k
edit to roughly 5s and the 1M edit to roughly 36s. The first of those crosses a
budget; the second does not come close, and no per-provider work will — 1M LOC
needs the whole 3-provider set incremental *and* something for the ~29% that is
sandbox setup.

---

# Re-run after D6 (express adopts the per-file scan cache) — 2026-08-02

D4 built the mechanism and proved it on `ts-imports`. D6 applies it to the
provider that was left as the biggest single cost on an edit — and the one
where a per-file cache is most likely to be quietly wrong, because `express`
resolves mount graphs *across* files. It is the extractor E1 measured at 100%
recall and 100% precision, with a byte-compared golden, so the golden was the
gate throughout.

## The refactor came first, and had to prove itself neutral

`FileScan` mutated four module-level collections. Two things had to change
before any caching was possible:

- **Anonymous routers were numbered by a global counter.** A node id was
  `(file, "#anon<N>")` where N depended on how many anonymous nodes earlier
  files had created — so the same file scanned in a different position got a
  different id, and no per-file cache entry could be stable. Numbering is now
  per file. The file is already in the id tuple, so uniqueness is unaffected,
  and the id becomes a function of that file alone, which it never was.
- **Scanning and publishing are now separate.** `FileScan` accumulates its own
  contribution and `publish()` pushes it into the run-wide collections, so a
  *replayed* scan lands in the same collections in the same order as a fresh
  one. Order is emission order, and emission order is contract.

That refactor was verified byte-identical on every fixture that produces
express output — express-mounts, drift, init, mono, polyglot — **before** any
cache existed. A refactor of the flagship extractor should be provably neutral
on its own before anything is built on top of it.

## What a scan actually depends on

A scan is a pure function of three things, and the third is the one that is
easy to miss: **this file's bytes, this file's path, and which files exist.**

`resolve_import` probes the filesystem *during* the scan, so adding or removing
a file changes what an *untouched* file's imports resolve to. Keying on content
alone would have served a resolution computed against a tree that no longer
exists — a mount edge pointing at a file that is gone, or a missing edge to one
that has arrived.

So the cache key is `<content digest>|<path-set digest>:<rel path>`. The
consequence is stated rather than hidden: **an edit re-scans one file; an add or
delete re-scans everything.** That is the common case optimised and the rare
case left correct, which is the right way round. It also means the harness has
to test ADD and DELETE, not just EDIT — and it does, including the case where a
newly added router file must resolve through a mount declared in a *different*
file (`/api/v2/beta`). That is precisely the edge D2's rejected sharding would
have dropped.

Node ids embed absolute paths, so they are stored repo-relative and rebuilt on
load; a scan that cannot be encoded (anything escaping the repo root) is simply
not cached. Refusing to cache is always available and always safe.

## What it buys

Per-provider, inside a real extraction at 1M LOC (`KEELDOCS_TIME=1`):

| provider | before D6 | after D6 |
|---|---|---|
| **express** | 11,288 ms | **737 ms** |
| ts-imports (D4) | 13,733 ms | 8,376 ms |
| env-readers (not adopted) | 1,975 ms | 1,187 ms |

*(The machine is faster this session than the D4 session — see the caveat
below. `express` at 737 ms is a real order-of-magnitude change; the ts-imports
and env-readers rows mostly reflect machine speed.)*

A/B toggling only express's manifest key, same tree, same minute:

| | with `incremental: per-file` | without |
|---|---|---|
| 100k, one-file edit (extraction only) | **2,576 ms** | 3,503 ms |

## Results

| size | init | cold (`--no-cache`) | warm #1 | warm #2 | after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|---|
| 10k | 5.98s | 5.31s | 1.09s | 1.05s | **1.49s** | 902 MB | 0 |
| 100k | 9.85s | 9.15s | 1.82s | 1.80s | **3.65s** | 908 MB | 0 |
| 1M | 40.34s | 33.13s | 7.05s | 6.04s | **17.30s** | 1207 MB | 0 |

## Verdict against the four budgets

| budget | 10k | 100k | 1M |
|---|---|---|---|
| RAM ≤ 2 GB | PASS | PASS | PASS 1.2 GB |
| cold ≤ 10 min | PASS | PASS | PASS |
| completes at all | PASS | PASS | PASS |
| warm p95 ≤ 15s | PASS | PASS | PASS 7.05s |
| warm p50 ≤ 5s, unchanged tree | PASS 1.05s | PASS 1.80s | FAIL 6.04s |
| warm p50 ≤ 5s, one-file edit | PASS 1.49s | **PASS 3.65s** | FAIL 17.30s |

**Every R10 budget now passes at 10k and 100k, including the one-file-edit p50
that has failed in every previous round.** At 1M, p95 passes and p50 misses on
both scenarios.

## The caveat that belongs in the same breath

This container is not a stable measuring instrument, and the pass at 100k is
thinner than it looks. `check --no-cache` — identical code paths, D4 and D6
both inert — ran at 12.42s in the D4 session and 9.15s here. The machine is
**~1.35× faster today**. Normalising the 100k edit against that control gives
**~4.9s against a 5s budget: a pass by about one percent.**

So the honest statement is that the 100k p50 budget is met *on the machines
measured so far*, and is not met with any margin. It should not be described as
comfortably met, and it should be re-measured somewhere that is not this
container before it appears in anything public. The A/B is the trustworthy part
— toggling one manifest key on one tree in one minute moved the edit from
3,503 ms to 2,576 ms — and that effect is real regardless of the clock.

## What is left, and it has changed shape

With parsing and scanning both incremental, the 1M bottleneck is no longer
parsing. `ts-imports` still costs 8.4s on an edit while re-parsing exactly one
file: that time is now **reading an 18.5 MB handoff, emitting 37 MB of output,
and grouping 190,000 symbols** — data movement, not analysis. Attacking it
means a more compact intermediate and/or streaming (D5), not more per-file
work. `env-readers` at 1.2s is the last unadopted provider and is a small,
clean candidate.

The 1M p50 is not reachable by finishing this line of work. Even with every
provider incremental, a one-file edit at 1M would still pay the sandbox setup
per miss (~29% of an edit at 100k, D7) and the cost of moving several tens of
megabytes of facts through the engine. That is a different problem and should
be named as one rather than chased with another provider adoption.

---

# Re-run after D9 (env-readers adopts the per-file cache) — 2026-08-02

The last unadopted provider on the edit path. The roadmap called it "the simple
case"; that was checked rather than assumed, and this time the assumption held.

## It really is the simple case, and the gate proves it

`env-readers` produces, per file, a list of `(name, line)` it found. There is
no filesystem probing during the scan, no cross-file resolution, no run-wide
counter. The only thing besides the file's bytes that changes its work is the
**filename**, because that decides which scanner runs — a `.env.example` and a
`.ts` file with identical bytes are two completely different scans. So the key
is `<content digest>|<example|code>` and the stored findings are path-free, with
the path stamped on use.

The difference from `express` is observable, and the harness asserts it:

| mutation | `env-readers` re-scans | `express` re-scans |
|---|---|---|
| edit one file | 1 | 1 |
| **add a file** | **1** (only the new one) | **everything** |
| **delete a file** | **0** | **everything** |

`express` has to redo everything on an add or delete because its key carries a
path-set digest — `resolve_import` probes the filesystem mid-scan, so adding a
file changes what an untouched file resolves to. `env-readers` has no such
dependency, and the gate fails if it ever acquires one: an ADD that re-scans
more than the added file means `incremental: per-file` has become a false claim
for this provider.

## What it buys

A/B toggling only the manifest key, same tree, same session:

| | with `incremental: per-file` | without |
|---|---|---|
| 100k, one-file edit (extraction only) | **4,136 ms** | 4,663 ms |

Per-provider at 1M on a one-file edit: **545 ms** (plus 50 ms to write the
cache), down from 1,187 ms measured in the D6 session.

## A methodological finding that now outranks the numbers

This session's bench: 10k edit 2.50s, 100k edit 7.74s. The D6 session measured
3.65s at 100k. **That is not a regression.** The control says so: `check
--no-cache`, where every D-series change is inert, ran **9.15s in the D6 session
and 21.07s here — the machine is 2.3× slower today.** Normalised, this session's
100k edit is ~3.4s, slightly better than D6's 3.65s and consistent with the A/B.

The point worth recording is that **the container's drift between sessions
(2.3×) now exceeds every effect this experiment is trying to measure** (D6 was
0.9s, D9 is 0.5s). Bench absolutes from this environment can no longer function
as budget verdicts, and this report should stop presenting them that way. What
survives:

- **A/B toggling one variable in one session** — trustworthy, and it is how D4,
  D6 and D9 are each stated.
- **Per-provider timings inside one process** (`KEELDOCS_TIME=1`) — trustworthy
  for ratios within a run.
- **Absolute wall-clock against a 5-second budget** — not trustworthy here at
  all.

So the D6 conclusion stands but its framing needs correcting: "every R10 budget
passes at 10k and 100k" was true of the machine that measured it, and this
session would have reported a *failure* of the same budget on the same code.
**The 100k p50 result is not established.** The R10 gate's other half — two real
monorepos, on hardware that is not this container — has gone from a nice-to-have
to the only way this budget can honestly be called met.

## Results (this session; see the caveat above before reading them as verdicts)

| size | init | cold (`--no-cache`) | warm #1 | warm #2 | after 1-file edit | peak RSS | exit |
|---|---|---|---|---|---|---|---|
| 10k | 13.28s | 14.19s | 1.65s | 1.62s | 2.50s | 900 MB | 0 |
| 100k | 19.77s | 21.07s | 3.81s | 3.22s | 7.74s | 908 MB | 0 |

## What is left

Every provider on the edit path is now incremental. What remains at 1M is not
per-file work and cannot be reached by more of it:

- **D8** — `ts-imports` spends ~8s on an edit moving data, not parsing: an
  18.5 MB handoff in, 37 MB of output out, 190,000 symbols grouped. Needs a
  compact intermediate or streaming (D5).
- **D7** — sandbox setup, ~29% of an edit at 100k, paid once per cache miss.
- **D3** — `--affected`, still the smallest of the three.
