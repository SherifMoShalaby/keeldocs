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
| Coverage after init | **100%** of 144 concrete surfaces (438 after the R4 denominator) |
| Born-clean | `check` CLEAN over 31 docs, 66 regions |
| Determinism | double-run byte-identical (extractor AND check) |
| False drift on untouched repo | **0** |
| Surgical drift | 1 synthetic migration → exactly 1 stale region (of 66); revert → CLEAN |
| Doc lies | 249 → **113** after four rounds of field-learned precision rules (262 suppressed) |

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

## Round 3 — the last five route claims, resolved by evidence

Asked to "fix the five route claims", the honest split turned out to be
4-to-1 against the tool:

**Four were keeldocs false positives.** They sit under a heading reading
*"B3.1 Retired Endpoints"* — a list of endpoints deliberately removed.
Their absence is exactly what the document asserts, so flagging them
reported the doc as wrong for being right. Fixed at the rule level: a
section whose heading matches retired/removed/deleted/dropped/sunset/
decommissioned inverts the test, and both file and route claims stay
quiet inside it (unit-pinned, including that the rule ends at the next
heading).

**One was a real documentation bug**, wrong on three counts: the TSD
documented search as `POST /functions/v1/search-rides` — an Edge Function
that does not exist among the eleven that do — under the wrong name
(`search_rides`, underscore) and with a body shape (`{origin:{lat,lng},
filters:{…}}`) matching no version of the function. It is a PostgREST
RPC. Corrected against the definition in migration 0019, which is
byte-for-byte what the client passes to `supabase.rpc('search_rides', …)`.
(Round 4 refined this: 0019 is not *the* current definition but one of TWO
live overloads — the one the app calls. See R4 finding 4.)

**A new gap opened by the fix.** The corrected line —
`POST /rest/v1/rpc/search_rides` — is still flagged, because keeldocs does
not model the PostgREST surface at all. For a Supabase app that surface
IS the API: every table is reachable at `/rest/v1/<table>` and every
function at `/rest/v1/rpc/<fn>`, all of it derivable from the catalog the
replay engine already builds. Modeling it would close this class of
finding and document a real API surface currently invisible to the tool —
but it also grows the coverage denominator again, which is an owner
decision (the last one was made deliberately, not unilaterally), so it is
recorded here rather than built.

## Round 4 — the derived surface, built (owner decision, 2026-08-01)

Two providers close it. `sql-replay` now introspects ROUTINES as well as
tables and enums, and a new `http-endpoints/supabase-postgrest` derives the
REST API from that catalog through the declared `${facts:db-schema}` read —
so the expensive replay still runs exactly once. Exposure follows
`supabase/config.toml [api]`: `enabled = false` means there is no surface,
and `schemas` decides what is reachable.

**Route claims went 5 → 1 → 0.** The corrected TSD line now verifies
against a fact, and the run's suppression count rose to 262 while total
findings moved 114 → 113 — precision again, never recall.

**What the field taught this round.**

1. **A generated region must record exactly what its binds resolve to.**
   The ERD diagram bound nothing and inherited `fact:db-schema/*` from its
   parent, which had always matched because tables+enums *were* every db
   fact. The moment routines joined the capability, a freshly generated
   diagram recorded a narrower hash than its own binds resolved to and was
   **born stale** — the born-clean invariant caught it on the first run.
   The obvious repair (enumerate the table ids) then broke the opposite
   invariant: an enumerated list cannot contain an id that does not exist
   yet, so a table ADDED after generation would never reach the diagram.
   Both hold only if the recorded set is derived from the same prefix the
   binds declare. Cost of the correct spelling: a routine change redraws an
   unchanged diagram. Over-flagging is the side to err on; sync repairs it
   in one pass.
2. **Seed objects must be excluded by identity, not by schema.** Extension
   stubs create routines in `public` — an unqualified `CREATE FUNCTION` has
   no other home — so the seed-schema filter that keeps `auth`/`storage`
   out of the catalog could not keep ~30 postgis and moddatetime stubs from
   masquerading as extracted functions. A baseline is now taken after
   seeding and before the chain runs, and a routine is dropped only if BOTH
   its signature and its body digest are unchanged, so a chain that
   legitimately replaces a stubbed name still reports its own version.
3. **A derived fact has no file, and inventing one would be the lie.** The
   endpoint inventory's source column now reads
   `postgrest-catalog: fact:db-schema/public.orders` for derived rows.
4. **The routine surface immediately paid for itself.** The trial subject
   turned out to have TWO live overloads of its search RPC — an older
   `geography`-typed one and the newer `double precision` one the app
   actually calls, both `EXECUTE`-granted to `authenticated`. `CREATE OR
   REPLACE` with a changed parameter list does not replace; it overloads.
   Nothing in the repo says so, and no documentation had noticed. The
   catalog does.

**Named next increment.** Views and materialized views are exposed by
PostgREST and are not modeled here; they surface as `view-unmodeled` gaps
so the hole reads as a hole. `PUT` is likewise unclaimed — it needs
primary-key knowledge the extracted payload does not carry. A separate,
larger gap this round surfaced: a recipe that GROWS a section does not
retrofit that section into docs generated by an earlier version, because
`init` never overwrites and `sync` only regenerates regions that already
exist. Deleting the generated file and re-running `init` is the current
answer; recipe migration is follow-up work in doc 11.
