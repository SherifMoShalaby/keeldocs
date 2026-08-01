import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectLies } from "../src/lies.js";
import { renderAll, renderRegionBody, endpointsTableBody } from "../src/render.js";
import { parseDoc } from "../src/anchors.js";
import { evaluate, resolveBindIds, isCoverageSurface } from "../src/drift.js";
import { factHash } from "../src/hash.js";

function mkFacts(defs) {
  const m = new Map();
  for (const [id, type, attrs, prov] of defs) {
    const payload = { schema_version: 1, type, attrs };
    m.set(id, { id, payload, hash: factHash(payload), provenance: prov ?? { source: [{ file: "app.js" }] } });
  }
  return m;
}

function tmpRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "keeldocs-test-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test("lie-detector: each class fires; suppressions hold", (t) => {
  const root = tmpRepo({
    "app.js": "const e=require('express');const app=e();app.get('/items',()=>{});process.env.APP_PORT;",
    "package.json": JSON.stringify({ name: "x", scripts: { start: "node app.js" },
      dependencies: { express: "1", "chart.js": "1" } }),
    "README.md": [
      "See `lib/gone.js` for internals.",              // file-claim (missing)
      "Run `npm run deploy` to ship.",                  // script-claim
      "Set `GHOST_VAR` in your env.",                   // env-claim
      "[guide](docs/missing.md)",                       // link-claim
      "Call GET /api/items.",                           // route-claim + trailing period
      "Create a `.env` file first.",                    // suppressed: imperative + conventional
      "Config example: `path/to/conf.json`.",           // suppressed: placeholder
      "We render with `chart.js`.",                     // suppressed: dependency name
      "APP_PORT controls the port via env.",            // NOT a lie: read in code
    ].join("\n"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = mkFacts([["fact:http-endpoints/GET /items", "endpoint", { method: "GET", path: "/items" }]]);
  const { findings, suppressed } = detectLies({ root, docPaths: ["README.md"], factsById: facts,
    pkg: JSON.parse(require("node:fs").readFileSync(join(root, "package.json"), "utf8")) });
  const byClass = {};
  for (const f of findings) (byClass[f.class] ??= []).push(f);
  assert.deepEqual(Object.keys(byClass).sort(),
    ["env-claim", "file-claim", "link-claim", "route-claim", "script-claim"]);
  assert.equal(findings.length, 5, JSON.stringify(findings, null, 1));
  const route = byClass["route-claim"][0];
  assert.equal(route.claim, "GET /api/items"); // trailing period stripped
  assert.deepEqual(route.candidates, ["fact:http-endpoints/GET /items"]);
  assert.ok(suppressed >= 2);
  assert.ok(findings.every((f) => f.receipt && f.receipt.length > 10), "every finding carries a receipt");
});

test("lie-detector precision: doc-relative links, prose npm phrases, colon tokens", (t) => {
  const root = tmpRepo({
    "package.json": JSON.stringify({ name: "x", scripts: {} }),
    "docs/design/00-INDEX.md": [
      "[transcript](01-panel-transcript.md)",   // doc-relative neighbor - NOT a lie
      "[root doc](docs/design/02-arch.md)",     // root-relative form - NOT a lie
      "[gone](03-missing.md)",                  // missing under BOTH resolutions - lie
      "See `01-panel-transcript.md` for details.", // backticked doc-relative file - NOT a lie
      "Use the `/docs:ask` command.",           // colon token = slash-command, not a path
      "A two-package npm workspace layout.",    // prose npm phrase - NOT a script claim
      "Run `npm run ship` before tagging.",     // run-form, missing script - lie
      "Then `pnpm typecheck` must pass.",       // backticked implied-run, missing - lie
    ].join("\n"),
    "docs/design/01-panel-transcript.md": "# t",
    "docs/design/02-arch.md": "# a",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { findings } = detectLies({ root, docPaths: ["docs/design/00-INDEX.md"],
    factsById: new Map(), pkg: { name: "x", scripts: {} } });
  const claims = findings.map((f) => `${f.class}:${f.claim}`).sort();
  assert.deepEqual(claims, [
    "link-claim:03-missing.md",
    "script-claim:npm run ship",
    "script-claim:npm run typecheck",
  ], JSON.stringify(findings, null, 1));
});

// CommonJS require shim for the one readFileSync above
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("renderAll output is born clean: parse -> evaluate -> zero drift", () => {
  const facts = mkFacts([
    ["fact:http-endpoints/GET /items", "endpoint", { method: "GET", path: "/items" }],
    ["fact:http-endpoints/POST /items", "endpoint", { method: "POST", path: "/items" }],
    ["fact:db-schema/Item", "table", { name: "Item",
      columns: [{ name: "id", type: "Int", optional: false, list: false, attrs: "@id" }],
      relations: [] }],
    ["fact:db-schema/enum.Status", "enum", { name: "Status", values: ["ACTIVE", "ARCHIVED"] }],
  ]);
  const docs = renderAll(facts);
  assert.equal(docs.length, 2);
  const anchors = [], regions = [], quarantined = [];
  for (const d of docs) {
    const p = parseDoc(d.content, d.path);
    anchors.push(...p.anchors); regions.push(...p.regions); quarantined.push(...p.quarantined);
  }
  assert.equal(quarantined.length, 0, "rendered markers must parse cleanly");
  const journal = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };
  const { findings, documented } = evaluate({ anchors, regions, factsById: facts,
    capabilities: { "http-endpoints": { status: "ok" }, "db-schema": { status: "ok" } }, journal });
  assert.ok(findings.every((f) => f.state === "clean"), JSON.stringify(findings.filter((f) => f.state !== "clean")));
  assert.equal(documented.size, 4, "every fact documented by the starter docs");
});

test("renderAll is deterministic (byte-identical across calls)", () => {
  const facts = mkFacts([
    ["fact:http-endpoints/GET /b", "endpoint", { method: "GET", path: "/b" }],
    ["fact:http-endpoints/GET /a", "endpoint", { method: "GET", path: "/a" }],
  ]);
  const a = renderAll(facts).map((d) => d.content).join("\x00");
  const b = renderAll(facts).map((d) => d.content).join("\x00");
  assert.equal(a, b);
});

test("E9 precision rules: routes, globs, pipes, versions, scoped deps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-e9-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export {}");
  writeFileSync(join(root, "docs", "spec.md"), [
    "Call `/api/v1/orders` then open `/admin/drivers`.",
    "Layout lives in `/src/real.ts` and `/src/gone.ts`.",
    "Use `@acme/installed` and `@acme/missing` here.",
    "Try `pkg@1.2.3` and `fs|path|crypto` patterns.",
    "See `/components/{a,b}` for structure.",
  ].join("\n"));
  const pkg = { name: "x", dependencies: { "@acme/installed": "^1.0.0" } };
  const r = detectLies({ root, docPaths: ["docs/spec.md"], factsById: new Map(), pkg });
  const claims = r.findings.map((f) => f.claim);
  assert.ok(claims.includes("/src/gone.ts"), "missing file under a REAL top dir must still flag");
  assert.ok(claims.includes("@acme/missing"), "an uninstalled scoped package stays a finding");
  for (const fp of ["/api/v1/orders", "/admin/drivers", "@acme/installed", "pkg@1.2.3", "fs|path|crypto", "/components/{a,b}"]) {
    assert.ok(!claims.includes(fp), `must suppress: ${fp}`);
  }
  assert.ok(!claims.includes("/src/real.ts"), "existing file is clean");
});

