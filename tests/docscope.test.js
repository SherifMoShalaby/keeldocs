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

// One anchored document, used at every placement below. Its anchor binds facts
// no fixture here produces and its gen region records a hash nothing can match,
// so wherever the engine actually READS it the verdict is drift. That is what
// makes "checked" distinguishable from "skipped" rather than from "clean".
const ANCHORED = `# Reference

## Orders

<!-- keeldocs: id=api.orders binds=fact:http-endpoints/GET /orders hash-kind=fact -->

<!-- keeldocs:gen id=api.orders.table binds=fact:http-endpoints/GET /orders hash=h1:0000000000000000 -->
| method | path |
|---|---|
| GET | /orders |
<!-- /keeldocs:gen -->
`;

// A repository built from a map of path -> contents, plus the two files every
// case needs: a plain README (always scanned, so `across N doc(s)` is never
// zero) and a package.json.
function repoWith(t, files, toml = null) {
  const root = mkdtempSync(join(tmpdir(), "kd-skipset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "notes.md"), "# notes\n\nprose, no anchors.\n");
  writeFileSync(join(root, "README.md"), "# skipset\n");
  writeFileSync(join(root, "package.json"), '{ "name": "skipset", "private": true }\n');
  if (toml) writeFileSync(join(root, "keeldocs.toml"), toml);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const docsIn = (env) => (env.data.top ?? []).map((f) => f.doc);

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

  // And the shape that assertion missed on its first draft. With NO
  // keeldocs.toml, `loadConfig` returns before it validates anything, so the
  // check above cannot see whether the rule is explicit-only - it passed
  // unchanged against a mutation that enforced the DEFAULT root too. A config
  // that exists and simply says nothing about [docs] is an ordinary repository
  // and the only place that distinction is observable.
  writeFileSync(join(root, "keeldocs.toml"), '[providers]\ndisable = ["compose"]\n');
  assert.equal(loadConfig(root).ok, true,
    "a keeldocs.toml that never mentions [docs] must not make the default root mandatory");
  const withCfg = check(root);
  assert.equal(withCfg.code, 0, `a configured repo with no docs/ must still run: ${withCfg.env.summary}`);
  assert.equal(withCfg.env.code, "CLEAN");
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

  // ...and declared is not the same as invisible. The scope still wins - the
  // finding list above is empty - but the anchored document it suppressed is
  // named, because `exclude-paths` is written to keep fixtures out of the FACTS
  // and a pattern like `**/*.md` switches this sweep off having excluded no code
  // at all.
  const declared = [];
  assert.deepEqual(unscannedAnchoredDocs(bare, docPathsOf(bare, ["docs"]), ["notes/**"], null, declared), []);
  assert.deepEqual(declared, [{ doc: "notes/real.md", anchors: 1, regions: 0 }]);
});

// ---------------------------------------------------------------------------
// The engine's internal skip set as the boundary of a user-facing guarantee.
//
// `docPathsOf` carried a hand-copied subset of the provider skip set while
// recursing INSIDE a directory the user had written into `[docs] dirs`, and the
// unscanned sweep inherited the whole of it. Measured on the tree `0.4.2`
// shipped from, with one anchored, drifting document and nothing else changed:
//
//   docs/reference.md          exit 1  DRIFT_FOUND, named
//   docs/golden/reference.md   exit 0  CLEAN, `across 1 doc(s)`, empty top
//   docs/node_modules/…        exit 0  CLEAN
//   docs/.keeldocs/…           exit 0  CLEAN
//   golden|dist|coverage|node_modules/reference.md, outside every root:
//                              exit 0  CLEAN, nothing in data.unscanned
//
// Same bytes, same anchors, four verdicts decided by a directory NAME the user
// never wrote down. The four tests below are that gate.

// (e) Inside a root the user named, nothing is skipped in silence. `golden`,
// `dist` and `coverage` are the user's own tree - test data and build output are
// things a repository documents - and a nested `.keeldocs` is an ordinary
// directory. All of them are read.
test("inside a configured scan root, a doc under an engine-skipped name is checked", (t) => {
  const root = repoWith(t, {
    "docs/golden/reference.md": ANCHORED,
    "docs/.keeldocs/reference.md": ANCHORED,
    "docs/dist/reference.md": ANCHORED,
    "docs/coverage/reference.md": ANCHORED,
  }, '[docs]\ndirs = ["docs"]\n');
  const { code, env } = check(root);
  assert.equal(code, 1, `a scan root the user wrote down must be read to the bottom: ${env.summary}`);
  assert.equal(env.code, "DRIFT_FOUND");
  for (const doc of ["docs/golden/reference.md", "docs/.keeldocs/reference.md",
                     "docs/dist/reference.md", "docs/coverage/reference.md"]) {
    assert.ok(docsIn(env).includes(doc), `${doc} is inside the scan root and was not checked`);
  }
  assert.equal(env.data.unscanned, undefined, "these are scanned, not swept");
});

// The control that makes (e) non-vacuous, and it is the whole argument that this
// was an artefact rather than a decision: the SAME bytes at docs/reference.md
// always drifted, and pointing `dirs` straight at docs/golden always read it -
// the skip applied to the recursion, never to the root itself. If the fixture's
// anchor ever stopped being dead, both of these go green-and-wrong and (e)'s
// pass would mean nothing.
test("the same bytes drift at docs/reference.md, and under `dirs = [\"docs/golden\"]`", (t) => {
  const plain = repoWith(t, { "docs/reference.md": ANCHORED }, '[docs]\ndirs = ["docs"]\n');
  const a = check(plain);
  assert.equal(a.code, 1, `the fixture must actually be lying: ${a.env.summary}`);
  assert.equal(a.env.code, "DRIFT_FOUND");
  assert.equal(docsIn(a.env)[0], "docs/reference.md");

  const proof = repoWith(t, { "docs/golden/reference.md": ANCHORED }, '[docs]\ndirs = ["docs/golden"]\n');
  const b = check(proof);
  assert.equal(b.code, 1, "named as the root itself, docs/golden was always read - only the recursion skipped it");
  assert.equal(b.env.code, "DRIFT_FOUND");
  assert.equal(docsIn(b.env)[0], "docs/golden/reference.md");

  // and the third placement of the same bytes, unchanged since 0.4.2: outside
  // every root it is UNREADABLE by name, not clean
  const out = repoWith(t, { "handbook/reference.md": ANCHORED }, '[docs]\ndirs = ["docs"]\n');
  const c = check(out);
  assert.equal(c.code, 1);
  assert.equal(c.env.code, "UNREADABLE");
  assert.deepEqual(c.env.data.unscanned, [{ doc: "handbook/reference.md", anchors: 1, regions: 1 }]);
});

// (f) Outside every scan root, the sweep no longer inherits the provider skip
// set. Three of those six names hid documents the user wrote; the sweep reports
// them exactly as it reports handbook/.
test("outside every scan root, golden, dist and coverage are swept like any other directory", (t) => {
  const root = repoWith(t, {
    "golden/reference.md": ANCHORED,
    "dist/reference.md": ANCHORED,
    "coverage/reference.md": ANCHORED,
  }, '[docs]\ndirs = ["docs"]\n');
  const { code, env } = check(root);
  assert.equal(code, 1, `three anchored docs the run never read must not exit 0: ${env.summary}`);
  assert.equal(env.code, "UNREADABLE");
  assert.deepEqual(env.data.unscanned.map((u) => u.doc).sort(),
    ["coverage/reference.md", "dist/reference.md", "golden/reference.md"]);
  for (const doc of ["coverage/reference.md", "dist/reference.md", "golden/reference.md"]) {
    assert.match(env.summary, new RegExp(doc.replace("/", "\\/")), "a count nobody can act on is not a finding");
  }
});

// (g) The one tree that stays unread is named instead. A dependency tree is
// still part of the repository on disk, so passing over it is a statement the
// run has to make - but it is not a finding, or every repository that has run
// `npm install` would exit 1 and the check would be the first thing switched off.
test("node_modules is not swept, and the run says so without moving the verdict", (t) => {
  const root = repoWith(t, {
    "node_modules/pkg/reference.md": ANCHORED,
    "docs/node_modules/pkg/reference.md": ANCHORED,
  }, '[docs]\ndirs = ["docs"]\n');
  const { code, env } = check(root);
  assert.equal(code, 0, `naming a skipped tree must never become a finding: ${env.summary}`);
  assert.equal(env.code, "CLEAN");
  assert.deepEqual(env.data.skipped, ["docs/node_modules", "node_modules"],
    "both walks reach it - inside the scan root and outside - and both must name it");
  assert.equal(env.data.unscanned, undefined, "named is not the same as swept");

  // and the escape hatch is the same one `[docs] dirs` always was: the skip is a
  // default, not a ban
  const named = repoWith(t, { "docs/node_modules/pkg/reference.md": ANCHORED },
    '[docs]\ndirs = ["docs/node_modules"]\n');
  const n = check(named);
  assert.equal(n.code, 1, "a scan root that IS the dependency tree is read");
  assert.equal(docsIn(n.env)[0], "docs/node_modules/pkg/reference.md");
});

// (h) The two directories that are read by nothing and named by nothing, pinned
// with their reason. `.git` is the VCS's own storage - an export of the
// identical tree has none - and `<root>/.keeldocs` is the directory THIS COMMAND
// creates, so naming it would make the report say something different on the
// second run than on the first, which is the run-state leak the cold/warm
// byte-identical contract forbids. Both are silence, and both are arguable; this
// test exists so the next person changes them deliberately.
test(".git and the engine's own .keeldocs are not repository content, and are not named", (t) => {
  const root = repoWith(t, {
    ".keeldocs/reference.md": ANCHORED,
    ".git/objects/reference.md": ANCHORED,
  }, '[docs]\ndirs = ["docs"]\n');
  const { code, env } = check(root);
  assert.equal(code, 0, `neither is repository content: ${env.summary}`);
  assert.equal(env.code, "CLEAN");
  assert.equal(env.data.skipped, undefined, "no dependency tree here, so nothing to name");
  assert.equal(env.data.unscanned, undefined);
});

// And the same two mechanisms at the unit boundary, where the collector is
// visible: a `skipped` array is filled by BOTH walks, and every path in it is
// repo-relative and posix.
test("both walks collect what they declined to enter", (t) => {
  const root = repoWith(t, {
    "docs/node_modules/a/x.md": ANCHORED,
    "vendor/node_modules/b/y.md": ANCHORED,
    "docs/golden/inside.md": ANCHORED,
    "golden/outside.md": ANCHORED,
  });
  const scanSkips = [];
  const docs = docPathsOf(root, ["docs"], scanSkips);
  assert.deepEqual(scanSkips, ["docs/node_modules"]);
  assert.ok(docs.includes("docs/golden/inside.md"), "the scan reads the rest of the root");

  const sweepSkips = [];
  const unscanned = unscannedAnchoredDocs(root, docs, [], sweepSkips);
  assert.deepEqual(unscanned, [{ doc: "golden/outside.md", anchors: 1, regions: 1 }]);
  assert.deepEqual(sweepSkips.sort(), ["docs/node_modules", "vendor/node_modules"]);

  // the user's written scope answers first: an excluded tree is disclosed by the
  // line the user wrote, not counted as an engine skip
  const scoped = [];
  assert.deepEqual(unscannedAnchoredDocs(root, docs, ["vendor/**", "golden/**"], scoped), []);
  assert.deepEqual(scoped, ["docs/node_modules"]);

  // and the third list, which is the one the scope owed: every anchored document
  // the exclusion suppressed, named. `vendor/node_modules` is in neither - it is
  // excluded AND a dependency tree, and attributing it twice would say the
  // engine passed over something the user had already asked it to.
  const excluded = [], skips = [];
  assert.deepEqual(unscannedAnchoredDocs(root, docs, ["vendor/**", "golden/**"], skips, excluded), []);
  assert.deepEqual(excluded, [{ doc: "golden/outside.md", anchors: 1, regions: 1 }]);
  assert.deepEqual(skips, ["docs/node_modules"]);
});
