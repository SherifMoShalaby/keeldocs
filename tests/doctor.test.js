// `keeldocs doctor` - the preflight, and the first producer of exit code 3.
//
// Two defects are under test here. (1) 33 provider.yaml files declared a
// `requires:` list that nothing read, so a missing Python extractor runtime
// surfaced as TOOL_ERROR with no remediation - the E7 failure that produced a
// confidently wrong verdict rather than an obviously broken one. (2) exit 3 was
// documented in three shipped, agent-facing files and produced by nothing.
//
// The verdict tests run against SYNTHETIC environments on purpose: a degraded
// machine has to be testable without degrading the machine running the tests,
// and a probe-shaped test would pass vacuously on a fully-installed CI runner.
// The manifest tests run against the REAL providers/ tree, because a
// classification rule that only ever sees fixtures is not a rule about keeldocs.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requirementPins, scanManifests, requirementsOf, diagnose, remediation, renderDoctor } from "../src/doctor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINS = requirementPins();
const MANIFESTS = scanManifests();

// Every requirement name the shipped registry actually asks for.
const allRequirements = () => {
  const s = new Set();
  for (const { y } of MANIFESTS) {
    if (y.status === "stub") continue;
    for (const r of requirementsOf(y, PINS)) s.add(r.name);
  }
  return [...s];
};

// A synthetic environment. `missing` names requirements this machine lacks.
const ENV = ({ missing = [], python = true, git = true, node = true, externallyManaged = false } = {}) => ({
  node: { version: node ? "22.1.0" : "18.4.0", engines: ">=20", floor: 20, ok: node, unknownFloor: false },
  git: { ok: git, version: git ? "2.51.2" : null },
  python: python
    ? { ok: true, bin: "python3", version: "3.12.4", executable: "/usr/bin/python3",
        externallyManaged, tried: [], mods: {} }
    : { ok: false, bin: null, tried: [{ bin: "python3", reason: "not found" }, { bin: "python", reason: "not found" }], mods: {} },
  requirements: Object.fromEntries(allRequirements().map((n) => [n,
    { kind: "?", ok: !missing.includes(n), detail: missing.includes(n) ? "ModuleNotFoundError" : null }])),
});

const run = (env) => diagnose({ manifests: MANIFESTS, pins: PINS, env });

test("the pin list is READ from providers/requirements.txt, never restated in code", () => {
  assert.ok(PINS.size >= 8, `expected the eight pinned distributions, got ${PINS.size}`);
  for (const d of ["tree-sitter", "tree-sitter-typescript", "tree-sitter-python", "pyyaml"]) {
    assert.ok(PINS.has(d), `requirements.txt no longer pins ${d}`);
  }
});

test("a requirement is classified by the pin list and the npm sigil, not by a hand-kept table", () => {
  assert.deepEqual(requirementsOf({ requires: ["tree-sitter", "tree-sitter-typescript"] }, PINS).map((r) => r.kind),
    ["python", "python"]);
  assert.equal(requirementsOf({ requires: ["git"] }, PINS)[0].kind, "bin");
  assert.equal(requirementsOf({ requires: ["@electric-sql/pglite"] }, PINS)[0].kind, "node");
  // PyPI distribution name != import name, and only the exceptions are listed
  const pins = requirementPins();
  assert.ok(pins.has("pyyaml"));
});

test("the query runtime's needs are DERIVED - both shipped `runtime: query` manifests declare none", () => {
  const q = requirementsOf({ runtime: "query", language: "java" }, PINS);
  assert.deepEqual(q.map((r) => r.name).sort(), ["pyyaml", "tree-sitter", "tree-sitter-java"]);
  assert.ok(q.every((r) => r.derived), "derived needs must be marked derived, so the under-declaration stays visible");
  const shipped = MANIFESTS.filter(({ y }) => y.runtime === "query");
  assert.ok(shipped.length >= 2, "expected the nestjs/spring declarative tier");
  for (const { file, y } of shipped) {
    assert.equal(y.requires, undefined, `${file} now declares requires - drop the derivation for it`);
    assert.ok(requirementsOf(y, PINS).length >= 2, `${file}: tsq.py imports yaml + tree_sitter, so it needs them`);
  }
});

