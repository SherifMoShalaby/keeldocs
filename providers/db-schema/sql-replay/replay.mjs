// sql-replay - the migration-replay engine (design §db-schema, doc 11 R1).
// Replays a repo's SQL migration chain IN ORDER against an ephemeral
// in-process Postgres (pglite/WASM; E13 measured 10/10 chains byte-identical
// to real PostgreSQL 16), then introspects the CATALOG - so db facts come
// from what the migrations actually build, not from parsing their text.
//
// Honesty rules:
// - zero chains       -> {tables:[], enums:[]} and pglite is never imported
// - unreplayable file -> ZERO facts + a replay-failed gap (a partial catalog
//   would lie); the engine stays fail-closed for crashes, gap-honest for
//   semantic can't-replay
// - multiple candidate dirs -> replay the FIRST (priority order below),
//   name the ignored ones as gaps
//
// Deployment baseline: migrations legitimately assume cluster state their
// chain never creates (Supabase roles, auth.uid()). A deterministic seed
// provides the standard Supabase baseline, and a missing-role error retries
// once per role after synthesizing it (shape extraction, not privilege
// truth - roles carry no columns). Determinism: fixed seed, ordered files,
// ordered introspection, no wall clock.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const warnings = [];
const posix = (p) => p.split("\\").join("/");

// ---------- chain discovery (pure fs; runs on every repo) ----------

const CANDIDATES = [
  "supabase/migrations", "migrations", "db/migrations", "db/migration",
  "sql/migrations",
];

function sqlFilesIn(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sql"));
  } catch { return []; }
}

function chainOf() {
  const found = [];
  for (const rel of CANDIDATES) {
    const dir = join(root, rel);
    const files = sqlFilesIn(dir);
    if (files.length) found.push({ rel, files: files.map((f) => join(dir, f)), names: files });
  }
  // prisma layout: migrations/<stamp>_<name>/migration.sql, ordered by dir name
  const pdir = join(root, "prisma", "migrations");
  if (existsSync(pdir)) {
    const subs = readdirSync(pdir).sort().filter((d) => {
      try { return statSync(join(pdir, d)).isDirectory() && existsSync(join(pdir, d, "migration.sql")); }
      catch { return false; }
    });
    if (subs.length) {
      found.push({ rel: "prisma/migrations", prismaOrdered: true,
        files: subs.map((d) => join(pdir, d, "migration.sql")), names: subs });
    }
  }
  if (!found.length) return null;
  for (const ignored of found.slice(1)) {
    warnings.push({ kind: "chain-ignored", file: posix(ignored.rel) });
  }
  return found[0];
}

