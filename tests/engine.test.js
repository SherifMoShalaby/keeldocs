import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jcs } from "../src/jcs.js";
import { factHash, contentHash, display, hashesMatch, normalizeBody } from "../src/hash.js";
import { parseDoc, inheritBinds } from "../src/anchors.js";
import { effective } from "../src/journal.js";
import { evaluate, coverage, candidatesFor, aggregateHash } from "../src/drift.js";

// ---------- jcs ----------
test("jcs sorts keys recursively and is stable", () => {
  assert.equal(jcs({ b: 1, a: { d: true, c: null } }), '{"a":{"c":null,"d":true},"b":1}');
});
test("jcs rejects floats (ADR-003)", () => {
  assert.throws(() => jcs({ score: 0.7 }), /floats are banned/);
});

// ---------- hash ----------
test("display truncates to h1: + 16 hex; match is prefix-tolerant", () => {
  const h = factHash({ a: 1 });
  assert.match(display(h), /^h1:[0-9a-f]{16}$/);
  assert.equal(hashesMatch(display(h), h), true);
  assert.equal(hashesMatch("h2:" + h.slice(3), h), "version-mismatch");
});
test("content hash ignores trailing whitespace and outer blank lines", () => {
  assert.equal(contentHash("\n| a |  \n| b |\n\n"), contentHash("| a |\n| b |"));
  assert.equal(normalizeBody("x\r\ny"), "x\ny");
});

// ---------- anchors ----------
const DOC = `# t
<!-- keeldocs: id=api.orders recipe=erd@1 binds=fact:http-endpoints/GET /orders,fact:http-endpoints/POST /orders hash-kind=fact -->
<!-- keeldocs:gen id=api.orders.table hash=h1:00ff00ff00ff00ff content=h1:1122334455667788 -->
body
<!-- /keeldocs:gen -->
<!-- keeldocs: id=bad.unknown binds=fact:db-schema/User evil=1 -->
<!-- keeldocs: id=wild binds=fact:db-schema/* -->
<!-- keeldocs:gen id=unclosed.region hash=h1:aaaaaaaaaaaaaaaa -->
`;
test("anchor parser: spaces in binds, gen regions, wildcard, quarantine", () => {
  const p = parseDoc(DOC, "d.md");
  assert.equal(p.anchors.length, 2);
  assert.deepEqual(p.anchors[0].binds.map((b) => b.raw),
    ["fact:http-endpoints/GET /orders", "fact:http-endpoints/POST /orders"]);
  assert.equal(p.anchors[1].binds[0].wildcard, true);
  assert.equal(p.anchors[1].binds[0].prefix, "fact:db-schema/");
  assert.equal(p.regions.length, 1);
  assert.equal(p.regions[0].hash, "h1:00ff00ff00ff00ff");
  assert.equal(p.regions[0].body.trim(), "body");
  const reasons = p.quarantined.map((q) => q.reason).sort();
  assert.deepEqual(reasons, ["unclosed-gen", "unknown-key"]);
});
test("region inherits binds from longest-prefix anchor", () => {
  const p = parseDoc(DOC, "d.md");
  const binds = inheritBinds(p.regions[0], p.anchors);
  assert.equal(binds.length, 2);
});

// ---------- journal ----------
test("journal: latest-wins by at, revoke, snooze expiry at read time", () => {
  const entries = [
    { at: "2026-01-01T00:00:00Z", type: "tombstone", target: "fact:x/a" },
    { at: "2026-02-01T00:00:00Z", type: "revoke", of: "tombstone", target: "fact:x/a" },
    { at: "2026-01-01T00:00:00Z", type: "tombstone", target: "fact:x/b" },
    { at: "2026-01-01T00:00:00Z", type: "snooze", target: "s1", expires: "2026-06-01T00:00:00Z" },
    { at: "2026-01-01T00:00:00Z", type: "snooze", target: "s2", expires: "2027-01-01T00:00:00Z" },
  ];
  const eff = effective({ entries }, "2026-07-30T00:00:00Z");
  assert.equal(eff.tombstone.has("fact:x/a"), false); // revoked
  assert.equal(eff.tombstone.has("fact:x/b"), true);
  assert.equal(eff.snooze.has("s1"), false); // expired at read time
  assert.equal(eff.snooze.has("s2"), true);
});

