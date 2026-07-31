import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectLies } from "../src/lies.js";
import { renderAll } from "../src/render.js";
import { parseDoc } from "../src/anchors.js";
import { evaluate } from "../src/drift.js";
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
