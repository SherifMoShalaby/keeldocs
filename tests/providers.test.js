import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProviderYaml, loadProviders } from "../src/providers.js";

test("yaml subset: scalars, flow lists, flow maps, nesting, comments, quotes", () => {
  const y = parseProviderYaml([
    "id: nestjs   # trailing comment",
    "semver: 0.2.0",
    'detect: { deps: ["@nestjs/core", "x"], always: true }',
    'verbs: { Get: GET, Post: POST }',
    'files: [".ts", \'.tsx\']',
    "timeout_class: D",
  ].join("\n"), "t.yaml");
  assert.deepEqual(y.detect, { deps: ["@nestjs/core", "x"], always: true });
  assert.deepEqual(y.verbs, { Get: "GET", Post: "POST" });
  assert.deepEqual(y.files, [".ts", ".tsx"]);
  assert.equal(y.semver, "0.2.0");
});

test("yaml subset is schema-strict: unknown key, block nesting, duplicates all throw", () => {
  assert.throws(() => parseProviderYaml("nope: 1", "t"), /unknown key/);
  assert.throws(() => parseProviderYaml("detect:\n  always: true", "t"), /no value|block nesting/);
  assert.throws(() => parseProviderYaml("id: a\nid: b", "t"), /duplicate/);
  assert.throws(() => parseProviderYaml("detect: { deps: [\"a\" }", "t"), /flow|unbalanced/);
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "kd-prov-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const OK = (cap, id, extra = "") =>
  `id: ${id}\ncapability: ${cap}\nsemver: 0.1.0\ntier: code\nentry: ./x.py\ndetect: { always: true }\n${extra}`;

test("loader: stubs skipped, needs topo-orders capabilities, dir mismatch rejected", (t) => {
  const root = tree({
    "providers/beta/b1/provider.yaml": OK("beta", "b1", 'needs: ["alpha"]\n'),
    "providers/beta/b1/x.py": "",
    "providers/alpha/a1/provider.yaml": OK("alpha", "a1"),
    "providers/alpha/a1/x.py": "",
    "providers/alpha/ghost/provider.yaml": OK("alpha", "ghost", "status: stub\n"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = loadProviders(root);
  assert.deepEqual(r.map((e) => e.id), ["a1", "b1"], "alpha before beta (needs), stub gone");

  writeFileSync(join(root, "providers/alpha/a1/provider.yaml"), OK("WRONG", "a1"));
  assert.throws(() => loadProviders(root), /kebab-case|!= directory/);
});

test("loader: unmet needs and cycles are loud errors, missing entry rejected", (t) => {
  const root = tree({
    "providers/beta/b1/provider.yaml": OK("beta", "b1", 'needs: ["missing-cap"]\n'),
    "providers/beta/b1/x.py": "",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => loadProviders(root), /needs `missing-cap`/);

  writeFileSync(join(root, "providers/beta/b1/provider.yaml"), OK("beta", "b1"));
  rmSync(join(root, "providers/beta/b1/x.py"));
  assert.throws(() => loadProviders(root), /entry `.\/x.py` not found/);

  const root2 = tree({
    "providers/a/a1/provider.yaml": OK("a", "a1", 'needs: ["b"]\n'),
    "providers/a/a1/x.py": "",
    "providers/b/b1/provider.yaml": OK("b", "b1", 'needs: ["a"]\n'),
    "providers/b/b1/x.py": "",
  });
  t.after(() => rmSync(root2, { recursive: true, force: true }));
  assert.throws(() => loadProviders(root2), /cycle/);
});

test("loader: query runtime requires query file + language, entry becomes the shared runner", (t) => {
  const root = tree({
    "providers/cap/q1/provider.yaml":
      "id: q1\ncapability: cap\nsemver: 0.1.0\ntier: declarative\nruntime: query\n" +
      "language: typescript\nquery: q.scm\ndetect: { always: true }\nemits: [endpoint]\n",
    "providers/cap/q1/q.scm": "(program)",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [e] = loadProviders(root);
  assert.equal(e.entry, "providers/_runtime/tsq.py");
  assert.equal(e.argMode, "providerDir");
  assert.ok(e.dir.endsWith("providers/cap/q1"));
});

test("loader: ${facts:cap} inputs become factInputs and imply needs edges", (t) => {
  const root = tree({
    "providers/alpha/a1/provider.yaml": OK("alpha", "a1"),
    "providers/alpha/a1/x.py": "",
    "providers/beta/b1/provider.yaml":
      OK("beta", "b1", 'inputs: ["${facts:alpha}", "**/*.py"]\n'),
    "providers/beta/b1/x.py": "",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = loadProviders(root);
  const b1 = r.find((e) => e.id === "b1");
  assert.deepEqual(b1.factInputs, ["alpha"]);
  assert.deepEqual(b1.needs, ["alpha"], "a declared read IS a dependency edge");
  assert.deepEqual(r.map((e) => e.id), ["a1", "b1"], "topo respects the implied edge");
});

test("loader: emits reaches the registry entry, so extraction can enforce it", (t) => {
  const root = tree({
    "providers/alpha/a1/provider.yaml": OK("alpha", "a1", "emits: [table, enum]\n"),
    "providers/alpha/a1/x.py": "",
    "providers/beta/b1/provider.yaml": OK("beta", "b1"),
    "providers/beta/b1/x.py": "",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = loadProviders(root);
  // `emits` was parsed, validated, and printed in the consent manifest, and then
  // dropped on the floor here - so the engine held no copy of the list a human
  // had agreed to, and could not have enforced it.
  assert.deepEqual(r.find((e) => e.id === "a1").emits, ["table", "enum"]);
  assert.deepEqual(r.find((e) => e.id === "b1").emits, [], "absent declares nothing, never undefined");
});

test("loader: entry path traversal is rejected (E10 containment)", (t) => {
  const root = tree({
    "providers/cap/t1/provider.yaml":
      "id: t1\ncapability: cap\nsemver: 0.1.0\ntier: code\nentry: ../../../evil.py\ndetect: { always: true }\n",
    "evil.py": "",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => loadProviders(root), /must stay inside the provider directory/);
});

test("loader: exec key - node accepted onto the entry, anything else rejected", (t) => {
  const root = tree({
    "providers/cap/n1/provider.yaml": OK("cap", "n1", "exec: node\n"),
    "providers/cap/n1/x.py": "",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [e] = loadProviders(root);
  assert.equal(e.exec, "node");
  writeFileSync(join(root, "providers/cap/n1/provider.yaml"), OK("cap", "n1", "exec: ruby\n"));
  assert.throws(() => loadProviders(root), /exec must be/);
});

test("the real registry loads: nestjs is a query provider, workspace precedes module-graph", () => {
  const r = loadProviders();
  const nest = r.find((e) => e.id === "nestjs");
  assert.equal(nest.runtime, "query");
  // R1: the replay engine is node-exec and sorts AFTER every declared
  // db-schema provider (declared-beats-replayed identity rule needs it)
  assert.equal(r.find((e) => e.id === "sql-replay").exec, "node");
  assert.deepEqual(r.filter((e) => e.capability === "db-schema").map((e) => e.id),
    ["drizzle", "prisma", "sql-replay", "tbls-live"], "declared providers precede replay, replay precedes live");
  const tsi = r.find((e) => e.id === "ts-imports");
  assert.deepEqual(tsi.factInputs, ["workspace-layout"], "the shipped declared read");
  assert.equal(nest.entry, "providers/_runtime/tsq.py");
  const order = r.map((e) => e.capability);
  assert.ok(order.indexOf("workspace-layout") < order.indexOf("module-graph"),
    "needs must order workspace-layout before module-graph");
  assert.ok(!r.some((e) => e.id === "rails-sql"), "stubs stay honestly absent (drizzle graduated in N1)");
});

test("http-endpoints declares a db-schema read, and the catalog runs first", () => {
  const r = loadProviders();
  const pg = r.find((e) => e.id === "supabase-postgrest");
  assert.deepEqual(pg.factInputs, ["db-schema"], "the PostgREST surface is DERIVED from the catalog");
  const order = r.map((e) => e.capability);
  assert.ok(order.lastIndexOf("db-schema") < order.indexOf("http-endpoints"),
    "every db-schema provider must finish before the derived surface reads their facts");
});

// ---------- keeldocs skills install ----------
// E7 proved agents discover and invoke the skills; the review then found there
// was no shipped way to install them. The README said to copy
// node_modules/keeldocs/skills, which does not exist after `npx`, nests if the
// target already exists, and ships frontmatter Codex and Cursor reject.
import { installSkills, listAgents } from "../src/skillscmd.js";
import { mkdtempSync as _mkdtemp, rmSync as _rm, existsSync as _exists, readFileSync as _read, readdirSync as _readdir } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";

test("skills install: per-agent path, frontmatter strip, AGENTS.md, and no nesting on re-run", () => {
  const expected = {
    "claude-code": { dir: ".claude/skills", strips: false, agentsMd: false },
    codex: { dir: ".agents/skills", strips: true, agentsMd: true },
    cursor: { dir: ".cursor/skills", strips: true, agentsMd: true },
  };
  assert.deepEqual(listAgents(), Object.keys(expected).sort());

  for (const [agent, want] of Object.entries(expected)) {
    const root = _mkdtemp(_join(_tmpdir(), `kd-skills-${agent}-`));
    try {
      const r = installSkills({ agent, root });
      assert.equal(r.ok, true, r.summary);
      assert.equal(r.data.skills_dir, want.dir);
      assert.ok(r.data.listing <= r.data.cap, `listing ${r.data.listing} over cap`);

      // the agent that chokes on a key must not receive it; the one that
      // supports it must keep it - a flat copy gets one of the two wrong
      const initFm = _read(_join(root, want.dir, "init", "SKILL.md"), "utf8").split("---")[1];
      assert.equal(initFm.includes("disable-model-invocation"), !want.strips);
      assert.equal(_exists(_join(root, "AGENTS.md")), want.agentsMd);

      // installing twice must not produce <dir>/skills/... - the `cp -r` failure,
      // which an agent never sees and which reports no error
      installSkills({ agent, root });
      assert.equal(_readdir(_join(root, want.dir)).includes("skills"), false, "nested copy created");
      assert.equal(_readdir(_join(root, want.dir)).length, 6);
    } finally { _rm(root, { recursive: true, force: true }); }
  }
});

test("skills install: an unknown agent refuses and names the ones that exist", () => {
  const r = installSkills({ agent: "emacs", root: _tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(r.code, "USAGE");
  assert.match(r.summary, /claude-code/);
});
