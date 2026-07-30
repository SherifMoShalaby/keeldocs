import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.js";
import { renderAll } from "../src/render.js";
import { parseDoc } from "../src/anchors.js";
import { evaluate } from "../src/drift.js";
import { factHash } from "../src/hash.js";

test("pattern rules: each class redacts with a named marker", () => {
  const cases = [
    ["ghp_" + "a".repeat(36), "github-token"],
    ["AKIAABCDEFGHIJKLMNOP", "aws-access-key"],
    ["postgres://admin:hunter2pass@db.internal:5432/app", "dsn-userinfo"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", "private-key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abc_DEF-ghi123jkl", "supabase-service-jwt"],
    ["AIza" + "B".repeat(35), "google-api-key"],
  ];
  for (const [secret, rule] of cases) {
    const { clean, redactions } = redact(`before ${secret} after`);
    assert.ok(clean.includes(`[REDACTED:${rule}]`), `${rule} marker missing: ${clean}`);
    assert.ok(!clean.includes(secret.slice(0, 24)), `${rule} secret survived`);
    assert.ok(redactions.some((r) => r.rule === rule));
  }
});

test("exemptions: keeldocs hashes and plain hex never redact", () => {
  const text = [
    "hash=h1:9b93880a5563d4cc content=h1:d0eec7b7d834739b",
    '"blob":"sha256:' + "ab12".repeat(16) + '"',
    "checksum " + "0123456789abcdef".repeat(4),
    "The quick brown fox documents `routes` calmly.",
  ].join("\n");
  const { clean, redactions } = redact(text);
  assert.equal(redactions.length, 0, JSON.stringify(redactions));
  assert.equal(clean, text);
});

test("entropy: opaque mixed tokens redact; entropy=false (machine files) skips them", () => {
  const opaque = "qA7zP2mX9vL4kR8sT1wN6bY3cJ5dF0gH_uEiOaZxWv-Q";
  const on = redact(`token: ${opaque}`);
  assert.ok(on.clean.includes("[REDACTED:high-entropy]"));
  const off = redact(`token: ${opaque}`, { entropy: false });
  assert.equal(off.redactions.length, 0);
});

test("born clean WITH redaction: secret in facts -> redacted doc -> zero drift", () => {
  const payload = { schema_version: 1, type: "table", attrs: { name: "Item",
    columns: [{ name: "api_key", type: "String", optional: false, list: false,
      attrs: '@default("AKIAABCDEFGHIJKLMNOP")' }], relations: [] } };
  const facts = new Map([["fact:db-schema/Item",
    { id: "fact:db-schema/Item", payload, hash: factHash(payload), provenance: { source: [] } }]]);
  const sink = [];
  const docs = renderAll(facts, sink);
  assert.ok(sink.some((r) => r.rule === "aws-access-key"), "sink must record the redaction");
  const dm = docs.find((d) => d.path.includes("data-model"));
  assert.ok(dm.content.includes("[REDACTED:aws-access-key]"));
  assert.ok(!dm.content.includes("AKIAABCDEFGHIJKLMNOP"));
  // the invariant: content hashes were computed AFTER redaction
  const p = parseDoc(dm.content, dm.path);
  const journal = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };
  const { findings } = evaluate({ anchors: p.anchors, regions: p.regions, factsById: facts,
    capabilities: { "db-schema": { status: "ok" } }, journal });
  assert.ok(findings.every((f) => f.state === "clean"),
    "redacted docs must be born clean: " + JSON.stringify(findings.filter((f) => f.state !== "clean")));
});
