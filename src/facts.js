// Fact extraction: detect providers, run them as subprocesses (the provider
// contract - JSON on stdout, engine writes all artifacts), normalize raw
// extractor output into the fact schema, write canonical JSONL fact files.
//
// ADR-008 discipline: the HASHED payload is {schema_version, type, attrs} only.
// Provider identity, source files/lines, engine version = provenance, OUTSIDE
// the hash - provider swaps and upgrades must never manufacture drift.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { jcs } from "./jcs.js";
import { factHash } from "./hash.js";
import { REGISTRY, ENGINE_VERSION } from "./registry.js";

const ENGINE_ROOT = join(new URL(".", import.meta.url).pathname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".keeldocs", "golden", "coverage"]);

function walk(root, pred, out = [], dir = root) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(root, pred, out, p);
    else if (pred(name)) out.push(p);
  }
  return out;
}

function detect(reg, repoRoot) {
  if (reg.detect.always) return { applicable: true, via: "always" };
  const pkgPath = join(repoRoot, "package.json");
  if (reg.detect.deps && existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (reg.detect.deps.some((d) => d in all)) return { applicable: true, via: "dependency" };
    } catch { /* unreadable manifest -> fall through to file detection */ }
  }
  if (reg.detect.files) {
    const found = walk(repoRoot, (n) => reg.detect.files.includes(n));
    if (found.length) return { applicable: true, via: "file", file: found[0] };
  }
  return { applicable: false };
}

function runProvider(reg, repoRoot, detectInfo) {
  let arg = repoRoot;
  if (reg.argMode === "schemaFile") {
    const schema = detectInfo.file ?? walk(repoRoot, (n) => n === "schema.prisma")[0];
    if (!schema) return { status: "not_applicable" };
    arg = schema;
  }
  const r = spawnSync("python3", [join(ENGINE_ROOT, reg.entry), arg], {
    cwd: repoRoot, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
  });
  if (r.status !== 0 || r.error) {
    return { status: "failed", reason: r.error ? String(r.error.message) : `rc=${r.status}`,
             stderr: (r.stderr || "").slice(-400) };
  }
  try {
    return { status: "ok", raw: JSON.parse(r.stdout) };
  } catch {
    return { status: "failed", reason: "bad-json-output" };
  }
}

function envFacts(raw, provenanceBase) {
  const facts = [];
  for (const v of raw.vars ?? []) {
    facts.push({
      id: `fact:config-surface/${v.name}`,
      // Low-noise drift semantics: the hashed payload carries the var's STATUS
      // (read anywhere? declared anywhere?), not every read site - adding a
      // second read of DATABASE_URL is not documentation drift. Sites live in
      // provenance. Values do not exist in this schema, structurally (ADR-013).
      payload: { schema_version: 1, type: "env-var",
        attrs: { name: v.name, read_in_code: !!v.read_in_code, declared_in_example: !!v.declared_in_example } },
      provenance: { ...provenanceBase,
        source: (v.sources ?? []).slice(0, 20).map((s) => ({ file: s.file, line: s.line, kind: s.kind })) },
    });
  }
  return { facts, gaps: [] };
}