test("every shipped manifest's requirements resolve to a known probe kind", () => {
  const bins = new Set();
  for (const { y } of MANIFESTS) {
    if (y.status === "stub") continue;
    for (const r of requirementsOf(y, PINS)) if (r.kind === "bin") bins.add(r.name);
  }
  // A new external executable must be a deliberate decision: doctor can only
  // tell a user how to install what it knows about.
  assert.deepEqual([...bins].sort(), ["git", "tbls"],
    "a provider declared a new external tool - give doctor a remediation line for it");
});

test("a fully satisfied environment is READY and exits 0", () => {
  const r = run(ENV());
  assert.equal(r.code, "READY");
  assert.equal(r.exit, 0);
  assert.equal(r.providers.blocked.length, 0);
  assert.ok(r.providers.total > 20, "the gate must see the whole registry, not a fixture");
});

test("EXIT 3 IS REACHABLE: a missing grammar degrades rather than blocks", () => {
  const r = run(ENV({ missing: ["tree-sitter-typescript"] }));
  assert.equal(r.exit, 3, "exit 3 was documented in three shipped files and produced by nothing");
  assert.equal(r.code, "DEGRADED");
  assert.ok(r.providers.blocked.length >= 3, "ts-imports and the client-routes providers all need that grammar");
  assert.ok(r.providers.blocked.some((p) => p.id === "module-graph/ts-imports"));
  assert.ok(r.providers.ready < r.providers.total && r.providers.ready > 0,
    "degraded means partial: some providers run, some do not");
  assert.equal(r.hard.length, 0, "degraded is not blocked - the prerequisites are all present");
  // the declarative tier goes with it: nestjs declares no `requires`, but the
  // shared query runtime imports that grammar for `language: typescript`
  assert.ok(r.providers.blocked.some((p) => p.id === "http-endpoints/nestjs"),
    "a derived requirement must degrade the provider that really depends on it");
});

test("no python interpreter at all is BLOCKED (exit 1), not degraded", () => {
  const r = run(ENV({ python: false }));
  assert.equal(r.exit, 1);
  assert.equal(r.code, "BLOCKED");
  assert.ok(r.hard.some((h) => /python/.test(h)));
  // every python-exec provider is out, including the ones with `requires: []`:
  // the interpreter is an unwritten requirement of every manifest
  assert.ok(r.providers.blocked.some((p) => p.missing.includes("python3")));
});

test("node below the engines floor and a missing git are BLOCKED too", () => {
  assert.equal(run(ENV({ node: false })).exit, 1);
  assert.equal(run(ENV({ git: false })).exit, 1);
  assert.ok(run(ENV({ git: false })).hard.some((h) => /git/.test(h)));
});

test("a `live` provider's missing tool never degrades the verdict - it is an opt-in gate", () => {
  const r = run(ENV({ missing: ["tbls"] }));
  assert.equal(r.exit, 0, "tbls is only reachable through `check --live`");
  assert.equal(r.code, "READY");
  assert.ok(r.providers.liveOnly.some((p) => p.id === "db-schema/tbls-live"),
    "but it must still be REPORTED, or doctor is hiding a real gap");
  // and the same tool required by a non-live provider WOULD degrade
  assert.equal(run(ENV({ missing: ["@electric-sql/pglite"] })).exit, 3);
});