test("E9 round 2: external curl hosts, prose links, and client-route satisfaction", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-e9b-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "spec.md"), [
    "Vision: `curl https://vision.googleapis.com/v1/images:annotate`",   // someone else's API
    "Local: `curl http://localhost:3000/api/ghost`",                     // ours, missing
    "Admin screen: `GET /admin/drivers` and `GET /admin/drivers/{id}`.", // real PAGES
    "Missing: `POST /api/v1/sos/{id}`.",                                 // truly absent
    "Node builtins ([fs|path|crypto](x)) and coords ([29.9,31.2](y)).",  // prose, not links
  ].join("\n"));
  const facts = new Map();
  for (const p of ["/admin/drivers", "/admin/drivers/[id]"]) {
    facts.set(`fact:client-routes/${p}`,
      { id: `fact:client-routes/${p}`, payload: { schema_version: 1, type: "route", attrs: { path: p } },
        provenance: { provider: "next-routes@0.3.0", source: [{ file: "app/x/page.tsx" }] } });
  }
  facts.set("fact:http-endpoints/GET /api/real",
    { id: "fact:http-endpoints/GET /api/real", payload: { schema_version: 1, type: "endpoint",
      attrs: { method: "GET", path: "/api/real" } }, provenance: { provider: "p@1", source: [] } });
  const r = detectLies({ root, docPaths: ["docs/spec.md"], factsById: facts, pkg: { name: "x" } });
  const claims = r.findings.map((f) => f.claim);
  assert.ok(claims.some((c) => c.includes("/api/v1/sos")), "a truly absent route must still flag");
  assert.ok(claims.some((c) => c.includes("/api/ghost")), "a localhost curl to a missing path must flag");
  for (const quiet of ["images:annotate", "/admin/drivers", "fs|path|crypto", "29.9,31.2"]) {
    assert.ok(!claims.some((c) => c.includes(quiet)), `must suppress: ${quiet}`);
  }
});

