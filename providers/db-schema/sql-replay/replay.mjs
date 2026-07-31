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

const SEED = [
  "create role anon", "create role authenticated", "create role service_role",
  "create schema if not exists auth",
  "create schema if not exists extensions",
  "create function auth.uid() returns uuid language sql as 'select null::uuid'",
];

const INTROSPECT = readFileSync(new URL("./introspect.sql", import.meta.url), "utf8");

async function main() {
  const chain = chainOf();
  if (!chain) {
    process.stdout.write(JSON.stringify({ tables: [], enums: [], warnings }) + "\n");
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
  const db = new PGlite();
  for (const s of SEED) {
    try { await db.exec(s); } catch { /* pre-existing on re-entry - fine */ }
  }
  const files = orderFiles(chain);
  const made = new Set();
  for (let i = 0; i < files.length; i++) {
    const sql = readFileSync(files[i], "utf8");
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
        warnings.push({ kind: "replay-failed", file: posix(`${chain.rel}/${chain.names[i]}`) });
        process.stdout.write(JSON.stringify({ tables: [], enums: [], warnings }) + "\n");
        await db.close();
        return;
      }
    }
  }
  const r = await db.query(INTROSPECT);
  const out = r.rows[0].result;
  process.stdout.write(JSON.stringify({
    tables: out.tables ?? [], enums: out.enums ?? [], warnings,
  }) + "\n");
  await db.close();
}

await main();