// ---------- drift ----------
function mkFacts(defs) {
  const m = new Map();
  for (const [id, attrs] of defs) {
    const payload = { schema_version: 1, type: "t", attrs };
    m.set(id, { id, payload, hash: factHash(payload) });
  }
  return m;
}
const CAPS_OK = { "http-endpoints": { status: "ok" } };
const NO_JOURNAL = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };

test("drift: stale, clean, dead+tombstone, unresolvable are disjoint and correct", () => {
  const facts = mkFacts([
    ["fact:http-endpoints/GET /a", { p: "/a" }],
    ["fact:http-endpoints/GET /b", { p: "/b" }],
  ]);
  const anchors = [
    { id: "s.ok", binds: [{ raw: "fact:http-endpoints/GET /a", wildcard: false }], doc: "d", line: 1 },
    { id: "s.gone", binds: [{ raw: "fact:http-endpoints/DELETE /a", wildcard: false }], doc: "d", line: 2 },
    { id: "s.tomb", binds: [{ raw: "fact:http-endpoints/PUT /a", wildcard: false }], doc: "d", line: 3 },
  ];
  const staleRegion = { kind: "gen", id: "s.ok.gen", binds: [{ raw: "fact:http-endpoints/GET /a", wildcard: false }],
    hash: "h1:0000000000000000", body: "x", doc: "d", line: 4 };
  const journal = { ...NO_JOURNAL, tombstone: new Set(["fact:http-endpoints/PUT /a"]) };
  const { findings } = evaluate({ anchors, regions: [staleRegion], factsById: facts, capabilities: CAPS_OK, journal });
  const byId = Object.fromEntries(findings.map((f) => [f.id, f.state]));
  assert.equal(byId["s.ok"], "clean");
  assert.equal(byId["s.gone"], "dead");
  assert.equal(byId["s.tomb"], "intentionally_removed");
  assert.equal(byId["s.ok.gen"], "stale");
  // failed capability => unresolvable, never drift
  const failed = evaluate({ anchors: [anchors[0]], regions: [], factsById: facts,
    capabilities: { "http-endpoints": { status: "failed" } }, journal: NO_JOURNAL });
  assert.equal(failed.findings[0].state, "unresolvable");
});

test("tamper wins over stale check and fires on edited body", () => {
  const facts = mkFacts([["fact:http-endpoints/GET /a", { p: "/a" }]]);
  const bind = [{ raw: "fact:http-endpoints/GET /a", wildcard: false }];
  const cur = aggregateHash(["fact:http-endpoints/GET /a"], facts);
  const region = { kind: "gen", id: "g", binds: bind, hash: display(cur),
    content: display(contentHash("pristine")), body: "edited", doc: "d", line: 1 };
  const { findings } = evaluate({ anchors: [], regions: [region], factsById: facts,
    capabilities: CAPS_OK, journal: NO_JOURNAL });
  assert.equal(findings[0].state, "tampered");
});

// A recorded hash whose ALGORITHM this engine cannot compare used to be its own
// state, `rebaseline`: absent from DRIFT_STATES, absent from the summary, absent
// from `top`, and absent from buildProposals. Measured on one tree, one byte
// apart - `hash=h1:` reported stale and exited 1; changing that `1` to a `2`
// reported CLEAN and exited 0 over the same drifted code, and `sync` answered
// NOTHING_TO_SYNC, so there was no way back. `h[0-9]+` is what the parser
// accepts, so no future engine was needed to reach this - a badly resolved merge
// gets there today. The pair below is the whole proof, and the control matters
// as much as the case: an algorithm mismatch must not read as drift EITHER.
test("a hash algorithm the engine cannot compare is unverified, never clean", () => {
  const facts = mkFacts([["fact:http-endpoints/GET /a", { p: "/a" }]]);
  const bind = [{ raw: "fact:http-endpoints/GET /a", wildcard: false }];
  const cur = aggregateHash(["fact:http-endpoints/GET /a"], facts);
  const mk = (over) => ({ kind: "gen", id: "g", binds: bind, body: "b", doc: "d", line: 1, ...over });
  const state = (region) => evaluate({ anchors: [], regions: [region], factsById: facts,
    capabilities: CAPS_OK, journal: NO_JOURNAL }).findings[0];

  // control: the same region with a comparable, matching hash is clean...
  assert.equal(state(mk({ hash: display(cur) })).state, "clean");
  // ...and with a comparable, non-matching one it is stale. Both ends pinned, so
  // the case below cannot pass by the region simply never being evaluated.
  assert.equal(state(mk({ hash: "h1:0000000000000000" })).state, "stale");

  const bumped = "h2:" + display(cur).slice(3);
  const f = state(mk({ hash: bumped }));
  assert.equal(f.state, "unverified");
  assert.equal(f.reason, "unreadable-hash-algorithm");
  // and NOT drift: an algorithm change is not the user's code changing
  assert.notEqual(f.state, "stale");

  // the content= (tamper) comparison has the same hole and the same fix
  const c = state(mk({ hash: display(cur), content: "h2:" + display(contentHash("b")).slice(3) }));
  assert.equal(c.state, "unverified");
  assert.equal(c.reason, "unreadable-hash-algorithm");

  // a slot records the fact state its prose was written against; same hole
  const s = state(mk({ kind: "slot", hash: bumped }));
  assert.equal(s.state, "unverified");

  // the hashless case keeps its own reason, so the receipt says which it was
  assert.equal(state(mk({})).reason, "no-recorded-hash");
});

