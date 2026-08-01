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

## Debt this experiment creates (measured, not estimated)

1. **Incremental extraction keyed on git blob hashes** — the missing warm
   path. Target: a one-file edit re-extracts one file. Everything below
   depends on this.
2. **Provider output sharding** — `ts-imports` (and any provider) must stream
   or shard rather than buffer one JSON blob into the 5 MB cap. This is what
   unblocks 1M LOC.
3. **`--affected`** — scope a check to what a diff touched, the shortest path
   from a 10s p50 to a sub-second one.
4. **Re-run E8 after each.** The numbers above are the baseline they are
   measured against; the gate is unchanged.

## Residual risk

The synthetic tree is uniform: equal-sized packages, a regular import graph,
one migration chain. A real monorepo is lumpier, and the R10 gate also names
*"2 real monorepos"* which this run did not cover. Two of the three budget
results (RAM, cold) have enough margin that lumpiness will not flip them; the
p50 result is already failing and cannot get better on a harder tree. The real
monorepo pass is still owed, and belongs after sharding rather than before —
it would only re-measure the same missing cache.