test("E9 round 3: a section documenting ABSENCE is right to name gone paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-e9c-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "api.md"), [
    "## Current endpoints", "",
    "`GET /api/live` and `GET /api/ghost` are served.", "",
    "### Retired Endpoints", "",
    "```", "DELETE  /api/v1/legacy/*   (all)", "```",
    "Also removed: `src/old-handler.ts`.", "",
    "## Active again", "", "See `GET /api/other`.",
  ].join("\n"));
  const facts = new Map([["fact:http-endpoints/GET /api/live",
    { id: "fact:http-endpoints/GET /api/live",
      payload: { schema_version: 1, type: "endpoint", attrs: { method: "GET", path: "/api/live" } },
      provenance: { provider: "p@1", source: [] } }]]);
  const r = detectLies({ root, docPaths: ["docs/api.md"], factsById: facts, pkg: { name: "x" } });
  const claims = r.findings.map((f) => f.claim);
  assert.ok(claims.some((c) => c.includes("/api/ghost")), "a missing route in a NORMAL section still flags");
  assert.ok(claims.some((c) => c.includes("/api/other")), "the rule ends when the next heading starts");
  assert.ok(!claims.some((c) => c.includes("/api/v1/legacy")), "a retired-endpoint listing must not flag");
  assert.ok(!claims.some((c) => c.includes("old-handler")), "nor a removed-file listing");
});

test("E9 round 4: the derived PostgREST surface is a first-class endpoint", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-e9d-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "api.md"), [
    "# Search", "",
    "Ride search is `POST /rest/v1/rpc/search_rides`.", "",
    "Legacy clients called `POST /functions/v1/search-rides`.", "",
  ].join("\n"));
  const facts = mkFacts([
    ["fact:http-endpoints/POST /rest/v1/rpc/search_rides", "endpoint",
      { method: "POST", path: "/rest/v1/rpc/search_rides" },
      { provider: "supabase-postgrest@0.3.0", source: [{ kind: "postgrest-catalog",
        from: "fact:db-schema/fn.public.search_rides(p_origin text)" }] }],
  ]);
  const claims = detectLies({ root, docPaths: ["docs/api.md"], factsById: facts, pkg: { name: "x" } })
    .findings.map((f) => f.claim);
  assert.ok(!claims.some((c) => c.includes("/rest/v1/rpc/")), "a correctly documented rpc path now verifies");
  assert.ok(claims.some((c) => c.includes("/functions/v1/search-rides")),
    "and an edge function that does not exist still flags - precision moved, recall did not");
  // a surface derived from the catalog has no line of code; the source column
  // must name the fact it came from rather than invent a file
  assert.match(endpointsTableBody(facts),
    /postgrest-catalog: `fact:db-schema\/fn\.public\.search_rides\(p_origin text\)`/);
});