test("every unverified finding has a proposal that clears it", async () => {
  const { buildProposals } = await import("../src/proposals.js");
  const facts = mkFacts([["fact:config-surface/A", { name: "A" }]]);
  const bind = [{ raw: "fact:config-surface/A", wildcard: false }];
  const bumped = "h2:" + display(aggregateHash(["fact:config-surface/A"], facts)).slice(3);
  // config.reference.table is a region id render.js knows, so the gen proposal is
  // `regenerate` rather than the `unrenderable` fallback - a proposal that cannot
  // be applied is the dead end this test exists to refuse.
  const regions = [
    { kind: "gen", id: "config.reference.table", binds: bind, hash: bumped, body: "b", doc: "d", line: 1 },
    { kind: "slot", id: "config.reference.overview", binds: bind, hash: bumped, body: "", doc: "d", line: 2 },
  ];
  const { findings } = evaluate({ anchors: [], regions, factsById: facts,
    capabilities: { "config-surface": { status: "ok" } }, journal: NO_JOURNAL });
  assert.equal(findings.filter((f) => f.state === "unverified").length, 2);
  const props = buildProposals({ findings, regions, anchors: [], factsById: facts });
  assert.deepEqual(props.map((p) => p.kind).sort(), ["regenerate", "reprose"]);
  for (const p of props) assert.match(p.evidence, /cannot compare/);
});

test("candidates: same-method token overlap and same-path different-method", () => {
  const facts = mkFacts([
    ["fact:http-endpoints/POST /orders", {}],
    ["fact:http-endpoints/GET /users", {}],
  ]);
  assert.deepEqual(candidatesFor("fact:http-endpoints/POST /orders/{id}", facts),
    ["fact:http-endpoints/POST /orders"]);
  assert.deepEqual(candidatesFor("fact:http-endpoints/DELETE /orders", facts),
    ["fact:http-endpoints/POST /orders"]);
});

test("coverage counts wildcard-documented facts", () => {
  const facts = mkFacts([["fact:db-schema/User", {}], ["fact:db-schema/Post", {}]]);
  const anchors = [{ id: "w", binds: [{ raw: "fact:db-schema/*", wildcard: true, prefix: "fact:db-schema/" }], doc: "d", line: 1 }];
  const { documented } = evaluate({ anchors, regions: [], factsById: facts, capabilities: {}, journal: NO_JOURNAL });
  const cov = coverage(facts, documented);
  assert.equal(cov.pct, 100);
});

// ---------- engine version identity ----------
// 0.2.0-rc.4 shipped to npm with ENGINE_VERSION hardcoded to "0.2.0-dev.0", a
// string that never existed on the registry, stamped into meta.engine on every
// receipt. A tool whose claim is "your documentation is not lying to you" cannot
// misstate its own version in its own evidence. This is the gate that fails.
test("ENGINE_VERSION equals the package version", async () => {
  const { ENGINE_VERSION } = await import("../src/registry.js");
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.equal(ENGINE_VERSION, pkg.version);
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
