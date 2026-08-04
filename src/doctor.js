// keeldocs doctor - the preflight that did not exist.
//
// 33 provider.yaml files declare a `requires:` list and, until this file, NOTHING
// read it. The failure mode that cost real time in the E7 run: the Python
// extractor runtime is absent, every python provider exits 1, and `check`
// reports TOOL_ERROR - a message that is technically correct and tells a
// first-time user nothing about what to install. Worse, it is a CONFIDENTLY
// WRONG verdict shape: an agent that correctly reports "tooling error" looks
// indistinguishable from an agent that failed the task.
//
// So the deliverable here is not the checklist, it is the REMEDIATION STRING:
// one line, correct for the interpreter that is actually on this machine,
// including `--break-system-packages` only when this machine really is PEP 668
// externally-managed (the marker file is read, never guessed) and `py -m pip`
// on Windows where there is often no `python3` shim. The install line itself is
// not invented here: it is `providers/requirements.txt` plus the
// `--require-hashes` flag that .github/SECURITY.md says every install site uses.
//
// ADR-010 exit contract, as it applies to this command:
//   0 READY     every shipped provider can run here
//   1 BLOCKED   a hard prerequisite is missing (node floor, any python at all,
//               git) - `check` cannot produce a trustworthy answer in this
//               environment, so this is a finding a human must clear
//   2 TOOL_ERROR  doctor itself could not complete (registry/manifest unreadable)
//   3 DEGRADED  keeldocs runs and produces facts, but at least one provider
//               cannot - partial answer, warn rather than fail
// `live` providers never degrade the verdict: `live: true` is an opt-in gate
// (`check --live`), so a missing `tbls` is a fact about an unused opt-in, not a
// degraded default run. Everything else that cannot run DOES degrade it -
// otherwise this gate would pass vacuously, which is the same as not having it.
//
// doctor probes the environment on purpose. That is why it is a separate
// command and not a phase of `check`: `check` stays a pure function of the
// tree, and nothing here is imported into it.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProviderYaml } from "./providers.js";
import { toPosix } from "./paths.js";

// fileURLToPath, never URL.pathname (Windows: "/D:/..." breaks join)
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIREMENTS_REL = "providers/requirements.txt";

// PyPI distribution name != import name, and there is no rule that derives one
// from the other. The general case IS mechanical (`tree-sitter-typescript` ->
// `tree_sitter_typescript`), so only the exceptions are listed.
const PY_IMPORT_OVERRIDES = { pyyaml: "yaml" };

// The shared .scm runtime (providers/_runtime/tsq.py) imports `yaml` and
// `tree_sitter` unconditionally and the grammar for its declared `language`
// lazily - but the two `runtime: query` manifests declare NO `requires:` at
// all. Deriving their needs here keeps doctor honest about what will actually
// be imported; the report says the needs were derived, because a manifest that
// under-declares is a defect and papering over it silently would hide it.
const QUERY_LANGUAGE_GRAMMAR = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  java: "tree-sitter-java",
};

// The probe runs the REAL import, not importlib.find_spec. The grammars are C
// extension modules: a find_spec hit says a file exists, while an ABI mismatch
// between tree-sitter and a grammar built against an older core is exactly the
// class of breakage that produces a working-looking install and a failing
// provider. Importing is the only test that answers the question being asked.
const PY_PROBE = [
  "import json,os,sys,sysconfig",
  "out={}",
  "for m in sys.argv[1:]:",
  "    try:",
  "        __import__(m)",
  "        out[m]=None",
  "    except BaseException as e:",
  "        out[m]=type(e).__name__+': '+str(e)[:160]",
  "print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),",
  " 'executable':sys.executable,'mods':out,",
  " 'externally_managed':os.path.exists(os.path.join(sysconfig.get_path('stdlib'),'EXTERNALLY-MANAGED'))}))",
].join("\n");

// ---------- reading what the tree declares ----------

// PEP 503 normalization, so `tree_sitter`, `Tree-Sitter` and `tree--sitter` all
// answer to the same pin.
const normDist = (s) => String(s).toLowerCase().replace(/[-_.]+/g, "-");

