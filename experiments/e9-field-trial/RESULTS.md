# E9 — Field trial on a production repo (first run, 2026-08-01)

**Subject.** A private production application: Next.js (App Router) on
Cloudflare, Supabase backend, pnpm, ~6.4MB working tree, 19-file SQL
migration chain, 29 pre-existing documentation files (spec-heavy: PRDs,
TSDs, ADRs, sprint plans). No content from the repo appears here —
aggregate numbers and defect classes only, per the trial's privacy rule.

## Headline numbers

| Metric | Result |
|---|---|
| `init` wall time (full extraction + docs) | ~10s (budget: <5 min) |
| Facts extracted | ~1,700 |
| Replayed migration chain | **19/19 files** after the fixes below |
| Catalog extracted | 30 tables, 12 enums, 48 FK edges, 5 spatial columns |
| Generated docs | 1,096-line ERD + RLS matrix; env reference (29 vars) |
| Coverage after init | **100% of 144 concrete surfaces** |
| Born-clean | `check` CLEAN over 31 docs, 66 regions |
| Determinism | double-run byte-identical (extractor AND check) |
| False drift on untouched repo | **0** |
| Surgical drift | 1 synthetic migration → exactly 1 stale region (of 66); revert → CLEAN |
| Doc lies | 249 → **115** after six field-learned precision rules (178 suppressed) |

## What the field broke (and what it taught)

**Replay vs Supabase reality.** The stock replay engine failed on file 1:
real chains `CREATE EXTENSION` freely, reference `auth.users`, read
`storage.objects`, call `extensions.moddatetime()` and `cron.schedule()`,
and put `geography(POINT,4326)` columns behind GIST indexes. Fixes, all
shipped with synthetic fixture coverage: pglite's bundled contribs
(pgcrypto, pg_trgm, …) now LOAD for real; unavailable extensions
(postgis, pg_cron, moddatetime) are shape-stubbed with named
`extension-stubbed` gaps; GIST indexes over stubbed types are stripped
(shape-neutral — indexes carry no ERD surface); `auth.users`/`storage`
baselines exist as seed stubs and seed-owned schemas are EXCLUDED from
introspection (a stub's columns must never masquerade as extracted truth);
domain-typed columns report their truthful declared name
(`geography`, not `bytea`); `replay-failed` gaps now carry the error
detail. Six iterations from zero tables to 19/19.

**Lie-detector precision.** Receipts were 100% accurate but the CLASS was
wrong on spec-heavy docs: URL routes (`/admin/x`), scoped npm packages,
`pkg@version` spans, pipe-pattern lists, and brace-globs were read as file
claims, and Next.js route-group parens broke link parsing. Six suppression
rules landed (unit-pinned): route-shaped tokens without extensions outside
real top-level dirs; installed scoped packages; version specs; pipe lists;
brace globs; paren-broken link targets. 249 → 115. Post-rule sampling:
findings are dominated by contract-TRUE references to not-yet-existing
paths in *planning* docs (plans reference futures by nature) — the right
follow-up is doc-scoping for aspirational docs, not a looser detector.
Genuine catches observed: docs pointing at a wrong directory name for
real code, cross-doc references to files that don't exist, and a doc
naming a sibling package variant of the one actually installed.

**Honest empties.** `mine` on a 2-commit history: NOTHING_MINED (correct —
no why-shaped subjects in window). `interview` on a 100%-covered fresh
init: NOTHING_TO_ASK (correct — no dead bindings, no undocumented plan).

## Gaps opened by the trial

Next.js file-based routing has no client-routes provider (the react-router
provider correctly stayed absent) — a `next-routes` provider is the natural
sibling. Supabase Edge Functions (`supabase/functions/*`) are an
uncovered endpoint surface. The drift FP <5% roadmap gate needs sustained
use across edits, not one session — this trial establishes the day-one
numbers (0 false drift, surgical staleness) that make sustained
measurement worth running.

## Round 2 (2026-08-01, after the docs merged to the app's main)

Running the detector against the merged tree surfaced three more precision
bugs and one genuine cross-capability blind spot — all fixed, all
unit-pinned:

1. **External `curl` hosts.** Route claims fired on any URL inside a curl
   example, including `vision.googleapis.com` and preview domains. Someone
   else's API says nothing about this repo's routes; only localhost and
   variable-shaped hosts (`${BASE_URL}`, `<your-domain>`) are checkable now.
2. **Prose parentheticals as links.** `[fs|path|crypto](…)` and coordinate
   tuples matched markdown link syntax; the link class gained the pipe and
   bare-number guards the file class already had.
3. **Client routes did not satisfy documented paths.** The route-claim
   check consulted only `http-endpoints`, so a documented admin PAGE — a
   real, reachable URL with a `page.tsx` behind it — was reported missing.
   It now consults `client-routes` as well, normalizing the three param
   spellings (`[id]`, `{id}`, `:id`). This was a genuine capability blind
   spot, not tuning: a new capability changed what "this route exists"
   means, and the older detector never learned.

Route claims went 18 → 5 across the two rounds, and the survivors are all
TRUE, verified by hand against the repo: a documented edge function
(`search-rides`) that is not among the eleven that exist, and four
`DELETE /api/v1/...` endpoints in the TSD against a repo whose only API
routes are three unrelated handlers. Total findings 249 → 118, with the
receipts accurate throughout — every round of this trial moved precision,
never recall.