test("the remediation line carries --require-hashes and the resolved requirements path", () => {
  const env = ENV({ missing: ["tree-sitter"] });
  const rem = remediation({ env, missing: [{ name: "tree-sitter", kind: "python", providers: ["a/b"], live: false }],
    hard: [], engineRoot: ROOT });
  const pip = rem.steps.find((s) => s.includes("-m pip"));
  assert.ok(pip, "a missing python module must produce a pip line");
  assert.match(pip, /--require-hashes/, "requirements.txt is hash-pinned; every install site uses this flag");
  assert.match(pip, /-r .*providers\/requirements\.txt$/);
  assert.ok(!pip.includes("--break-system-packages"), "not an externally-managed interpreter here");
  // PEP 668 is a Linux-distro and Homebrew condition; the marker does not occur
  // on Windows, so doctor signposts the Windows launcher there instead. Asserting
  // PEP 668 unconditionally is how this test went red on the Windows lane while
  // passing on the machine it was written on.
  if (process.platform === "win32") {
    assert.ok(rem.notes.some((n) => /py -m pip/.test(n)), "Windows gets the launcher note instead");
  } else {
    assert.ok(rem.notes.some((n) => /PEP 668/.test(n)), "PEP 668 must be signposted where it can occur");
  }
});

test("--break-system-packages appears only when THIS interpreter is PEP 668 externally-managed", () => {
  const env = ENV({ missing: ["tree-sitter"], externallyManaged: true });
  const rem = remediation({ env, missing: [{ name: "tree-sitter", kind: "python", providers: ["a/b"], live: false }],
    hard: [], engineRoot: ROOT });
  const pip = rem.steps.find((s) => s.includes("-m pip"));
  assert.match(pip, /--user --break-system-packages --require-hashes/);
  assert.ok(rem.notes.some((n) => /externally-managed/.test(n)));
});

test("Windows with no python3 shim gets `py -m pip`", () => {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const rem = remediation({ env: ENV({ python: false }), missing: [], hard: [], engineRoot: ROOT });
    assert.ok(rem.steps.some((s) => s.startsWith("py -m pip install")),
      "there is often no `python3` shim on Windows");
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
});

test("the human report names the providers that cannot run and why", () => {
  const text = renderDoctor(run(ENV({ missing: ["tree-sitter-python"] })));
  assert.match(text, /keeldocs doctor - DEGRADED/);
  assert.match(text, /CANNOT RUN\s+http-endpoints\/fastapi\s+needs tree-sitter-python/);
  assert.match(text, /TO FIX/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(text), "no emoji");
});

// ---- the shipped surface ----

test("the CLI dispatches `doctor` and emits an ADR-010 envelope inside the 8KB cap", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "keeldocs.js"), "doctor", "--json"],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.ok([0, 1, 3].includes(r.status), `unexpected exit ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.length <= 8192, `envelope ${r.stdout.length} bytes exceeds the 8KB cap`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.v, 1);
  assert.ok(["READY", "DEGRADED", "BLOCKED"].includes(env.code), env.code);
  assert.ok(env.summary.length <= 300);
  assert.ok(Array.isArray(env.next));
  assert.equal(env.ok, r.status === 0);
  assert.ok(env.data.remediation.requirements.endsWith("providers/requirements.txt"));
  // the exit code is the envelope's claim, made checkable
  assert.equal(r.status, env.code === "READY" ? 0 : env.code === "DEGRADED" ? 3 : 1);
});

test("`doctor` is in the usage line, so it is discoverable without the README", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "keeldocs.js"), "nonsense"],
    { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /doctor/);
});

test("no shipped file documents exit 3 without naming the command that produces it", () => {
  for (const rel of ["bin/keeldocs.js", "AGENTS.md", "skills/keeldocs-core/SKILL.md"]) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const i = text.indexOf("degraded");
    assert.notEqual(i, -1, `${rel} no longer documents the degraded exit code`);
    const window = text.slice(Math.max(0, i - 800), i + 800);
    assert.match(window, /doctor/,
      `${rel} documents exit 3 but does not name \`doctor\` near it - that is how it became unreachable`);
  }
});
