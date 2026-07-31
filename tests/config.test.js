import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml, loadConfig, docPathsOf } from "../src/config.js";

test("toml subset: sections, arrays, comments, types", () => {
  const cfg = parseToml([
    "# top comment",
    "[providers]",
    'disable = ["compose", "git-log"]  # skip these',
    "[docs]",
    'dirs = ["docs", "handbook"]',
  ].join("\n"));
  assert.deepEqual(cfg, { providers: { disable: ["compose", "git-log"] },
                          docs: { dirs: ["docs", "handbook"] } });
});

test("toml is schema-strict: unknown section/key/shape/duplicate all throw", () => {
  assert.throws(() => parseToml("[nope]"), /unknown section/);
  assert.throws(() => parseToml("[docs]\nfoo = 1"), /unknown key/);
  assert.throws(() => parseToml('[docs]\ndirs = "docs"'), /array of strings/);
  assert.throws(() => parseToml('[docs]\ndirs = ["a"]\ndirs = ["b"]'), /duplicate/);
  assert.throws(() => parseToml('dirs = ["a"]'), /under a \[section\]/);
  assert.throws(() => parseToml("[docs]\ndirs = [1, 2]"), /double-quoted/);
});

test("loadConfig: defaults, unknown provider id rejected, dir traversal rejected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keeldocs-cfg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(root), { ok: true, config: { providers: { disable: [] }, docs: { dirs: ["docs"] }, live: { "dsn-env": "DATABASE_URL" } } });
  writeFileSync(join(root, "keeldocs.toml"), '[providers]\ndisable = ["not-a-provider"]\n');
  assert.match(loadConfig(root).error, /unknown provider/);
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["../outside"]\n');
  assert.match(loadConfig(root).error, /without `\.\.`/);
  writeFileSync(join(root, "keeldocs.toml"), '[providers]\ndisable = ["compose"]\n');
  assert.deepEqual(loadConfig(root).config.providers.disable, ["compose"]);
});

test("docPathsOf scans configured dirs plus README, deduped and sorted", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keeldocs-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "handbook", "sub"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# a");
  writeFileSync(join(root, "handbook", "sub", "b.md"), "# b");
  writeFileSync(join(root, "README.md"), "# r");
  assert.deepEqual(docPathsOf(root, ["docs", "handbook", "missing"]),
    ["README.md", "docs/a.md", "handbook/sub/b.md"]);
});
