// `[providers] exclude-paths` reaching four consumers with two different
// meanings.
//
// The setting is one line of config, and until now it was compiled twice. The
// repo walk (`src/scope.js`) tests the patterns against every entry it meets
// INCLUDING directories, so `vendor` prunes the subtree; the provenance filter
// (`src/facts.js`) tests the same patterns against FILE paths, where `^vendor$`
// matches nothing. Measured on `fixtures/exclude-shape-scenario` with the tree
// `0.4.2` shipped from, one fixture, four spellings:
//
//   (none)          exit 1 UNREADABLE, vendor/notes.md named, total 2, topology ok
//   ["vendor"]      exit 0 CLEAN, total 2 (VENDOR_SECRET_KEY still counted),
//                   topology absent, no scopedOut, no excludePaths, nothing named
//   ["vendor/**"]   exit 0 CLEAN, total 1, scopedOut 1, excludePaths present
//   ["**/*.md"]     exit 0 CLEAN, total 2, topology ok - excludes no code at all
//                   and puts the `git mv docs handbook` regression back
//
// So the bare name did the loudest half of the job (a provider and an anchored
// document disappeared) and none of the advertised half (the fact it was written
// to remove was still in the coverage denominator), and the two fields that
// would have said so were keyed on the count that stayed zero.
//
// Two gates below, and two controls that fail if either gate goes vacuous.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractAll } from "../src/facts.js";
import { pathScope, repoFiles, resolveInputs } from "../src/scope.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Always on a COPY: `check` spills a report into `.keeldocs/out`, and a test
// that writes into the tracked fixture makes the next run depend on the last.
function scenario(t, exclude) {
  const root = mkdtempSync(join(tmpdir(), "kd-exclude-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, "fixtures", "exclude-shape-scenario"), root, { recursive: true });
  if (exclude) {
    writeFileSync(join(root, "keeldocs.toml"),
      `[providers]\nexclude-paths = [${exclude.map((e) => `"${e}"`).join(", ")}]\n`);
  }
  return root;
}

// The envelope is what an agent parses and the spilled report is where `meta`
// lives, so both are read - and the report is read from the path the envelope
// claims, never from a guess about where it was written.
function check(root) {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "keeldocs.js"), "check", "--json"],
    { cwd: root, encoding: "utf8" });
  const env = JSON.parse(r.stdout.trim().split("\n").pop());
  const full = JSON.parse(readFileSync(join(root, env.full), "utf8"));
  return { code: r.status, env, full,
           caps: Object.fromEntries(Object.entries(full.capabilities).map(([k, v]) => [k, v.status])) };
}

const envVars = (root, excludePaths) => {
  const r = extractAll(root, { excludePaths });
  assert.equal(r.toolError ?? null, null, `extraction failed: ${r.toolError}`);
  return { scopedOut: r.scopedOut,
           names: [...r.factsById.values()].filter((f) => f.payload.type === "env-var")
             .map((f) => f.payload.attrs.name).sort() };
};

// CONTROL A. The fixture has to contain something to lose, or every assertion
// below passes over an empty `vendor/` and proves nothing. With no scope at all:
// the vendored fact is extracted and counted, the vendored compose file is the
// one that makes `services-topology` applicable, and the vendored anchored
// document is really there and really unread - exit 1, UNREADABLE, by name.
test("with no exclusion the fixture really carries a fact, a provider and an unread doc", (t) => {
  const root = scenario(t, null);
  const { code, env, full, caps } = check(root);

  assert.equal(code, 1, `an anchored doc outside every scan root must not exit 0: ${env.summary}`);
  assert.equal(env.code, "UNREADABLE");
  assert.deepEqual(env.data.unscanned, [{ doc: "vendor/notes.md", anchors: 1, regions: 1 }]);
  assert.equal(env.data.coverage.total, 2, "APP_KEY and VENDOR_SECRET_KEY, both counted");
  assert.equal(caps["services-topology"], "ok",
    "vendor/docker-compose.yml is the only compose file here - detection must find it");
  assert.equal(env.data.excludedDocs, undefined, "nothing is excluded when nothing is configured");
  assert.equal(full.meta.excludePaths, undefined, "an unconfigured scope names nothing");
  assert.equal(full.meta.scopedOut, undefined);

  assert.deepEqual(envVars(root, []), { scopedOut: 0, names: ["APP_KEY", "VENDOR_SECRET_KEY"] });
});

// CONTROL B. The spelling that always worked, so the gate below cannot pass by
// the scope having become a no-op in both forms.
test("exclude-paths = [\"vendor/**\"] still excludes: one surface, one scoped out, named", (t) => {
  const root = scenario(t, ["vendor/**"]);
  const { code, env, full } = check(root);

  assert.equal(code, 0, `an excluded tree is a declared blind spot, not a finding: ${env.summary}`);
  assert.equal(env.data.coverage.total, 1, "VENDOR_SECRET_KEY must leave the denominator");
  assert.equal(full.meta.scopedOut, 1);
  assert.deepEqual(full.meta.excludePaths, ["vendor/**"]);
  assert.deepEqual(envVars(root, ["vendor/**"]), { scopedOut: 1, names: ["APP_KEY"] });
});

