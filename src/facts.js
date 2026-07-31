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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "./jcs.js";
import { factHash } from "./hash.js";
import { toPosix } from "./paths.js";
import { resolveClaims } from "./resolve.js";
import { REGISTRY, REGISTRY_ERROR, ENGINE_VERSION } from "./registry.js";

// fileURLToPath, never URL.pathname (Windows: "/D:/..." breaks join - item 10)
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  if (reg.detect.dirs) { // fixed repo-relative dirs (e.g. migration chains)
    for (const d of reg.detect.dirs) {
      if (existsSync(join(repoRoot, d))) return { applicable: true, via: "dir" };
    }
  }
  return { applicable: false };
}

// timeout classes from the provider contract - C is the heavy code tier
const TIMEOUTS = { A: 10_000, B: 30_000, C: 120_000, D: 60_000 };

function runProvider(reg, repoRoot, detectInfo, factEnv = {}) {
  let args = [repoRoot];
  if (reg.argMode === "schemaFile") {
    const schema = detectInfo.file ?? walk(repoRoot, (n) => n === "schema.prisma")[0];
    if (!schema) return { status: "not_applicable" };
    args = [schema];
  } else if (reg.argMode === "providerDir") {
    args = [reg.dir, repoRoot]; // generic .scm runtime: which provider + which repo
  }
  const spawnWith = (bin) => spawnSync(bin, [join(ENGINE_ROOT, reg.entry), ...args], {
    cwd: repoRoot, timeout: TIMEOUTS[reg.timeoutClass] ?? TIMEOUTS.D,
    maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, ...factEnv },
  });
  let r;
  if (reg.exec === "node") {
    r = spawnWith(process.execPath); // the running node - no PATH guessing
  } else {
    r = spawnWith("python3");
    if (r.error?.code === "ENOENT") r = spawnWith("python"); // Windows installs often lack a python3 shim
  }
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
        // provider-emitted package (declared ${facts:workspace-layout} read,
        // contract 9) wins; engine injection is the standalone-run fallback
        attrs: { path: m.path, package: m.package ?? pkgFor(m.path),
                 imports: (m.imports ?? []).map((i) => i.resolved ?? i.specifier).sort() } },
      provenance: { ...provenanceBase, source: [{ file: m.path }] },
    });
  }
  for (const s of raw.symbols ?? []) {
    // ADR-007 symbol identity: `ds <pkg> <version|.> <module-path>/<descriptor>`.
    // Suffix per SCIP shape: callables `().`, types `#`, terms `.`.
    const suffix = s.kind.includes("function") ? "()."
      : ["class", "interface", "type", "enum", "namespace"].some((k) => s.kind.includes(k)) ? "#" : ".";
    const pkg = s.package ?? pkgFor(s.path);
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

function liveTableFacts(raw, provenanceBase, declaredTables) {
  // Declared-beats-live (ADR-005): a live table already covered by a declared
  // provider is SKIPPED - exact lowercase match on the public schema only, no
  // pluralization guessing. Everything else lands with schema-qualified natural
  // keys (fact:db-schema/public.orders), the same payload shape as declared
  // tables, and INTROSPECTED confidence - so the ERD renders them unchanged.
  const declaredLower = new Set(declaredTables.map((n) => n.toLowerCase()));
  const facts = [];
  for (const t of raw.tables ?? []) {
    if (t.schema === "public" && declaredLower.has(t.table.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/${t.name}`,
      payload: { schema_version: 1, type: "table",
        attrs: { name: t.name,
          columns: (t.columns ?? []).map((c) => ({
            name: c.name, type: c.type, optional: !!c.nullable, list: false,
            attrs: c.default != null ? `default ${c.default}` : "",
          })),
          relations: (t.relations ?? []).map((r) => ({ field: r.field, target: r.target })) } },
      provenance: { ...provenanceBase, source: [{ kind: "live-catalog" }] },
    });
  }
  return { facts, gaps: [] };
}

function replayFacts(raw, provenanceBase, declaredTables, declaredEnums) {
  // The replay engine's catalog facts (doc 11 R1). Identity space is
  // schema-qualified SQL names (public.orders) like tbls-live; a DECLARED
  // provider's table/enum (prisma model space) covering the same lowercase
  // name wins and the replayed twin is SKIPPED - the same identity rule as
  // declared-beats-live, because the two id spellings can never meet inside
  // the resolver. Unifying the db identity space (@@map-aware) is named
  // follow-up work in doc 11 before replay may OVERRIDE declared facts.
  const declaredT = new Set(declaredTables.map((n) => n.toLowerCase()));
  const declaredE = new Set(declaredEnums.map((n) => n.toLowerCase()));
  const facts = [];
  for (const t of raw.tables ?? []) {
    if (t.schema === "public" && declaredT.has(t.table.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/${t.name}`,
      payload: { schema_version: 1, type: "table",
        attrs: { name: t.name,
          columns: (t.columns ?? []).map((c) => ({
            name: c.name, type: c.type, optional: !!c.nullable, list: false,
            attrs: c.default != null ? `default ${c.default}` : "",
          })),
          relations: (t.relations ?? []).map((r) => ({ field: r.field, target: r.target })) } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  for (const e of raw.enums ?? []) {
    const short = e.name.slice(e.name.indexOf(".") + 1);
    if (e.name.startsWith("public.") && declaredE.has(short.toLowerCase())) continue;
    facts.push({
      id: `fact:db-schema/enum.${e.name}`,
      payload: { schema_version: 1, type: "enum", attrs: { name: e.name, values: e.values ?? [] } },
      provenance: { ...provenanceBase, source: [{ kind: "migration-replay" }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? "unknown", file: w.file ?? null }));
  return { facts, gaps };
}

function policyFacts(raw, provenanceBase) {
  // Own capability so db-schema/* stays pure tables+enums (diagram noise
  // isolation + born-clean); db keys schema-qualified per ADR-007.
  const facts = [];
  for (const p of raw.policies ?? []) {
    facts.push({
      id: `fact:db-policies/policy.${p.schema}.${p.table}.${p.name}`,
      payload: { schema_version: 1, type: "policy",
        attrs: { schema: p.schema, table: p.table, name: p.name, command: p.command,
                 permissive: !!p.permissive, roles: p.roles ?? [],
                 using: p.using ?? null, with_check: p.with_check ?? null } },
      provenance: { ...provenanceBase, source: [{ file: p.file }] },
    });
  }
  for (const r of raw.rls ?? []) {
    facts.push({
      id: `fact:db-policies/rls.${r.schema}.${r.table}`,
      payload: { schema_version: 1, type: "rls",
        attrs: { schema: r.schema, table: r.table, enabled: !!r.enabled } },
      provenance: { ...provenanceBase, source: [{ file: r.file }] },
    });
  }
  return { facts, gaps: [] };
}

function churnFacts(raw, provenanceBase) {
  const facts = [];
  for (const f of raw.files ?? []) {
    facts.push({
      id: `fact:decision-history/${f.path}`,
      // History facts move with history by nature - they rank the doc plan
      // (hotspot x fan-in) and are excluded from coverage; binding prose to
      // them is possible but self-inflicted noise.
      payload: { schema_version: 1, type: "churn",
        attrs: { path: f.path, commits: f.commits, last: f.last, authors: f.authors } },
      provenance: { ...provenanceBase, source: [{ file: f.path }] },
    });
  }
  const gaps = (raw.warnings ?? []).map((w) => ({ kind: w.kind ?? "unknown", file: null }));
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

const capOf = (id) => id.startsWith("ds ") ? "module-graph" : id.slice(5, id.indexOf("/"));

export function extractAll(repoRootIn, { disable = [], live = null } = {}) {
  const repoRoot = resolve(repoRootIn); // subprocess cwd = repoRoot; args must be absolute
  if (REGISTRY_ERROR) {
    // fail closed and loudly - a half-loaded registry would masquerade as "no drift"
    return { factsById: new Map(), capabilities: {}, gaps: [], providerSetHash: null,
             toolError: `provider registry: ${REGISTRY_ERROR}` };
  }
  const disabled = new Set(disable);
  // live providers run ONLY under --live (network never enters the default path)
  const active = REGISTRY.filter((r) => !disabled.has(r.id) && (!r.live || live));
  const capabilities = {};
  const factsById = new Map();
  const claimsById = new Map(); // id -> every provider's claim (ADR-003 resolution input)
  const gaps = [];
  let toolError = null;

  // Canonical fact files - byte-stable, diffable, gitignored (ADR-004). Written
  // INCREMENTALLY as each capability's provider group completes (the registry is
  // capability-major topo order), so a later provider's declared ${facts:cap}
  // read (provider contract §9) sees the complete upstream file. The dir is a
  // pure cache: cleared first so a capability that dropped to zero facts can't
  // leave a stale file lying about the current state.
  const factsDir = join(repoRoot, ".keeldocs", "cache", "facts");
  rmSync(factsDir, { recursive: true, force: true });
  mkdirSync(factsDir, { recursive: true });
  const capFile = (cap) => join(factsDir, `${cap}.jsonl`);
  const writeCapFile = (cap) => {
    const list = [...factsById.values()].filter((f) => capOf(f.id) === cap)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!list.length) return;
    const lines = list.map((f) => jcs({ id: f.id, hash: f.hash, payload: f.payload, provenance: f.provenance }));
    writeFileSync(capFile(cap), lines.join("\n") + "\n");
  };

  for (let i = 0; i < active.length; i++) {
    const reg = active[i];
    const flushGroup = () => { // last provider of this capability just finished
      if (active[i + 1]?.capability !== reg.capability) writeCapFile(reg.capability);
    };
    const d = detect(reg, repoRoot);
    if (!d.applicable) {
      capabilities[reg.capability] ??= { status: "absent", providers: [] };
      flushGroup();
      continue;
    }
    // declared cross-capability reads, delivered by contract as env vars
    // pointing at the upstream capability's resolved fact file
    const factEnv = {};
    for (const cap of reg.factInputs ?? []) {
      if (existsSync(capFile(cap))) {
        factEnv[`KEELDOCS_FACTS_${cap.toUpperCase().replace(/-/g, "_")}`] = capFile(cap);
      }
    }
    if (reg.live) {
      // env-NAMED DSN (ADR-013): resolve the var here; the VALUE goes only into
      // the child env, never argv, never any report. Absence names the VAR only.
      const dsn = process.env[live.dsnEnv];
      const canned = process.env.KEELDOCS_TBLS_JSON; // deterministic test seam
      if (!dsn && !canned) {
        const cap = (capabilities[reg.capability] ??= { status: "absent", providers: [] });
        cap.providers.push(`${reg.id}@${reg.semver}`);
        cap.status = "failed";
        cap.reason = `live: env ${live.dsnEnv} is not set`;
        toolError = `${reg.id}: env ${live.dsnEnv} is not set ([live] dsn-env in keeldocs.toml names it)`;
        flushGroup();
        continue;
      }
      if (dsn) factEnv.KEELDOCS_DSN = dsn;
    }
    const run = runProvider(reg, repoRoot, d, factEnv);
    const cap = (capabilities[reg.capability] ??= { status: "absent", providers: [] });
    cap.providers.push(`${reg.id}@${reg.semver}`);
    if (run.status === "failed") {
      cap.status = "failed";
      cap.reason = run.reason;
      toolError = `${reg.id}: ${run.reason}`; // fail closed - never masquerade as "no drift"
      flushGroup();
      continue;
    }
    if (run.status !== "ok") { flushGroup(); continue; }
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
      : reg.capability === "decision-history"
      ? churnFacts(run.raw, provenanceBase)
      : reg.capability === "db-policies"
      ? policyFacts(run.raw, provenanceBase)
      : reg.id === "sql-replay"
      ? replayFacts(run.raw, provenanceBase,
          [...factsById.values()].filter((f) => f.payload.type === "table").map((f) => f.payload.attrs.name),
          [...factsById.values()].filter((f) => f.payload.type === "enum").map((f) => f.payload.attrs.name))
      : reg.id === "tbls-live"
      ? liveTableFacts(run.raw, provenanceBase,
          [...factsById.values()].filter((f) => f.payload.type === "table").map((f) => f.payload.attrs.name))
      : schemaFacts(run.raw, provenanceBase, toPosix(relative(repoRoot, d.file ?? "")));
    for (const f of norm.facts) {
      f.hash = factHash(f.payload);
      const prior = claimsById.get(f.id);
      if (!prior) {
        claimsById.set(f.id, [f]);
        factsById.set(f.id, f);
      } else {
        // ADR-003: a second claim on the same id resolves by the pure total
        // order (lattice -> precedence -> provider id) - run order irrelevant
        prior.push(f);
        factsById.set(f.id, resolveClaims(f.id, prior, reg.capability).winner);
      }
    }
    gaps.push(...norm.gaps);
    if (cap.status !== "failed") cap.status = "ok";
    flushGroup();
  }

  // Disagreeing claims become conflict records: every claim, the winner, the
  // deciding rule (ADR-003 - "conflicts as facts", so silent averaging is
  // structurally impossible). Corroborating claims (same hash) report nothing.
  const conflicts = [];
  for (const [id, claims] of claimsById) {
    if (claims.length < 2) continue;
    const { conflict } = resolveClaims(id, claims, capOf(id));
    if (conflict) conflicts.push(conflict);
  }
  conflicts.sort((a, b) => a.id.localeCompare(b.id));
  for (const c of conflicts) {
    const cap = capabilities[capOf(c.id)];
    if (cap) cap.conflicts = (cap.conflicts ?? 0) + 1; // noted on the card
  }

  // Cache identity covers the EFFECTIVE provider set - disabling a provider
  // via keeldocs.toml is a different extraction universe, so it must re-key.
  const providerSetHash = createHash("sha256")
    .update([...active.map((r) => `${r.id}@${r.semver}`)].sort().join(",") + `|engine:${ENGINE_VERSION.split(".")[0]}`)
    .digest("hex").slice(0, 16);

  return { factsById, capabilities, gaps, providerSetHash, toolError, conflicts };
}
