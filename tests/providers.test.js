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

test("the real registry loads: nestjs is a query provider, workspace precedes module-graph", () => {
  const r = loadProviders();
  const nest = r.find((e) => e.id === "nestjs");
  assert.equal(nest.runtime, "query");
  assert.equal(nest.entry, "providers/_runtime/tsq.py");
  const order = r.map((e) => e.capability);
  assert.ok(order.indexOf("workspace-layout") < order.indexOf("module-graph"),
    "needs must order workspace-layout before module-graph");
  assert.ok(!r.some((e) => e.id === "drizzle"), "stubs stay honestly absent");
});
