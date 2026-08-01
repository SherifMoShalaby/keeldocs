# E11 — ERD rendering at scale (risk R13)

**Question (doc 08 §E11).** At what database size does the flagship artifact —
the entity-relationship diagram on `docs/data-model.md` — stop rendering, and
what does keeldocs do about it?

This is the experiment with the worst failure mode in the set. Every other
artifact degrades gracefully: a long table is still a table, a truncated list
still lists things. A Mermaid diagram that exceeds a parser ceiling does not
degrade at all. It renders **nothing** — an error box where the first thing a
reader looks at should be. And it does so on the reader's machine, at read
time, long after the run that produced the file exited 0.

**Method.** Synthetic fact sets fed straight to `erdChunks`/`diagramBody` in
`src/render.js` (no extraction — this measures the renderer, not the
providers). Each shape varies table count, column count, foreign keys per
table, and schema count. Measured: characters per fenced diagram and edges per
fenced diagram, against Mermaid's shipped defaults `maxTextSize` **50,000** and
`maxEdges` **500**. Probe: `probe.mjs` (committed here); the assertions it
checks are now permanent tests in `tests/erd.test.js`.

**Environment.** Node 20.19.5, mermaid defaults as of 2026-08-01.

## Result before the fix: R13 is real, and closer than the design assumed

| tables | cols | fk/table | chars | edges | `maxTextSize` | `maxEdges` |
|---|---|---|---|---|---|---|
| 25 | 8 | 2 | 8,124 | 50 | ok | ok |
| 50 | 8 | 2 | 16,224 | 100 | ok | ok |
| 100 | 8 | 2 | 32,424 | 200 | ok | ok |
| 250 | 8 | 2 | 62,553 | 499 | **OVER** | ok (by one) |
| 500 | 8 | 2 | 125,618 | 998 | **OVER** | **OVER** |
| 500 | 12 | 3 | 186,970 | 1,497 | **OVER** | **OVER** |

The character ceiling breaks first, between 100 and 250 tables. The edge
ceiling breaks at ~250. Neither is exotic: a mature Supabase or Rails schema
sits in exactly this band. The design's own estimate ("~200 tables") was
right about the order of magnitude and optimistic about the margin — at 250
tables the flat diagram is 25% over on characters.

**Verdict on the pre-fix renderer: FAIL.** Per doc 08's rule — *"If any fails
its threshold, the correct move is redesign, not adjustment of the
threshold"* — the threshold was not moved.

## The redesign: budget-driven chunking

`erdChunks(factsById)` in `src/render.js` plans the pictures; `diagramBody`
concatenates them into the single `db.root.diagram` region.

- **Budget under the ceiling, not at it.** 40,000 chars / 400 edges per
  fenced diagram, against Mermaid's 50,000 / 500. The margin absorbs future
  column-annotation changes without a second scale experiment.
- **A database that fits stays one picture.** The fast path returns the
  identical string the pre-chunking renderer produced, so every existing
  repository and every golden fixture is byte-identical. Chunking is invisible
  until it is needed.
- **Split by schema first, then greedily by name order.** A schema is a
  boundary readers already recognise. Within an over-budget schema, tables are
  packed in name order until the next one would break the budget or the
  25-table readability ceiling — so wide tables split sooner than narrow ones,
  and the pack size is measured rather than guessed.
- **Edges are filtered to the picture that draws them.** A dangling edge makes
  Mermaid materialise a ghost entity, which would put the entity count
  straight back over the ceiling the split exists to respect.
- **Omissions are stated in the artifact.** A chunk that drops cross-chunk
  relationships says how many, in the chunk: `_N relationship(s) to tables
  outside this view are not drawn._`
- **One region id, not N.** All chunks live inside `db.root.diagram`. Mermaid's
  ceilings are per fenced diagram, not per document, so N pictures under one
  region works — and it keeps `sync`'s repair loop closed. Sibling region ids
  (`db.root.diagram.public-2`) would exist at some table counts and not
  others, producing a region that could be *reported* stale and never
  *repaired* — the half-loop the design forbids.

## Result after the fix

| tables | cols | fk | schemas | chunks | worst chars | worst edges | `maxTextSize` | `maxEdges` | tables drawn |
|---|---|---|---|---|---|---|---|---|---|
| 25 | 8 | 2 | 1 | 1 | 8,124 | 50 | ok | ok | all |
| 50 | 8 | 2 | 1 | 1 | 16,224 | 100 | ok | ok | all |
| 100 | 8 | 2 | 1 | 1 | 32,424 | 200 | ok | ok | all |
| 250 | 8 | 2 | 1 | 10 | 8,047 | 47 | ok | ok | all |
| 500 | 8 | 2 | 1 | 20 | 8,047 | 47 | ok | ok | all |
| 500 | 12 | 3 | 1 | 20 | 11,956 | 69 | ok | ok | all |
| 500 | 8 | 2 | 4 | 4 | 37,971 | 247 | ok | ok | all |
| 1000 | 12 | 3 | 4 | 40 | 11,304 | 69 | ok | ok | all |
| 3 | 400 | 1 | 1 | 1 | 36,840 | 3 | ok | ok | all |

Planning cost at the largest shape (1,000 tables) is 85 ms — noise against a
check run measured in seconds (E8).

**Verdict: PASS.** Every chunk renders, and at every size the number of tables
that reach the reader equals the number of tables in the database.

## The one case that cannot be fixed by splitting, and what it does instead

A single table wider than the whole character budget cannot be split — an
entity's attribute block is atomic. Measured with a 1,500-column table
alongside a normal one: the wide table gets its own chunk at 93,528 characters
and that chunk carries an explicit line naming the table, its measured size,
and the fact that it may not render. The normal table renders in its own
chunk, unaffected.

This is deliberate. The alternative — dropping columns until it fits — would
produce a diagram that renders beautifully and lies about the schema. A stated
failure beats a silent one.

## What this experiment cost the codebase

Nothing at the boundary: no new region ids, no recipe change, no migration for
existing docs. `src/render.js` gained ~60 lines; `tests/erd.test.js` (8 tests)
asserts against **Mermaid's real ceilings**, not keeldocs' internal budget, so
a future budget change cannot quietly cross the line the budget exists to
respect.

## Residual risk

The 25-table readability ceiling is an assertion, not a measurement — no
reader has been asked whether a 25-table picture is comprehensible. That is a
question for the beta cohort interviews, not for a synthetic probe, and it is
a comfort question rather than a correctness one: the diagram renders either
way.