// GATE 1. The same scope, spelled the way a user writes it. Every observable
// must match `["vendor/**"]` - not "be reasonable", match - because two
// spellings of one intent producing two fact sets is the defect.
test("exclude-paths = [\"vendor\"] means the directory AND its contents, everywhere", (t) => {
  const bare = check(scenario(t, ["vendor"]));
  const glob = check(scenario(t, ["vendor/**"]));

  assert.equal(bare.code, 0, `${bare.env.summary}`);
  assert.equal(bare.code, glob.code, "the two spellings must agree about the exit code");
  assert.equal(bare.env.code, glob.env.code);
  assert.deepEqual(bare.env.data.coverage, glob.env.data.coverage,
    "the coverage denominator was 2 for the bare name and 1 for the glob");
  assert.equal(bare.env.data.coverage.total, 1, "VENDOR_SECRET_KEY is inside vendor/ and must not be counted");
  assert.deepEqual(bare.caps, glob.caps,
    "provider detection already agreed - the fact set did not, and both must");
  assert.equal(bare.caps["services-topology"], "absent",
    "the only compose file is excluded, so the capability is absent under both spellings");

  // the two disclosure fields, absent in exactly the case that did the most damage
  assert.equal(bare.full.meta.scopedOut, glob.full.meta.scopedOut,
    "the count the two spellings report must agree before its value is worth asserting");
  assert.equal(bare.full.meta.scopedOut, 1, "a scope that removed a fact must say how many");
  assert.deepEqual(bare.full.meta.excludePaths, ["vendor"], "and which line did it");
  assert.deepEqual(bare.env.data.excludedDocs, [{ doc: "vendor/notes.md", anchors: 1, regions: 1 }]);
  assert.deepEqual(bare.env.data.excludedDocs, glob.env.data.excludedDocs);
  assert.equal(bare.env.data.unscanned, undefined, "an excluded doc is disclosed, not a finding");

  // and at the fact boundary, where the two spellings disagreed
  const root = scenario(t, null);
  assert.deepEqual(envVars(root, ["vendor"]), { scopedOut: 1, names: ["APP_KEY"] },
    "the bare name pruned the walk and kept the fact - the one shape a path scope must never have");

  // the other half of the same setting: what a provider may READ. Checked
  // through the resolver rather than through a mount, so it holds on every host.
  const view = (exclude) =>
    resolveInputs(root, ["**/*.js"], repoFiles(root, exclude)).files;
  assert.deepEqual(view([]), ["app.js", "vendor/lib.js"], "control: an unscoped view has both");
  assert.deepEqual(view(["vendor"]), ["app.js"]);
  assert.deepEqual(view(["vendor"]), view(["vendor/**"]), "one scope, one view");
});

// GATE 2. The half that is not about facts at all. `["**/*.md"]` excludes no
// code, scopes out nothing, and used to switch off the whole 0.4.2 sweep in
// silence: the anchored document went from named-and-exit-1 to unmentioned, with
// an empty `meta` beside it. The scope is still honoured - the user wrote it -
// but the document it suppressed is named.
test("an exclusion that suppresses an anchored document says so, without moving the verdict", (t) => {
  const root = scenario(t, ["**/*.md"]);
  const { code, env, full, caps } = check(root);

  assert.equal(code, 0, "honouring a written scope is the point of having one");
  assert.equal(env.code, "CLEAN");
  assert.deepEqual(env.data.excludedDocs, [{ doc: "vendor/notes.md", anchors: 1, regions: 1 }],
    "the sweep went silent repo-wide and said nothing about it");
  assert.match(
    spawnSync(process.execPath, [join(ROOT, "bin", "keeldocs.js"), "check"],
      { cwd: root, encoding: "utf8" }).stdout,
    /EXCLUDED\s+vendor\/notes\.md/, "the human channel names it too");

  // and the proof that this exclusion really did nothing else: no code left the
  // fact set, so a disclosure keyed on `scopedOut` would never have fired
  assert.equal(full.meta.scopedOut, 0, "a markdown glob removes no fact");
  assert.deepEqual(full.meta.excludePaths, ["**/*.md"],
    "the fields are emitted for a CONFIGURED scope, not for a non-zero count");
  assert.equal(env.data.coverage.total, 2, "both env vars are still counted");
  assert.equal(caps["services-topology"], "ok", "and the compose file is still read");
});

// The matcher itself, at the unit boundary, including the two shapes it must NOT
// widen. `fixtures/**` has always left the directory entry unmatched and pruned
// its contents one at a time; `demo.js` is a repo-root path and matching it as a
// basename anywhere would make every scope over-broad (the harness pins that one
// end to end).
test("a path scope matches a path and everything under it, and nothing else", () => {
  const scope = pathScope(["vendor", "fixtures/**", "demo.js"]);
  assert.equal(scope("vendor"), true);
  assert.equal(scope("vendor/lib.js"), true, "a directory name covers its subtree");
  assert.equal(scope("vendor/deep/nested/lib.js"), true);
  assert.equal(scope("vendored/lib.js"), false, "prefix, not path segment");
  assert.equal(scope("src/vendor/lib.js"), false, "the scope is repo-relative, never a basename");
  assert.equal(scope("fixtures"), false, "an explicit `/**` still describes contents only");
  assert.equal(scope("fixtures/a/demo.js"), true);
  assert.equal(scope("demo.js"), true);
  assert.equal(scope("app/demo.js"), false, "a bare file path is the file at the root, not the name");
  assert.equal(pathScope([])("anything"), false);
  assert.equal(pathScope(undefined)("anything"), false);
});

// The collector that makes the disclosure possible, and the attribution rule it
// must not break: inside a tree the user excluded, an engine skip is the user's
// line, not an engine skip worth naming.
test("repoFiles classifies an excluded tree instead of pruning it, but only when asked", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kd-denied-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const rel of ["app.js", "vendor/lib.js", "vendor/node_modules/dep/index.js"]) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), "module.exports = {};\n");
  }
  assert.deepEqual(repoFiles(root, ["vendor"]), ["app.js"],
    "with no collector the walk is exactly what it always was");

  const denied = [];
  assert.deepEqual(repoFiles(root, ["vendor"], null, { denied }), ["app.js"]);
  assert.deepEqual(denied, ["vendor/lib.js"],
    "the excluded files are classified, and node_modules is still not walked");
});