const pyImportName = (dist) =>
  PY_IMPORT_OVERRIDES[normDist(dist)] ?? normDist(dist).replace(/-/g, "_");

// Distribution names pinned in providers/requirements.txt. This is the list
// that decides whether a `requires:` token is a python module or an external
// executable, so the classification cannot drift from the file that installs it.
export function requirementPins(engineRoot = ENGINE_ROOT) {
  const path = join(engineRoot, REQUIREMENTS_REL);
  if (!existsSync(path)) return new Set();
  const pins = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==/);
    if (m) pins.add(normDist(m[1]));
  }
  return pins;
}

// Every shipped provider.yaml, as raw parsed manifests. Deliberately NOT
// loadProviders(): entryOf() drops `requires`, which is the entire subject of
// this command, and doctor wants the `status: stub` entries visible as skipped
// rather than silently absent.
export function scanManifests(engineRoot = ENGINE_ROOT) {
  const provDir = join(engineRoot, "providers");
  const out = [];
  for (const cap of readdirSync(provDir).sort()) {
    const capDir = join(provDir, cap);
    if (cap.startsWith("_") || !statSync(capDir).isDirectory()) continue;
    for (const id of readdirSync(capDir).sort()) {
      const dir = join(capDir, id);
      const yml = join(dir, "provider.yaml");
      if (!statSync(dir).isDirectory() || !existsSync(yml)) continue;
      const rel = toPosix(`providers/${cap}/${id}/provider.yaml`);
      out.push({ cap, id, file: rel, y: parseProviderYaml(readFileSync(yml, "utf8"), rel) });
    }
  }
  return out;
}

// What a manifest needs, as {name, kind}. `kind` is decided by the pin list and
// the npm-scope sigil, never by a hand-kept table of tool names.
export function requirementsOf(y, pins) {
  const declared = (Array.isArray(y.requires) ? y.requires : []).map(String);
  const derived = [];
  if (y.runtime === "query") {
    derived.push("pyyaml", "tree-sitter");
    const g = QUERY_LANGUAGE_GRAMMAR[String(y.language)];
    if (g) derived.push(g);
  }
  const seen = new Set();
  const out = [];
  for (const name of [...declared, ...derived]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const kind = name.startsWith("@") || name.startsWith("npm:") ? "node"
      : pins.has(normDist(name)) ? "python"
      : "bin";
    out.push({ name, kind, derived: !declared.includes(name) });
  }
  return out;
}

// ---------- probing this machine ----------

function probeNode(engineRoot) {
  let engines = null;
  try {
    engines = JSON.parse(readFileSync(join(engineRoot, "package.json"), "utf8")).engines?.node ?? null;
  } catch { /* a package.json we cannot read is reported as an unknown floor */ }
  // Only the FLOOR is parsed. A full semver-range parser is a dependency this
  // project does not have, and the floor is the only part of `>=20` doctor acts
  // on; an unparseable range reports `unknown` rather than inventing a verdict.
  const m = engines && engines.match(/(\d+)/);
  const floor = m ? Number(m[1]) : null;
  const major = Number(process.versions.node.split(".")[0]);
  return { version: process.versions.node, engines, floor,
    ok: floor === null ? true : major >= floor, unknownFloor: floor === null };
}

function probeGit() {
  const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return { ok: false, version: null };
  return { ok: true, version: (r.stdout || "").trim().replace(/^git version /, "") };
}

// python3 first, then python - the SAME order and the same reason as
// src/facts.js:355-356, because doctor must probe the interpreter that will
// actually run the providers, not a different one.
function probePython(modules) {
  const tried = [];
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["-c", PY_PROBE, ...modules], { encoding: "utf8", timeout: 60_000 });
    if (r.error || r.status !== 0) {
      tried.push({ bin, reason: r.error?.code === "ENOENT" ? "not found"
        : r.error ? String(r.error.message) : `rc=${r.status}` });
      continue;
    }
    try {
      const info = JSON.parse(r.stdout);
      return { ok: true, bin, tried, version: info.version, executable: info.executable,
        externallyManaged: !!info.externally_managed, mods: info.mods };
    } catch {
      tried.push({ bin, reason: "probe produced unparseable output" });
    }
  }
  return { ok: false, bin: null, tried, mods: {} };
}

