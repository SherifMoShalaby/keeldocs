import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { permissionManifest, renderManifest, enforcementOf } from "../src/permissions.js";

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "kd-perm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const MANIFEST = (inputs, extra = "") =>
  "id: acme-schema\ncapability: db-schema\nsemver: 1.0.0\ntier: code\n" +
  "entry: ./extract.py\ndetect: { files: [\"acme.schema\"] }\n" +
  `inputs: ${inputs}\ntimeout_class: A\nemits: [table]\n${extra}`;

test("the manifest reports what the provider will really receive, from THIS repo", (t) => {
  const root = repo(t, {
    "p/provider.yaml": MANIFEST('["**/*.schema", "src/**/*.ts"]'),
    "p/extract.py": "print('{}')",
    "acme.schema": "gadget", "src/a.ts": "x", "src/b.ts": "y", "README.md": "hi",
  });
  const m = permissionManifest(root, join(root, "p"));
  assert.equal(m.id, "acme-schema");
  assert.equal(m.reads.matched, 3, "two ts files and one schema - not the README it never asked for");
  assert.ok(!m.reads.sample.includes("README.md"));
  assert.equal(m.network, "denied");
  assert.deepEqual(m.emits, ["table"]);
  assert.equal(m.runtime, "python");
});

test("a provider asking for the world is SHOWN what it will not get", (t) => {
  const root = repo(t, {
    "p/provider.yaml": MANIFEST('["**/*"]'),
    "p/extract.py": "print('{}')",
    "src/a.ts": "x", ".env": "DB_PASSWORD=hunter2", ".env.example": "DB_PASSWORD=",
    "certs/tls.pem": "-----BEGIN",
  });
  const m = permissionManifest(root, join(root, "p"));
  assert.ok(m.withheld.sample.includes(".env") && m.withheld.sample.includes("certs/tls.pem"),
    "the concrete file, by path - not a description of a rule");
  assert.ok(!m.reads.sample.includes(".env"));
  assert.ok(m.reads.sample.includes(".env.example"),
    "the example form is how a provider legitimately learns a variable exists");
  assert.match(renderManifest(m), /WITHHELD\s+2 matching file\(s\) are secrets/);
});

test("a whole-directory grant is called out separately from a file list", (t) => {
  const root = repo(t, {
    "p/provider.yaml": MANIFEST('[".git/"]'),
    "p/extract.py": "print('{}')",
    ".git/HEAD": "ref: refs/heads/main", "src/a.ts": "x",
  });
  const m = permissionManifest(root, join(root, "p"));
  assert.deepEqual(m.reads.dirs, [".git"]);
  assert.match(renderManifest(m), /WHOLE DIR \.git\s+<- an entire tree, not a file list/);
});

test("declared cross-capability fact reads are disclosed, not silently granted", (t) => {
  const root = repo(t, {
    "p/provider.yaml": MANIFEST('["${facts:db-schema}", "supabase/config.toml"]'),
    "p/extract.py": "print('{}')",
    "supabase/config.toml": "[api]",
  });
  const m = permissionManifest(root, join(root, "p"));
  assert.deepEqual(m.factReads, ["db-schema"]);
  assert.deepEqual(m.reads.globs, ["supabase/config.toml"], "a facts token is not a repository path");
  assert.match(renderManifest(m), /ALSO GETS resolved facts from: db-schema/);
});

test("an unsigned provider says so; network intent is disclosed", (t) => {
  const root = repo(t, {
    "p/provider.yaml": MANIFEST('["**/*.schema"]', "requires: [\"network:db\"]\n"),
    "p/extract.py": "print('{}')", "acme.schema": "x",
  });
  const m = permissionManifest(root, join(root, "p"));
  assert.equal(m.trust.signed, false);
  assert.equal(m.trust.proof, "unsigned");
  assert.match(m.network, /network:db/);
  assert.match(renderManifest(m), /TRUST\s+UNSIGNED/);
});

test("enforcement is stated, never implied - a live provider is not scoped", () => {
  const live = enforcementOf(true);
  assert.equal(live.enforced, false);
  assert.match(live.detail, /reads a database, not the repository/);
  const normal = enforcementOf(false);
  assert.ok(["minimal-root", "per-glob", "network-only", "none"].includes(normal.level));
  // whichever tier this host has, the rendering must not claim more than it does
  assert.equal(normal.enforced, ["minimal-root", "per-glob"].includes(normal.level));
});
