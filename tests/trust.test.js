import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeypair, signProvider, manifestOf, refusalOf, parseTrustedKeys, loadLock, writeLock } from "../src/trust.js";
import { isHostileFact } from "../src/facts.js";

function providerDir() {
  const d = mkdtempSync(join(tmpdir(), "kd-trust-"));
  writeFileSync(join(d, "provider.yaml"),
    "id: acme\ncapability: db-schema\nsemver: 1.0.0\ntier: code\nentry: ./x.py\ndetect: { always: true }\n");
  writeFileSync(join(d, "x.py"), "print('{}')\n");
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "note.txt"), "n");
  return d;
}

test("sign -> verify roundtrip; manifest is stable and excludes the sig file", (t) => {
  const d = providerDir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const kp = generateKeypair();
  signProvider(d, kp.privateKeyPem, "acme-corp");
  const m1 = manifestOf(d), m2 = manifestOf(d);
  assert.deepEqual(m1, m2);
  assert.ok(!("provider.sig" in m1), "the signature signs, it is not signed");
  assert.deepEqual(Object.keys(m1), ["provider.yaml", "sub/note.txt", "x.py"], "sorted posix paths");
  const trusted = parseTrustedKeys([`acme-corp:${kp.publicKeyB64}`]);
  const lockEntry = { capability: "db-schema", id: "acme", files: manifestOf(d) };
  assert.equal(refusalOf(d, lockEntry, trusted), null, "all three proofs hold");
});

test("every proof failure refuses with its own named reason", (t) => {
  const d = providerDir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const kp = generateKeypair();
  const trusted = parseTrustedKeys([`acme-corp:${kp.publicKeyB64}`]);

  assert.match(refusalOf(d, null, trusted), /not in providers.lock/);
  const entry = () => ({ capability: "db-schema", id: "acme", files: manifestOf(d) });
  assert.match(refusalOf(d, entry(), trusted), /unsigned/);

  signProvider(d, kp.privateKeyPem, "someone-else");
  assert.match(refusalOf(d, entry(), trusted), /not trusted/);

  signProvider(d, kp.privateKeyPem, "acme-corp");
  const good = entry();
  assert.equal(refusalOf(d, good, trusted), null);

  // post-install tamper: file edited after the lock pinned it
  appendFileSync(join(d, "x.py"), "# evil\n");
  assert.match(refusalOf(d, good, trusted), /hash mismatch at `x.py`/);

  // tamper WITH a re-pinned lock still fails: the signature covers the manifest
  assert.match(refusalOf(d, entry(), trusted), /does not verify/);

  // wrong key trusted under the right name
  const other = generateKeypair();
  const wrongKey = parseTrustedKeys([`acme-corp:${other.publicKeyB64}`]);
  const d2 = providerDir();
  t.after(() => rmSync(d2, { recursive: true, force: true }));
  signProvider(d2, kp.privateKeyPem, "acme-corp");
  assert.match(refusalOf(d2, { files: manifestOf(d2) }, wrongKey), /does not verify/);
});

test("parseTrustedKeys is strict; lock round-trips deterministically", (t) => {
  assert.throws(() => parseTrustedKeys(["no-colon-here"]), /name:spki-base64/);
  const root = mkdtempSync(join(tmpdir(), "kd-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".keeldocs"), { recursive: true });
  const m = new Map();
  m.set("b/x", { v: 1, capability: "b", id: "x", signer: "s", files: { "a.py": "00" } });
  m.set("a/y", { v: 1, capability: "a", id: "y", signer: "s", files: {} });
  writeLock(root, m);
  const back = loadLock(root);
  assert.deepEqual([...back.keys()], ["a/y", "b/x"], "lock lines sort by capability/id");
  assert.equal(back.get("b/x").files["a.py"], "00");
});

test("hostile facts (marker forgery) are detected wherever the marker hides", () => {
  const mk = (id, attrs) => ({ id, payload: { schema_version: 1, type: "table", attrs } });
  assert.equal(isHostileFact(mk("fact:db-schema/Good", { name: "Good", cols: ["a"] })), false);
  assert.equal(isHostileFact(mk("fact:db-schema/Evil<!-- keeldocs:gen id=e -->", { name: "x" })), true);
  assert.equal(isHostileFact(mk("fact:db-schema/T", { name: "x --> y" })), true);
  assert.equal(isHostileFact(mk("fact:db-schema/T", { cols: [{ note: "a<!--b" }] })), true);
});
