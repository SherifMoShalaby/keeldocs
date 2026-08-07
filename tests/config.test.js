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
  assert.deepEqual(loadConfig(root), { ok: true, config: { providers: { disable: [], "exclude-paths": [] }, docs: { dirs: ["docs"] }, live: { "dsn-env": "DATABASE_URL" }, trust: { keys: [] }, resolve: { pin: [] } } });
  writeFileSync(join(root, "keeldocs.toml"), '[providers]\ndisable = ["not-a-provider"]\n');
  assert.match(loadConfig(root).error, /unknown provider/);
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["../outside"]\n');
  assert.match(loadConfig(root).error, /without `\.\.`/);
  writeFileSync(join(root, "keeldocs.toml"), '[providers]\ndisable = ["compose"]\n');
  assert.deepEqual(loadConfig(root).config.providers.disable, ["compose"]);
});

// The WALK stays tolerant of a missing root and must: the default `["docs"]`
// applies to every repository that has no keeldocs.toml, including the one being
// run on for the first time, and a greenfield first run has to work. What used
// to be silent - and is now `loadConfig`'s job, below - is a root the USER wrote
// down that does not exist: `dirs = ["docz"]` reported CLEAN, exit 0, over the
// README alone.
test("docPathsOf scans configured dirs plus README, deduped and sorted, tolerating a missing root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keeldocs-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "handbook", "sub"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# a");
  writeFileSync(join(root, "handbook", "sub", "b.md"), "# b");
  writeFileSync(join(root, "README.md"), "# r");
  assert.deepEqual(docPathsOf(root, ["docs", "handbook", "missing"]),
    ["README.md", "docs/a.md", "handbook/sub/b.md"]);
  assert.deepEqual(docPathsOf(root, ["docs"]), ["README.md", "docs/a.md"]);
});

// The config-level half of the same defect. `docz` is not a smaller scan; it is
// a scan of something else entirely, and the tool has no way to tell the user
// that except by refusing. Same shape as an unknown provider id.
test("loadConfig refuses an explicit [docs] dirs root that is not a directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keeldocs-docsdir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "handbook"), { recursive: true });
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["handbook", "docz"]\n');
  assert.match(loadConfig(root).error, /\[docs\] dirs names `docz`/);
  writeFileSync(join(root, "docz"), "a file is not a scan root");
  assert.match(loadConfig(root).error, /not a directory/);
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["handbook"]\n');
  assert.deepEqual(loadConfig(root).config.docs.dirs, ["handbook"]);
  // the DEFAULT root is never required: no config, no docs/, still ok
  rmSync(join(root, "keeldocs.toml"));
  assert.equal(loadConfig(root).ok, true);
});
