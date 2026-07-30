// Dev utility: recompute the CORRECT hashes for fixtures/drift-scenario's clean and
// tamper cases. Run from repo root after changing the fixture app/schema.
// The tamper case stays tampered: content= records the PRISTINE body; the committed
// body deliberately differs (| email | Text | instead of | String |).
import { extractAll } from "../../src/facts.js";
import { aggregateHash } from "../../src/drift.js";
import { contentHash, display } from "../../src/hash.js";
import { readFileSync, writeFileSync } from "node:fs";

const root = "fixtures/drift-scenario";
const { factsById } = extractAll(root);

const ordersAgg = display(aggregateHash(
  ["fact:http-endpoints/GET /orders", "fact:http-endpoints/POST /orders"], factsById));
const userHash = display(factsById.get("fact:db-schema/User").hash);
const ordersBody = "\n| method | path |\n|---|---|\n| GET | /orders |\n| POST | /orders |\n";
const pristineUserBody = "\n| column | type |\n|---|---|\n| id | Int |\n| email | String |\n| role | Role |\n";

const subs = [
  ["fixtures/drift-scenario/docs/api.md",
    [["__ORDERS_AGG__", ordersAgg], ["__ORDERS_CONTENT__", display(contentHash(ordersBody))],
     [/hash=h1:[0-9a-f]{16} content=h1:[0-9a-f]{16} -->\n\| method \| path \|\n\|---\|---\|\n\| GET \| \/orders \|/, null]]],
  ["fixtures/drift-scenario/docs/data-model.md",
    [["__USER_HASH__", userHash], ["__USER_CONTENT__", display(contentHash(pristineUserBody))]]],
];
for (const [f, pairs] of subs) {
  let t = readFileSync(f, "utf8");
  for (const [a, b] of pairs) if (b !== null) t = t.replaceAll(a, b);
  writeFileSync(f, t);
}
console.log("filled:", { ordersAgg, userHash });