// flyway V-numbers sort numerically (V10 after V2); everything else
// lexicographic (timestamps and 0001-prefixes already sort right)
function orderFiles(chain) {
  if (chain.prismaOrdered) return chain.files; // already dir-name ordered
  const key = (f) => {
    const base = f.slice(f.lastIndexOf("/") + 1).slice(f.lastIndexOf("\\") + 1);
    const m = base.match(/^V(\d+)(?:_\d+)*__/i);
    return m ? [0, parseInt(m[1], 10), base] : [1, 0, base];
  };
  return [...chain.files].sort((a, b) => {
    const [ga, na, sa] = key(a), [gb, nb, sb] = key(b);
    return ga - gb || na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
}

// ---------- deterministic deployment baseline ----------
//
// Seed-owned schemas (auth, storage, cron, extensions) are EXCLUDED from
// introspection: their tables here are shape STUBS so chains parse - emitting
// a stub's column list as extracted truth would lie about supabase infra.

const SEED = [
  "create role anon", "create role authenticated", "create role service_role",
  "create schema if not exists auth",
  "create schema if not exists extensions",
  "create function auth.uid() returns uuid language sql as 'select null::uuid'",
  // storage baseline (E9 field finding): functions/policies legitimately read
  // and delete from storage.objects; a shape stub keeps the chain replayable
  // auth.users shape stub (E9): FKs and signup triggers legitimately point at
  // it; PK included so REFERENCES auth.users(id) resolves. Not public schema,
  // so it never enters the emitted catalog (introspection filters to
  // non-system schemas but auth IS emitted... it is not: policies/tables in
  // auth are real supabase infra, and the ERD filter keeps table facts as-is -
  // auth.users appears as a table fact only if introspection includes it,
  // which it does; declared-beats-replayed does not apply. Accepted: an
  // auth.users row in the ERD is TRUE for a supabase app.
  "create table if not exists auth.users (id uuid primary key, email text, phone text, raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz, last_sign_in_at timestamptz)",
  "create schema if not exists storage",
  "create table if not exists storage.objects (id uuid, bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz)",
];

// pglite's BUNDLED contrib set (dist/contrib/*): these load for real, so their
// CREATE EXTENSION statements succeed natively. Anything else is stubbed.
const CONTRIB = new Set(["amcheck", "auto_explain", "bloom", "btree_gin",
  "btree_gist", "citext", "cube", "dict_int", "dict_xsyn", "earthdistance",
  "file_fdw", "fuzzystrmatch", "hstore", "intarray", "isn", "lo", "ltree",
  "pageinspect", "pg_buffercache", "pg_freespacemap", "pg_stat_statements",
  "pg_surgery", "pg_trgm", "pg_visibility", "pg_walinspect", "pgcrypto",
  "seg", "tablefunc", "tcn", "tsm_system_rows", "tsm_system_time",
  "unaccent", "uuid_ossp"]);

// Shape stubs for extensions that carry CATALOG-visible surface but are not
// in the WASM bundle (E9 field finding: real supabase chains lean on all
// three). Stubs preserve table SHAPE; they never fake runtime behavior.
const EXT_STUBS = {
  moddatetime: [ // both spellings: supabase installs it WITH SCHEMA extensions
    "create or replace function moddatetime() returns trigger language plpgsql as $kd$ begin return new; end $kd$",
    "create or replace function extensions.moddatetime() returns trigger language plpgsql as $kd$ begin return new; end $kd$",
  ],
  pg_cron: [
    "create schema if not exists cron",
    "create function cron.schedule(text, text, text) returns bigint language sql as 'select 1::bigint'",
    "create function cron.schedule(text, text) returns bigint language sql as 'select 1::bigint'",
    "create function cron.unschedule(text) returns boolean language sql as 'select true'",
    "create function cron.unschedule(bigint) returns boolean language sql as 'select true'",
  ],
  postgis: [
    // typmods are stripped in preprocess (domains cannot carry them); the
    // introspected column type is still truthfully named geography/geometry.
    // Function stubs cover the family real chains call in generated columns,
    // constraints, and helper functions (E9 field finding); shape-neutral -
    // they exist so DDL parses, never to fake spatial math.
    "create domain geography as bytea",
    "create domain geometry as bytea",
    "create function st_x(geometry) returns double precision language sql as 'select 0::double precision'",
    "create function st_y(geometry) returns double precision language sql as 'select 0::double precision'",
    "create function st_x(geography) returns double precision language sql as 'select 0::double precision'",
    "create function st_y(geography) returns double precision language sql as 'select 0::double precision'",
    "create function st_makepoint(double precision, double precision) returns geometry language sql as 'select ''::bytea::geometry'",
    "create function st_setsrid(geometry, integer) returns geometry language sql as 'select $1'",
    "create function st_point(double precision, double precision) returns geometry language sql as 'select ''::bytea::geometry'",
    "create function st_dwithin(geography, geography, double precision) returns boolean language sql as 'select true'",
    "create function st_distance(geography, geography) returns double precision language sql as 'select 0::double precision'",
    "create function st_geogfromtext(text) returns geography language sql as 'select ''::bytea::geography'",
    "create function st_geographyfromtext(text) returns geography language sql as 'select ''::bytea::geography'",
    "create function st_asgeojson(geography) returns text language sql as 'select ''::text'",
    "create function st_astext(geography) returns text language sql as 'select ''::text'",
    "create function extensions.st_x(geometry) returns double precision language sql as 'select 0::double precision'",
    "create function extensions.st_y(geometry) returns double precision language sql as 'select 0::double precision'",
    "create function extensions.st_x(geography) returns double precision language sql as 'select 0::double precision'",
    "create function extensions.st_y(geography) returns double precision language sql as 'select 0::double precision'",
    "create function extensions.st_makepoint(double precision, double precision) returns geometry language sql as 'select ''::bytea::geometry'",
    "create function extensions.st_setsrid(geometry, integer) returns geometry language sql as 'select $1'",
    "create function extensions.st_point(double precision, double precision) returns geometry language sql as 'select ''::bytea::geometry'",
    "create function extensions.st_dwithin(geography, geography, double precision) returns boolean language sql as 'select true'",
    "create function extensions.st_distance(geography, geography) returns double precision language sql as 'select 0::double precision'",
    "create function extensions.st_geogfromtext(text) returns geography language sql as 'select ''::bytea::geography'",
    "create function extensions.st_geographyfromtext(text) returns geography language sql as 'select ''::bytea::geography'",
    "create function extensions.st_asgeojson(geography) returns text language sql as 'select ''::text'",
    "create function extensions.st_astext(geography) returns text language sql as 'select ''::text'",
  ],
};

const extRe = /create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_-]+)"?[^;]*;/gi;

function scanExtensions(texts) {
  const names = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(extRe)) names.add(m[1].toLowerCase().replace(/-/g, "_"));
  }
  return names;
}