function probeNodeModule(name, repoRoot) {
  // Resolve from BOTH the engine tree (where an optionalDependency of keeldocs
  // itself lands) and the repository being checked, because either location
  // legitimately satisfies the import at provider run time.
  for (const base of [ENGINE_ROOT, repoRoot]) {
    try {
      createRequire(join(base, "noop.js")).resolve(name);
      return { ok: true, from: toPosix(base) };
    } catch { /* try the next base */ }
  }
  return { ok: false, from: null };
}

function probeBinary(name) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 10_000 });
  // A tool that exists but rejects `--version` still exists; only spawn failure
  // means absent. `tbls --version` prints its version, but this rule keeps the
  // probe honest for any future binary with a different flag.
  return { ok: !r.error };
}

// ---------- the diagnosis ----------

// Pure with respect to the probes: everything the verdict depends on arrives in
// `env`, so a degraded machine is testable without breaking the test machine.
export function diagnose({ manifests, pins, env, engineRoot = ENGINE_ROOT }) {
  const providers = [];
  const missingByName = new Map();

  for (const { cap, id, y } of manifests) {
    const name = `${cap}/${id}`;
    if (y.status === "stub") {
      providers.push({ id: name, status: "stub", live: false, needs: [], missing: [] });
      continue;
    }
    const exec = y.exec === "node" ? "node" : "python";
    const live = y.live === true;
    const needs = requirementsOf(y, pins);
    const missing = [];

    // The interpreter is an unwritten requirement of every manifest: a provider
    // with `requires: []` still cannot run without the runtime that executes it.
    if (exec === "python" && !env.python.ok) missing.push({ name: "python3", kind: "runtime" });

    for (const req of needs) {
      const state = env.requirements[req.name];
      if (state && state.ok) continue;
      missing.push({ ...req, detail: state?.detail ?? null });
      if (!missingByName.has(req.name)) missingByName.set(req.name, { ...req, providers: [], live: true });
      const agg = missingByName.get(req.name);
      agg.providers.push(name);
      if (!live) agg.live = false; // needed by at least one non-opt-in provider
    }
    providers.push({ id: name, status: "shipped", exec, live,
      needs: needs.map((r) => r.name), missing,
      ready: missing.length === 0,
      derived: needs.some((r) => r.derived) });
  }

  const shipped = providers.filter((p) => p.status === "shipped");
  const ready = shipped.filter((p) => p.ready);
  // A `live` provider is opt-in behind `check --live`; its missing tool is
  // reported but never degrades a default run's verdict.
  const blocking = shipped.filter((p) => !p.ready && !p.live);

  const hard = [];
  if (!env.node.ok) hard.push(`node ${env.node.version} is below the engines floor (${env.node.engines})`);
  if (!env.python.ok) hard.push("no python3 (or python) interpreter on PATH");
  if (!env.git.ok) hard.push("git not found on PATH");

  const exit = hard.length ? 1 : blocking.length ? 3 : 0;
  const code = hard.length ? "BLOCKED" : blocking.length ? "DEGRADED" : "READY";

  return {
    v: 1, code, exit, ok: exit === 0,
    engineRoot: toPosix(engineRoot),
    node: env.node, git: env.git,
    python: { ok: env.python.ok, bin: env.python.bin, version: env.python.version ?? null,
      executable: env.python.executable ?? null,
      externallyManaged: !!env.python.externallyManaged,
      tried: env.python.tried ?? [] },
    requirements: env.requirements,
    // blockedCount is carried separately from the list because the envelope's
    // 8KB cap can trim the list; a count that survives trimming is the
    // difference between "fewer are broken" and "fewer are shown".
    providers: { total: shipped.length, ready: ready.length, stubs: providers.length - shipped.length,
      blockedCount: blocking.length,
      blocked: blocking.map((p) => ({ id: p.id, missing: p.missing.map((m) => m.name) })),
      liveOnly: shipped.filter((p) => !p.ready && p.live).map((p) => ({ id: p.id, missing: p.missing.map((m) => m.name) })) },
    hard,
    missing: [...missingByName.values()].map((m) => ({ name: m.name, kind: m.kind, derived: m.derived,
      liveOnly: m.live, providers: m.providers })),
    remediation: remediation({ env, missing: [...missingByName.values()], hard, engineRoot }),
  };
}

