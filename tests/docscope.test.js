// The scan root as a blind spot: what `[docs] dirs` does NOT cover.
//
// `docPathsOf` reads the configured roots plus README.md and nothing else, which
// is correct and was silent. Two measured consequences, both of which reported
// CLEAN with exit 0 on a repository whose documentation was wrong:
//
//   * `git mv docs handbook` - every marker still tracked, every anchor still
//     real, and the engine checking none of them.
//   * `dirs = ["docz"]` - a typo'd scan root, and because README.md is always
//     scanned the summary still read `across 1 doc(s)`, which looks like an
//     answer.
//
// The four assertions below are the gate for both, plus the two things that must
// NOT change: a greenfield first run, and fenced illustrations.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, docPathsOf, unscannedAnchoredDocs } from "../src/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Always on a COPY: `check` spills a report into `.keeldocs/out`, and a test
// that writes into the tracked fixture makes the next run depend on the last.
function fixtureCopy(t, name) {
  const root = mkdtempSync(join(tmpdir(), `kd-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, "fixtures", name), root, { recursive: true });
  return root;
}

function check(root) {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "keeldocs.js"), "check", "--json"],
    { cwd: root, encoding: "utf8" });
  return { code: r.status, env: JSON.parse(r.stdout.trim().split("\n").pop()) };
}

// (a) The defect itself. An anchored, drifted, out-of-scan-root document is not
// clean - it is unchecked - and the run has to say so and name the file.
test("an anchored doc outside every scan root exits non-zero and is named", (t) => {
  const root = fixtureCopy(t, "scanroot-scenario");
  const { code, env } = check(root);
  assert.equal(code, 1, "a repository retired from drift detection must not exit 0");
  assert.equal(env.code, "UNREADABLE", "not checked is not the same as clean");
  assert.deepEqual(env.data.unscanned, [{ doc: "handbook/api.md", anchors: 1, regions: 1 }]);
  assert.match(env.summary, /handbook\/api\.md/, "a count nobody can act on is not a finding");
});

// The control that makes (a) non-vacuous: the SAME tree, with `handbook`
// declared, is not merely readable - it is DRIFTING. Without this, the assertion
// above could pass against a document that had nothing to say.
test("the same doc, once inside a scan root, reports the drift it was hiding", (t) => {
  const root = fixtureCopy(t, "scanroot-scenario");
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["handbook"]\n');
  const { code, env } = check(root);
  assert.equal(code, 1);
  assert.equal(env.code, "DRIFT_FOUND", `expected the hidden drift to surface, got ${env.code}`);
  assert.ok(env.data.counts.driftTotal > 0, "the fixture must actually be lying");
  assert.equal(env.data.unscanned, undefined, "nothing is out of scope once handbook is a root");
});

// (b) A scan root the user wrote down and that does not exist. Same precedent as
// an unknown provider id in [providers] disable: it names something unreadable,
// so it is a CONFIG error at exit 2 rather than a quieter run.
test("an explicit [docs] dirs entry that does not exist is a CONFIG error, exit 2", (t) => {
  const root = fixtureCopy(t, "scanroot-scenario");
  writeFileSync(join(root, "README.md"), "# scanroot\n");
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["docz"]\n');
  const { code, env } = check(root);
  assert.equal(code, 2, "a typo'd scan root used to exit 0 CLEAN across 1 doc(s)");
  assert.equal(env.code, "CONFIG");
  assert.match(env.summary, /docz/);

  // a FILE by that name is not a scan root either
  writeFileSync(join(root, "docz"), "not a directory\n");
  assert.match(loadConfig(root).error, /not a directory/);

  // the traversal rule still answers first, and with its own message
  writeFileSync(join(root, "keeldocs.toml"), '[docs]\ndirs = ["../outside"]\n');
  assert.match(loadConfig(root).error, /without `\.\.`/);
});

// (c) First run must be untouched: no docs/, no keeldocs.toml, no anchors. The
// DEFAULT root is optional precisely because this is the first thing anyone does
// with the tool; only a root the file names is enforced.
test("a greenfield repo with no docs, no config and no anchors is still CLEAN, exit 0", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-greenfield-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{ "name": "greenfield", "private": true }\n');
  writeFileSync(join(root, "index.js"), "module.exports = {};\n");
  const { code, env } = check(root);
  assert.equal(code, 0, `first run must not fail: ${env.summary}`);
  assert.equal(env.code, "CLEAN");
  assert.equal(loadConfig(root).ok, true, "the default ['docs'] root is not required to exist");
});

// (d) The sweep reuses the anchor parser, so fence masking comes with it. A
// vendored README that DOCUMENTS an anchor inside a code fence is an
// illustration, not structure - and a sweep that flagged those would fire on
// this repository's own README, CLAUDE.md and SKILL.md and be switched off.
test("markers inside fences and prose are illustrations, not unscanned documents", (t) => {
  const root = fixtureCopy(t, "scanroot-scenario");
  const { env } = check(root);
  assert.ok(!env.data.unscanned.some((u) => u.doc === "vendor/EXAMPLES.md"),
    "a fenced anchor in a vendored README must never be reported");

  // and the same three shapes this repository itself carries in prose
  const bare = mkdtempSync(join(tmpdir(), "kd-fences-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  mkdirSync(join(bare, "notes"), { recursive: true });
  writeFileSync(join(bare, "notes", "inline.md"),
    "Never hand-edit between `<!-- keeldocs:gen -->` markers - regenerate.\n");
  writeFileSync(join(bare, "notes", "fenced.md"),
    "```\n<!-- keeldocs: id=x binds=fact:http-endpoints/GET /a hash-kind=fact -->\n```\n");
  writeFileSync(join(bare, "notes", "real.md"),
    "<!-- keeldocs: id=x binds=fact:http-endpoints/GET /a hash-kind=fact -->\n");
  assert.deepEqual(unscannedAnchoredDocs(bare, docPathsOf(bare, ["docs"]), []),
    [{ doc: "notes/real.md", anchors: 1, regions: 0 }]);

  // the user's path scope is honoured: an excluded tree is a declared blind spot
  assert.deepEqual(unscannedAnchoredDocs(bare, docPathsOf(bare, ["docs"]), ["notes/**"]), []);
});
