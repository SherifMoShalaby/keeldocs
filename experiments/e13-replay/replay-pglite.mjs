// Spike: replay a chain dir in pglite, print the introspection JSON.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const introspect = readFileSync(process.argv[3], "utf8");
const db = new PGlite();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(dir, f), "utf8"));
}
const r = await db.query(introspect);
console.log(JSON.stringify(r.rows[0].result));
await db.close();