test("database functions render, and the region can be regenerated", () => {
  const facts = mkFacts([
    ["fact:db-schema/public.rides", "table",
      { name: "public.rides", relations: [],
        columns: [{ name: "id", type: "int8", optional: false, list: false, attrs: "" }] }],
    ["fact:db-schema/fn.public.claim_ride(p_ride_id bigint)", "function",
      { name: "public.claim_ride", signature: "p_ride_id bigint", arguments: "p_ride_id bigint",
        returns: "boolean", kind: "function", set_returning: false, volatility: "volatile",
        language: "plpgsql", security_definer: true, body_digest: "abc123abc123" }],
    ["fact:db-schema/fn.public.search_rides(p_origin text)", "function",
      { name: "public.search_rides", signature: "p_origin text", arguments: "p_origin text",
        returns: "SETOF public.rides", kind: "function", set_returning: true, volatility: "stable",
        language: "sql", security_definer: false, body_digest: "def456def456" }],
  ]);
  const doc = renderAll(facts).find((d) => d.path === "docs/architecture/data-model.md");
  assert.match(doc.content, /## Database functions/);
  assert.match(doc.content, /`public\.claim_ride` \| `p_ride_id bigint` \| `boolean` \| volatile, plpgsql, security definer/);
  const region = parseDoc(doc.content, doc.path).regions.find((r) => r.id === "db.functions");
  assert.ok(region, "the functions region exists");
  // the module-guide class of latent bug: a region that renders but cannot be
  // regenerated is reportable-but-unrepairable, which is half a loop
  assert.equal(renderRegionBody("db.functions", resolveBindIds(region.binds, facts), facts),
    region.body.trim(), "regeneration reproduces the rendered body");
});

test("PostgREST verbs are read from the catalog, never assumed", () => {
  const facts = mkFacts([
    ["fact:db-schema/public.orders", "table",
      { name: "public.orders", relations: [],
        columns: [{ name: "id", type: "int8", optional: false, list: false, attrs: "" },
                  { name: "total", type: "numeric", optional: true, list: false, attrs: "" }] }],
    ["fact:db-schema/pk.public.orders", "pk",
      { table: "public.orders", constraint: "orders_pkey", columns: ["id"] }],
    ["fact:db-schema/view.public.open_orders", "view",
      { name: "public.open_orders", materialized: false,
        columns: [{ name: "id", type: "int8", optional: true, list: false, attrs: "" }],
        insertable: true, updatable: true, deletable: true }],
    ["fact:db-schema/view.public.order_stats", "view",
      { name: "public.order_stats", materialized: true,
        columns: [{ name: "n", type: "int8", optional: true, list: false, attrs: "" }],
        insertable: false, updatable: false, deletable: false }],
  ]);
  const doc = renderAll(facts).find((d) => d.path === "docs/architecture/data-model.md");
  // a view is a DERIVED relation - its own section, not an entity box
  assert.match(doc.content, /## Views/);
  assert.match(doc.content, /`public\.open_orders` \| view \| `id` \| GET, POST, PATCH, DELETE/);
  assert.match(doc.content, /`public\.order_stats` \| materialized \| `n` \| GET \|/,
    "a materialized view is never writable through PostgREST");
  // the primary key is its OWN fact, and it renders where a reader needs it
  assert.match(doc.content, /int8 id PK/, "the ER diagram marks keys");
  assert.match(doc.content, /\| id \| int8 \| primary key \|/, "so does the column table");
  const region = parseDoc(doc.content, doc.path).regions.find((r) => r.id === "db.views");
  assert.equal(renderRegionBody("db.views", resolveBindIds(region.binds, facts), facts),
    region.body.trim(), "the views region regenerates - reportable AND repairable");
});

test("a primary key is an attribute of a table, not a countable surface", () => {
  const facts = mkFacts([
    ["fact:db-schema/public.orders", "table", { name: "public.orders", columns: [], relations: [] }],
    ["fact:db-schema/pk.public.orders", "pk", { table: "public.orders", constraint: "p", columns: ["id"] }],
    ["fact:db-schema/view.public.v", "view",
      { name: "public.v", materialized: false, columns: [], insertable: false, updatable: false, deletable: false }],
  ]);
  const counted = [...facts.values()].filter(isCoverageSurface).map((f) => f.payload.type).sort();
  assert.deepEqual(counted, ["table", "view"],
    "a view IS an exposed surface and counts; a key is not, exactly like rls");
});