// THE deliverable. One line per thing that is actually wrong on THIS machine,
// with the flags this machine actually needs.
export function remediation({ env, missing, hard, engineRoot = ENGINE_ROOT }) {
  const reqPath = toPosix(join(engineRoot, REQUIREMENTS_REL));
  const steps = [];
  const notes = [];

  const pyMissing = missing.filter((m) => m.kind === "python");
  const needPip = !env.python.ok || pyMissing.length > 0;

  if (!env.python.ok) {
    steps.push(process.platform === "win32"
      ? "install Python 3 from python.org (the installer registers the `py` launcher)"
      : process.platform === "darwin"
      ? "install Python 3 (`brew install python`, or python.org)"
      : "install Python 3 from your distribution (`apt install python3 python3-pip` or equivalent)");
  }

  if (needPip) {
    // `py -m pip` on Windows only when we could not find a real interpreter:
    // if python3/python answered, name the one that answered rather than a
    // launcher that may resolve to a different install.
    const launcher = env.python.ok ? `${env.python.bin} -m pip`
      : process.platform === "win32" ? "py -m pip"
      : "python3 -m pip";
    const flags = ["install", "--user"];
    // --break-system-packages ONLY when this interpreter really is PEP 668
    // externally-managed. The EXTERNALLY-MANAGED marker is read from the
    // interpreter's own stdlib directory; it is not inferred from the platform,
    // because "macOS" and "Homebrew python" are not the same claim.
    if (env.python.externallyManaged) flags.push("--break-system-packages");
    flags.push("--require-hashes", "-r", reqPath);
    steps.push(`${launcher} ${flags.join(" ")}`);
    if (env.python.externallyManaged) {
      notes.push("this interpreter is PEP 668 externally-managed (Homebrew/system python): plain `pip install -r` is REFUSED, and `--user --break-system-packages` keeps the managed prefix untouched");
    } else if (process.platform !== "win32") {
      notes.push("if pip refuses with `externally-managed-environment` (PEP 668), add `--break-system-packages`");
    }
    if (process.platform === "win32") {
      notes.push("on Windows use `py -m pip` when there is no `python3` shim");
    }
    notes.push("--require-hashes is not optional: providers/requirements.txt is hash-pinned and every install site in this repo uses it (.github/SECURITY.md)");
    steps.push(`${env.python.bin ?? "python3"} -c "import tree_sitter_typescript"   # verify`);
  }

  for (const m of missing.filter((x) => x.kind === "node")) {
    steps.push(`npm install ${m.name}`);
    notes.push(`${m.name} is an optionalDependency of keeldocs - an install run with \`--omit=optional\` will not have it`);
  }
  const bins = new Set();
  for (const m of missing.filter((x) => x.kind === "bin")) {
    bins.add(m.name);
    steps.push(`install \`${m.name}\` and put it on PATH` +
      (m.live ? `   # only \`keeldocs check --live\` uses it (${m.providers.join(", ")})` : ""));
  }
  // git reaches this list two ways - as decision-history/git-log's declared
  // requirement and as a hard prerequisite of `check --ci`. Telling a user to
  // install it twice makes a five-line fix list look like a six-line one.
  if (hard.includes("git not found on PATH") && !bins.has("git")) {
    steps.push("install `git` and put it on PATH");
  }

  return { steps: [...new Set(steps)], notes: [...new Set(notes)], requirements: reqPath };
}

// ---------- rendering ----------

const pad = (s, n) => String(s).padEnd(n);