function moduleGraphFacts(raw, provenanceBase, packages) {
  // Longest-prefix package owner; "." (single-package root) matches everything.
  const pkgFor = (path) => {
    let best = null;
    for (const p of packages) {
      if (p.path === "." || path === p.path || path.startsWith(p.path + "/")) {
        if (!best || p.path.length > best.path.length) best = p;
      }
    }
    return best?.name ?? ".";
  };
  const facts = [];
  for (const m of raw.modules ?? []) {
    facts.push({
      id: `fact:module-graph/${m.path}`,
      payload: { schema_version: 1, type: "module",
        attrs: { path: m.path, package: pkgFor(m.path),
                 imports: (m.imports ?? []).map((i) => i.resolved ?? i.specifier).sort() } },
      provenance: { ...provenanceBase, source: [{ file: m.path }] },
    });
  }
  for (const s of raw.symbols ?? []) {
    // ADR-007 symbol identity: `ds <pkg> <version|.> <module-path>/<descriptor>`.
    // Suffix per SCIP shape: callables `().`, types `#`, terms `.`.
    const suffix = s.kind.includes("function") ? "()."
      : ["class", "interface", "type", "enum", "namespace"].some((k) => s.kind.includes(k)) ? "#" : ".";
    const pkg = pkgFor(s.path);
    facts.push({
      id: `ds ${pkg} . ${s.path}/${s.name}${suffix}`,
      // sigs are the hashed declaration shape (E2-validated); the nameless
      // variants are provenance-only matching aids for re-anchoring, and the
      // module path lives in the ID + attrs so a move IS an identity change (S1).
      payload: { schema_version: 1, type: "symbol",
        attrs: { name: s.name, module: s.path, package: pkg, kind: s.kind, sigs: s.sigs } },
      provenance: { ...provenanceBase, source: [{ file: s.path }], nameless: s.nameless },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function packageFacts(raw, provenanceBase) {
  const facts = [];
  for (const p of raw.packages ?? []) {
    facts.push({
      id: `fact:workspace-layout/${p.name}`,
      // manager lives in the hashed payload deliberately: migrating pnpm->npm
      // IS a documented-architecture change, not provider noise.
      payload: { schema_version: 1, type: "package",
        attrs: { name: p.name, path: p.path, manager: raw.manager } },
      provenance: { ...provenanceBase, source: raw.file ? [{ file: raw.file }] : [] },
    });
  }
  return { facts, gaps: [] };
}

function serviceFacts(raw, provenanceBase) {
  const facts = [];
  for (const s of raw.services ?? []) {
    facts.push({
      id: `fact:services-topology/${s.name}`,
      // kind is the design's owned-vs-external split: build: = yours (owned),
      // image-only = someone else's software you depend on (external).
      payload: { schema_version: 1, type: "service",
        attrs: { name: s.name, kind: s.kind, image: s.image ?? null, build: s.build ?? null,
                 ports: s.ports ?? [], depends_on: s.depends_on ?? [] } },
      provenance: { ...provenanceBase, source: raw.file ? [{ file: raw.file }] : [] },
    });
  }
  return { facts, gaps: [] };
}

function endpointFacts(raw, provenanceBase, repoRoot) {
  const facts = [];
  for (const e of raw.endpoints ?? []) {
    facts.push({
      id: `fact:http-endpoints/${e.method} ${e.path}`,
      payload: { schema_version: 1, type: "endpoint", attrs: { method: e.method, path: e.path } },
      provenance: { ...provenanceBase, source: [{ file: e.file, ...(e.line ? { line: e.line } : {}) }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function schemaFacts(raw, provenanceBase, schemaFile) {
  const facts = [];
  const src = [{ file: schemaFile }];
  // Enum-typed fields are COLUMNS, not relations - the extractor's uppercase
  // heuristic can't tell enums from model refs without this cross-check
  // (found by init-scenario: `status Status` was silently dropped).
  const enumNames = new Set((raw.enums ?? []).map((e) => e.name));
  for (const m of raw.models ?? []) {
    const columns = (m.fields ?? []).filter((f) => !f.is_relation_field || f.relation || enumNames.has(f.type)).map((f) => ({
      name: f.name, type: f.type, optional: !!f.optional, list: !!f.list, attrs: f.attrs ?? "",
    })); // ordered field - source order is semantic (ADR-008)
    const relations = (m.fields ?? []).filter((f) => f.relation).map((f) => ({
      field: f.name, target: f.type,
      fields: f.relation.fields ?? [], references: f.relation.references ?? [],
    })).sort((a, b) => a.field.localeCompare(b.field)); // set field - sorted by natural key
    facts.push({
      id: `fact:db-schema/${m.name}`,
      payload: { schema_version: 1, type: "table", attrs: { name: m.name, columns, relations } },
      provenance: { ...provenanceBase, source: src },
    });
  }
  for (const e of raw.enums ?? []) {
    facts.push({
      id: `fact:db-schema/enum.${e.name}`,
      payload: { schema_version: 1, type: "enum", attrs: { name: e.name, values: e.values ?? [] } },
      provenance: { ...provenanceBase, source: src },
    });
  }
  return { facts, gaps: [] };
}

export function extractAll(repoRootIn) {
  const repoRoot = resolve(repoRootIn); // subprocess cwd = repoRoot; args must be absolute
  const capabilities = {};
  const factsById = new Map();
  const gaps = [];
  let toolError = null;

  for (const reg of REGISTRY) {
    const d = detect(reg, repoRoot);
    if (!d.applicable) {
      capabilities[reg.capability] ??= { status: "absent", providers: [] };
      continue;
    }
    const run = runProvider(reg, repoRoot, d);
    const cap = (capabilities[reg.capability] ??= { status: "absent", providers: [] });
    cap.providers.push(`${reg.id}@${reg.semver}`);
    if (run.status === "failed") {
      cap.status = "failed";
      cap.reason = run.reason;
      toolError = `${reg.id}: ${run.reason}`; // fail closed - never masquerade as "no drift"
      continue;
    }
    if (run.status !== "ok") continue;
    const provenanceBase = { provider: `${reg.id}@${reg.semver}`,
      confidence: reg.confidence ?? (reg.tier === "declarative" ? "PATTERN" : "PARSED") };
    const norm = reg.capability === "http-endpoints"
      ? endpointFacts(run.raw, provenanceBase, repoRoot)
      : reg.capability === "config-surface"
      ? envFacts(run.raw, provenanceBase)
      : reg.capability === "workspace-layout"
      ? packageFacts(run.raw, provenanceBase)
      : reg.capability === "services-topology"
      ? serviceFacts(run.raw, provenanceBase)
      : reg.capability === "module-graph"
      ? moduleGraphFacts(run.raw, provenanceBase,
          [...factsById.values()].filter((f) => f.payload.type === "package").map((f) => f.payload.attrs))
      : schemaFacts(run.raw, provenanceBase, relative(repoRoot, d.file ?? ""));
    for (const f of norm.facts) {
      f.hash = factHash(f.payload);
      factsById.set(f.id, f); // single provider per capability in v0.1 - conflicts land with resolution
    }
    gaps.push(...norm.gaps);
    if (cap.status !== "failed") cap.status = "ok";
  }

  // Canonical fact files - byte-stable, diffable, gitignored (ADR-004).
  // The dir is a pure cache: clear it first so a capability that dropped to
  // zero facts can't leave a stale file lying about the current state.
  const factsDir = join(repoRoot, ".keeldocs", "cache", "facts");
  rmSync(factsDir, { recursive: true, force: true });
  mkdirSync(factsDir, { recursive: true });
  const byCap = {};
  for (const f of factsById.values()) {
    // second namespace (ADR-007): `ds ...` symbol ids belong to module-graph
    const cap = f.id.startsWith("ds ") ? "module-graph" : f.id.slice(5, f.id.indexOf("/"));
    (byCap[cap] ??= []).push(f);
  }
  for (const [cap, list] of Object.entries(byCap)) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    const lines = list.map((f) => jcs({ id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance }));
    writeFileSync(join(factsDir, `${cap}.jsonl`), lines.join("\n") + "\n");
  }
  const providerSetHash = createHash("sha256")
    .update([...REGISTRY.map((r) => `${r.id}@${r.semver}`)].sort().join(",") + `|engine:${ENGINE_VERSION.split(".")[0]}`)
    .digest("hex").slice(0, 16);

  return { factsById, capabilities, gaps, providerSetHash, toolError };
}
