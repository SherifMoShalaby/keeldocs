# E13 — Replay-vs-live equivalence (the R1 go/no-go)

**Question (doc 11 §4 / open question #4).** Does WASM Postgres (pglite)
replay SQL migration chains to the SAME catalog as real PostgreSQL — i.e.
can the replay engine's `INTROSPECTED` facts be trusted as repo-derived
database truth without a Docker dependency?

**Method.** Ten migration chains covering the DDL surface the ERD recipe
consumes (serial/identity/bigserial keys, FK incl. composite, enum create +
`ALTER TYPE ADD VALUE` evolution, add/drop/rename column, drop-and-recreate,
`gen_random_uuid()` defaults, table rename, non-public schemas, views +
materialized views [must be excluded], RLS enable + policies). Each chain
replayed twice: (a) pglite via `replay-pglite.mjs`, (b) a real PostgreSQL 16
cluster via `replay-real.sh` (fresh database per chain, `ON_ERROR_STOP`).
Both introspected with the byte-identical SQL now shipped at
`providers/db-schema/sql-replay/introspect.sql` (deterministic ordering,
`udt_name` as the canonical type spelling). Comparison: canonical JSON
equality (sorted keys).

**Environment.** pglite `0.5.4` (WASM, single-file, no server) vs
PostgreSQL `16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)`, 2026-07-31.

**Result: 10/10 chains byte-identical.**

| chain | covers | verdict |
|---|---|---|
| 01-basic | serial PK, FK on delete, varchar/text, defaults, index | IDENTICAL |
| 02-enum-evolution | enum create + two `ADD VALUE` migrations | IDENTICAL |
| 03-alter-evolution | add/set-not-null/rename/drop column | IDENTICAL |
| 04-drop-recreate | drop + recreate with uuid `gen_random_uuid()` | IDENTICAL |
| 05-composite-fk | composite PK + composite FK | IDENTICAL |
| 06-identity-defaults | `GENERATED ALWAYS AS IDENTITY`, jsonb defaults | IDENTICAL |
| 07-rename | `ALTER TABLE RENAME` + follow-up column | IDENTICAL |
| 08-schemas | non-public schema, cross-schema listing | IDENTICAL |
| 09-views-excluded | view + matview must NOT appear as tables | IDENTICAL |
| 10-rls-policies | RLS enable + policy (catalog side-effects only) | IDENTICAL |

**Decision: pglite is GO; the Docker fallback is not needed** for the DDL
class the ERD consumes. The doc-11 gate ("≥10 fixture chains byte-identical
post-normalization to a real live migration run") is met on this corpus.

**Honest limits.** (1) The corpus is flyway/supabase-style *raw SQL*;
alembic/liquibase chains are programs, not SQL — replaying them means
executing repo code, which is R2 sandbox territory; their offline-SQL
export modes are candidate adapters. (2) Extensions beyond pglite's bundled
contrib set would fail replay — that failure is a named `replay-failed` gap,
never a partial catalog. (3) The deployment-baseline seed (Supabase roles +
`auth.uid()` stub) plus the missing-role retry synthesize *cluster* state;
they can never invent *schema* shape. (4) Cross-version drift (pglite
tracks one PG major) is unmeasured; re-run this corpus when pglite bumps
its embedded major.

**Reproduce.** `node replay-pglite.mjs chains/01-basic introspect.sql`
against a local cluster's `replay-real.sh chains/01-basic` (the introspect
SQL lives with the provider). The in-repo determinism gate (same chain,
double run, golden compare) runs in every CI pass via the
`replay-scenario` fixture.