export function renderDoctor(r) {
  const L = [];
  const mark = (ok) => (ok ? "OK" : "MISSING");
  L.push(`keeldocs doctor - ${r.code}   (engine ${r.engineRoot})`);
  L.push("");
  L.push(`  ${pad("node", 10)} ${pad(r.node.version, 22)} ${r.node.ok ? "OK" : "TOO OLD"}   engines: ${r.node.engines ?? "unknown"}`);
  L.push(`  ${pad("git", 10)} ${pad(r.git.version ?? "-", 22)} ${mark(r.git.ok)}`);
  L.push(`  ${pad("python", 10)} ${pad(r.python.ok ? `${r.python.version} (${r.python.bin})` : "-", 22)} ${mark(r.python.ok)}` +
    (r.python.executable ? `   ${r.python.executable}` : ""));
  if (!r.python.ok && r.python.tried.length) {
    for (const t of r.python.tried) L.push(`               tried \`${t.bin}\`: ${t.reason}`);
  }
  if (r.python.externallyManaged) {
    L.push("               PEP 668 externally-managed interpreter (pip needs --break-system-packages)");
  }

  const reqs = Object.entries(r.requirements);
  if (reqs.length) {
    L.push("");
    L.push(`  provider requirements (${reqs.filter(([, s]) => s.ok).length}/${reqs.length} satisfied)`);
    for (const [name, s] of reqs) {
      // For an opt-in requirement the NOTE is the useful half ("only under
      // --live"); "not on PATH" is just a restatement of the status word.
      const why = s.ok ? "" : s.optional ? s.note ?? "" : s.detail ?? "";
      L.push(`    ${pad(name, 26)} ${pad(s.ok ? "OK" : s.optional ? "not installed" : "MISSING", 14)} ${why}`.replace(/\s+$/, ""));
    }
  }

  L.push("");
  L.push(`  providers  ${r.providers.ready} of ${r.providers.total} can run here` +
    (r.providers.stubs ? `   (${r.providers.stubs} declared-but-not-shipped, skipped)` : ""));
  // One missing interpreter blocks every provider at once, and thirty-four
  // identical lines bury the single sentence that would fix them. The root
  // cause is printed under BLOCKED; the list is evidence, so it is capped and
  // the remainder is counted rather than dropped.
  const SHOW = 12;
  for (const p of r.providers.blocked.slice(0, SHOW)) {
    L.push(`    CANNOT RUN  ${pad(p.id, 30)} needs ${p.missing.join(", ")}`);
  }
  if (r.providers.blocked.length > SHOW) {
    L.push(`    CANNOT RUN  ... and ${r.providers.blocked.length - SHOW} more`);
  }
  for (const p of r.providers.liveOnly) {
    L.push(`    opt-in only ${pad(p.id, 30)} needs ${p.missing.join(", ")}  (\`check --live\`; does not affect this verdict)`);
  }

  if (r.hard.length) {
    L.push("");
    L.push("  BLOCKED - keeldocs cannot produce a trustworthy answer here:");
    for (const h of r.hard) L.push(`    - ${h}`);
  }

  if (r.remediation.steps.length) {
    L.push("");
    // A READY verdict with steps means the only gaps are opt-in tools. Calling
    // that "TO FIX" would teach a first-time user that a healthy machine is
    // broken, which is the noise this command exists to remove.
    L.push(r.code === "READY" ? "  OPTIONAL - nothing here blocks a default run" : "  TO FIX");
    for (const s of r.remediation.steps) L.push(`    ${s}`);
    for (const n of r.remediation.notes) L.push(`      note: ${n}`);
  } else {
    L.push("");
    L.push("  Nothing to fix. Run `keeldocs init` (new repo) or `keeldocs check`.");
  }
  return L.join("\n");
}

// The summary is a claim about this machine and is held to the same standard as
// every other claim keeldocs makes: it reports ready/total, never "all", because
// a READY verdict can still carry opt-in providers that cannot run.
const SUMMARY = (r) =>
  r.code === "READY"
    ? `environment ready: node ${r.node.version}, python ${r.python.version} (${r.python.bin}), git ${r.git.version}; ${r.providers.ready}/${r.providers.total} providers can run` +
      (r.providers.liveOnly.length ? ` (${r.providers.liveOnly.length} opt-in, --live only)` : "")
    : r.code === "BLOCKED"
    ? `BLOCKED: ${r.hard.join("; ")} - keeldocs cannot produce a trustworthy answer until this is fixed`
    : `degraded: ${r.providers.ready}/${r.providers.total} providers can run; missing ${r.missing.filter((m) => !m.liveOnly).map((m) => m.name).join(", ")}`;

