import test from "node:test";
import assert from "node:assert/strict";
import { ownershipIndex, resolvePackageBind } from "../src/ownership.js";
import { parseDoc } from "../src/anchors.js";
import { resolveBindIds } from "../src/drift.js";
import { factHash } from "../src/hash.js";

function mkFacts(defs) {
  const m = new Map();
  for (const [id, type, attrs, source] of defs) {
    const payload = { schema_version: 1, type, attrs };
    m.set(id, { id, payload, hash: factHash(payload),
      provenance: { provider: "p@1", source: source ?? [] } });
  }
  return m;
}

const MONO = () => mkFacts([
  ["fact:workspace-layout/@acme/web", "package", { name: "@acme/web", path: "packages/web", manager: "npm" }],
  ["fact:workspace-layout/@acme/api", "package", { name: "@acme/api", path: "packages/api", manager: "npm" }],
  ["fact:http-endpoints/GET /web/home", "endpoint", { method: "GET", path: "/web/home" },
    [{ file: "packages/web/src/app.js", line: 3 }]],
  ["fact:http-endpoints/GET /api/orders", "endpoint", { method: "GET", path: "/api/orders" },
    [{ file: "packages/api/src/server.js", line: 3 }]],
  // no file provenance: a replayed table belongs to no JS package
  ["fact:db-schema/public.orders", "table", { name: "public.orders", columns: [], relations: [] },
    [{ kind: "migration-replay" }]],
  // sources spanning two packages: owned by BOTH, which is the true statement
  ["fact:http-endpoints/POST /shared", "endpoint", { method: "POST", path: "/shared" },
    [{ file: "packages/web/src/x.js" }, { file: "packages/api/src/y.js" }]],
]);

test("ownership is derived from provenance, per package, longest prefix", () => {
  const facts = MONO();
  const idx = ownershipIndex(facts);
  assert.deepEqual([...idx.get("fact:http-endpoints/GET /web/home")], ["@acme/web"]);
  assert.deepEqual([...idx.get("fact:http-endpoints/GET /api/orders")], ["@acme/api"]);
  assert.equal(idx.get("fact:db-schema/public.orders"), undefined,
    "a fact with no file provenance belongs to no package - a table is not owned by a workspace");
  assert.deepEqual([...idx.get("fact:http-endpoints/POST /shared")].sort(),
    ["@acme/api", "@acme/web"], "a fact whose sources span packages belongs to both");
});

test("a package bind resolves to that package's facts of that capability only", () => {
  const facts = MONO();
  const idx = ownershipIndex(facts);
  assert.deepEqual(resolvePackageBind({ pkg: "@acme/web", capability: "http-endpoints" }, facts, idx),
    ["fact:http-endpoints/GET /web/home", "fact:http-endpoints/POST /shared"]);
  assert.deepEqual(resolvePackageBind({ pkg: "@acme/web", capability: "db-schema" }, facts, idx), [],
    "capability filters independently of ownership");
  assert.deepEqual(resolvePackageBind({ pkg: "@acme/nope", capability: "http-endpoints" }, facts, idx), [],
    "an unknown package resolves to nothing, never to everything");
});

test("the bind grammar accepts pkg: scopes with slashes in the name", () => {
  const doc = [
    "# G",
    "<!-- keeldocs: id=mod.web recipe=module-guide@1 binds=fact:workspace-layout/@acme/web hash-kind=fact -->",
    "<!-- keeldocs:gen id=mod.web.surface binds=pkg:@acme/web#http-endpoints/* hash=h1:6c8d379b965fdfa2 content=h1:4d1c45bc1d80256a -->",
    "x",
    "<!-- /keeldocs:gen -->",
  ].join("\n");
  const { regions, quarantined } = parseDoc(doc, "d.md");
  assert.equal(quarantined.length, 0, "a scoped npm name must not quarantine the region");
  const b = regions.find((r) => r.id === "mod.web.surface").binds[0];
  assert.equal(b.kind, "package");
  assert.equal(b.pkg, "@acme/web");
  assert.equal(b.capability, "http-endpoints");
  assert.equal(b.wildcard, true, "it names a SET - drift fires when any member changes");
});

test("a malformed package bind is rejected, not silently treated as a prefix", () => {
  for (const bad of ["pkg:@acme/web#http-endpoints", "pkg:#http-endpoints/*", "pkg:web#Bad Cap/*"]) {
    const doc = `<!-- keeldocs: id=a recipe=r@1 binds=${bad} hash-kind=fact -->`;
    const { anchors, quarantined } = parseDoc(doc, "d.md");
    assert.equal(anchors.length, 0, `${bad} must not parse as an anchor`);
    assert.equal(quarantined[0].reason, "bad-binds");
  }
});

test("the resolver reaches package binds through the normal bind path", () => {
  const facts = MONO();
  const binds = [{ raw: "pkg:@acme/api#http-endpoints/*", wildcard: true, prefix: null,
                   kind: "package", pkg: "@acme/api", capability: "http-endpoints" }];
  assert.deepEqual(resolveBindIds(binds, facts),
    ["fact:http-endpoints/GET /api/orders", "fact:http-endpoints/POST /shared"]);
});