// strip CREATE EXTENSION statements for unavailable extensions; when postgis
// is stubbed, also strip typmods so the domain stubs can carry the columns
function preprocess(sql, stubbed) {
  let out = sql.replace(extRe, (stmt, name) =>
    stubbed.has(name.toLowerCase().replace(/-/g, "_")) ? "-- [keeldocs] stubbed: " + stmt.replace(/\n/g, " ").slice(0, 60) : stmt);
  if (stubbed.has("postgis")) {
    out = out.replace(/(geography|geometry)\s*\([^)]*\)/gi, "$1");
    // GIST indexes over the domain stubs have no opclass; indexes carry
    // no ERD surface (tables/columns/FKs/enums), so stripping is shape-neutral
    out = out.replace(/create\s+(?:unique\s+)?index[^;]*using\s+gist[^;]*;/gis,
      "-- [keeldocs] stubbed gist index (postgis unavailable);");
  }
  return out;
}

const INTROSPECT = readFileSync(new URL("./introspect.sql", import.meta.url), "utf8");

// Seed and extension stubs create routines in `public` - an unqualified CREATE
// FUNCTION has no other home - so the schema filter alone cannot keep them out
// of the emitted catalog, and a stub masquerading as an extracted function is
// exactly the lie the seed-schema exclusion exists to prevent. This baseline is
// taken AFTER seeding and BEFORE the chain runs; a routine is dropped only when
// BOTH its signature and its body digest are unchanged, so a chain that
// legitimately CREATE OR REPLACEs a stubbed name still reports its own version.
const BASELINE = `select coalesce(json_agg(json_build_object(
    'k', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'd', substr(md5(coalesce(p.prosrc, '')), 1, 12)) order by 1), '[]'::json) as result
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prokind in ('f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')`;

const fnKey = (f) => `${f.name}(${f.signature})`;

const emptyOut = () => JSON.stringify({ tables: [], enums: [], functions: [], warnings }) + "\n";

async function main() {
  const chain = chainOf();
  if (!chain) {
    process.stdout.write(emptyOut());
    return;
  }
  let PGlite;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    // a chain exists but the runtime doesn't - loud, with the fix in hand
    process.stderr.write("sql-replay: @electric-sql/pglite is not installed (npm install restores it; it ships as an optionalDependency of keeldocs)\n");
    process.exit(1);
  }
  const files = orderFiles(chain);
  const rawTexts = files.map((f) => readFileSync(f, "utf8"));
  // extension reality (E9): load what the bundle has, stub what it lacks
  const wanted = scanExtensions(rawTexts);
  const extensions = {};
  const stubbed = new Set();
  for (const name of [...wanted].sort()) {
    if (CONTRIB.has(name)) {
      try {
        const mod = await import(`@electric-sql/pglite/contrib/${name}`);
        extensions[name] = mod[name];
        continue;
      } catch { /* fall through to stub */ }
    }
    stubbed.add(name);
    warnings.push({ kind: "extension-stubbed", file: name });
  }
  const db = new PGlite(Object.keys(extensions).length ? { extensions } : undefined);
  for (const s of SEED) {
    try { await db.exec(s); } catch { /* pre-existing on re-entry - fine */ }
  }
  for (const name of [...stubbed].sort()) {
    for (const stub of EXT_STUBS[name] ?? []) {
      try { await db.exec(stub); } catch { /* stub collision - fine */ }
    }
  }
  const baseline = new Map(
    ((await db.query(BASELINE)).rows[0].result ?? []).map((b) => [b.k, b.d]));
  const texts = rawTexts.map((t) => preprocess(t, stubbed));
  const made = new Set();
  for (let i = 0; i < files.length; i++) {
    const sql = texts[i];
    let retries = 10;
    for (;;) {
      try {
        await db.exec("begin");
        await db.exec(sql);
        await db.exec("commit");
        break;
      } catch (err) {
        try { await db.exec("rollback"); } catch { /* txn already gone */ }
        const m = String(err.message).match(/role "([^"]+)" does not exist/);
        if (m && retries-- > 0 && !made.has(m[1])) {
          made.add(m[1]);
          try { await db.exec(`create role "${m[1]}"`); } catch { /* raced/reserved */ }
          continue; // whole file rolled back -> safe to retry
        }
        // unreplayable: zero facts + a named gap - never a partial catalog
        warnings.push({ kind: "replay-failed", file: posix(`${chain.rel}/${chain.names[i]}`),
          detail: String(err.message).replace(/\s+/g, " ").slice(0, 140) });
        process.stdout.write(emptyOut());
        await db.close();
        return;
      }
    }
  }
  const r = await db.query(INTROSPECT);
  const out = r.rows[0].result;
  const functions = (out.functions ?? [])
    .filter((f) => baseline.get(fnKey(f)) !== f.body_digest);
  // views/matviews are a real PostgREST surface this version does not model;
  // naming each one keeps "unmodeled" from reading as "not there"
  for (const v of out.views ?? []) warnings.push({ kind: "view-unmodeled", file: v });
  process.stdout.write(JSON.stringify({
    tables: out.tables ?? [], enums: out.enums ?? [], functions, warnings,
  }) + "\n");
  await db.close();
}

await main();