// ---------- the command ----------

export function runDoctor({ root, json }) {
  let manifests, pins;
  try {
    pins = requirementPins();
    manifests = scanManifests();
  } catch (err) {
    const env = { v: 1, ok: false, code: "TOOL_ERROR",
      summary: `doctor could not read the provider registry: ${String(err.message).slice(0, 220)}`,
      data: {}, next: ["reinstall keeldocs"] };
    if (json) process.stdout.write(JSON.stringify(env) + "\n");
    else process.stderr.write(`TOOL_ERROR: ${env.summary}\n`);
    return 2;
  }

  // One requirement set for the whole registry, so the python interpreter is
  // spawned ONCE however many providers name the same module.
  const all = new Map();
  for (const { y } of manifests) {
    if (y.status === "stub") continue;
    for (const req of requirementsOf(y, pins)) if (!all.has(req.name)) all.set(req.name, req);
  }

  const pyMods = [...all.values()].filter((r) => r.kind === "python");
  const nodeEnv = probeNode(ENGINE_ROOT);
  const gitEnv = probeGit();
  const pyEnv = probePython(pyMods.map((r) => pyImportName(r.name)));

  // Deterministic order (python, then node, then bin; alphabetical within), so
  // two runs on the same machine render identically and a diff of two doctor
  // outputs is a diff of the environment rather than of a Map's insertion order.
  const KIND_RANK = { python: 0, node: 1, bin: 2 };
  const ordered = [...all.values()].sort((a, b) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));

  const requirements = {};
  for (const req of ordered) {
    if (req.kind === "python") {
      const imp = pyImportName(req.name);
      const detail = pyEnv.ok ? pyEnv.mods[imp] : "no python interpreter";
      requirements[req.name] = { kind: "python", import: imp, ok: pyEnv.ok && detail === null,
        detail: detail ?? null };
    } else if (req.kind === "node") {
      const p = probeNodeModule(req.name, root);
      requirements[req.name] = { kind: "node", ok: p.ok, detail: p.ok ? null : "not resolvable" };
    } else {
      const p = probeBinary(req.name);
      requirements[req.name] = { kind: "bin", ok: p.ok, detail: p.ok ? null : "not on PATH" };
    }
  }

  const report = diagnose({ manifests, pins,
    env: { node: nodeEnv, git: gitEnv, python: pyEnv, requirements } });

  // Mark the requirements that only opt-in providers need, so the rendering can
  // say "not installed" rather than "MISSING" for something no default run uses.
  for (const m of report.missing) {
    if (m.liveOnly && report.requirements[m.name]) {
      report.requirements[m.name].optional = true;
      report.requirements[m.name].note = `only \`check --live\` (${m.providers.join(", ")})`;
    }
  }

  const summary = SUMMARY(report);
  if (json) {
    let data = { node: report.node, git: report.git, python: report.python,
      requirements: report.requirements, providers: report.providers,
      hard: report.hard, remediation: report.remediation };
    let env = { v: 1, ok: report.ok, code: report.code, summary: summary.slice(0, 300),
      data, next: report.remediation.steps };
    // ADR-010's 8KB envelope cap. doctor writes nothing to disk - a diagnostic
    // that needs the repository to be healthy enough to spill a file is not a
    // diagnostic - so the overflow is trimmed, loudly.
    let text = JSON.stringify(env);
    if (text.length > 8192) {
      data = { ...data, providers: { ...data.providers, blocked: data.providers.blocked.slice(0, 10) } };
      env = { ...env, data, truncated: true };
      text = JSON.stringify(env);
    }
    process.stdout.write(text + "\n");
  } else {
    process.stdout.write(renderDoctor(report) + "\n");
  }
  return report.exit;
}
