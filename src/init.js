// keeldocs init - the wow loop (ADR-012/D5), zero LLM calls:
//   detection card -> deterministic extraction -> doc lie-detector with
//   receipts -> anchored starter docs (born clean) -> plan.
// Safety (ADR-010 CLI backstop, agent-independent): DRY-RUN by default; --yes
// applies writes; existing files are NEVER overwritten (skip + report).
// Exit codes: 0 success (lies are the value, not a failure) | 2 tool error.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { extractAll } from "./facts.js";
import { renderAll } from "./render.js";
import { detectLies } from "./lies.js";
import { parseDoc } from "./anchors.js";
import { evaluate, coverage, isCoverageSurface } from "./drift.js";
import { loadJournal, effective } from "./journal.js";
import { loadConfig, docPathsOf, extractOpts } from "./config.js";
import { toPosix } from "./paths.js";
import { ENGINE_VERSION } from "./registry.js";

function gitHead(root) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Plan = undocumented CONCRETE surfaces, ranked hotspot x fan-in (D5): churn
// from decision-history, fan-in from module-graph import edges. Same whitelist
// as coverage: packages/externals/symbols are not owed docs. Shared by init
// (the report's plan) and interview (document-next cards) - one ranking.
export function buildPlan(factsById, documented) {
  const churnBy = new Map([...factsById.values()].filter((f) => f.payload.type === "churn")
    .map((f) => [f.payload.attrs.path, f.payload.attrs.commits]));
  const fanIn = new Map();
  const modulePaths = new Set([...factsById.values()].filter((f) => f.payload.type === "module")
    .map((f) => f.payload.attrs.path));
  for (const f of factsById.values()) {
    if (f.payload.type !== "module") continue;
    for (const imp of f.payload.attrs.imports) {
      if (modulePaths.has(imp)) fanIn.set(imp, (fanIn.get(imp) ?? 0) + 1);
    }
  }
  return [...factsById.values()].filter((f) => isCoverageSurface(f) && !documented.has(f.id))
    .map((f) => {
      const file = f.provenance?.source?.[0]?.file ?? null;
      const hot = { commits: file ? (churnBy.get(file) ?? 0) : 0, fanIn: file ? (fanIn.get(file) ?? 0) : 0 };
      return { surface: f.id, action: "document", hot, _score: (hot.commits + 1) * (hot.fanIn + 1) };
    })
    .sort((a, b) => b._score - a._score || a.surface.localeCompare(b.surface))
    .map(({ _score, ...p }) => p);
}

// The two git files the spec ASSUMES exist and that nothing ever wrote.
//
// Spec §6 does not describe `merge=union` as a nicety: it is the premise the
// journal's whole reader contract rests on ("`merge=union` via `.gitattributes`
// written by `init` - THEREFORE entries are self-contained, idempotent,
// order-independent"). Nothing in the reader resolves a conflict, because the
// spec says a conflict cannot arise. `grep -rn gitattributes src/ bin/` returned
// nothing, so it did arise: two branches that each tombstone one finding produce
// `CONFLICT (content)` on a strictly append-only file, and whoever resolves it
// by hand - or does not - leaves `<<<<<<< HEAD`, `=======` and `>>>>>>> theirs`
// in a file the reader parses line by line. §7's "index/facts/graph: gitignored"
// is the same shape of assumption about `.keeldocs/cache/` and `.keeldocs/out/`,
// which are run state: a repository that commits them diffs its own cache.
//
// APPEND, and only ever append. `init`'s rule for a file it did not write is to
// skip it whole (a document is human-authored prose and replacing it is theft),
// but these two are line-oriented rule lists that many tools contribute to, so
// the faithful reading of "never overwrite" is "add the missing line, touch no
// existing byte". Membership is tested line by line, which makes a re-run
// byte-idempotent and leaves an unrelated `.gitattributes` exactly as it was.
//
// The patterns are anchored (they contain a `/`, so git resolves them against
// this file's directory) rather than `**/`-prefixed, because `loadJournal` and
// the report writer only ever address the repo-root `.keeldocs`. A `**/` form
// would claim a scope the engine does not have.
const GIT_FILES = [
  [".gitattributes", "spec section 6 - the journal is append-only; union-merge keeps two branches' decisions",
   [".keeldocs/decisions.jsonl merge=union"]],
  [".gitignore", "spec section 7 - run state, not repository state",
   [".keeldocs/cache/", ".keeldocs/out/"]],
];

export function ensureGitFiles(root, yes) {
  const written = [], skipped = [], planned = [];
  for (const [name, why, rules] of GIT_FILES) {
    const abs = join(root, name);
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = rules.filter((r) => !have.has(r));
    if (!missing.length) { skipped.push(name); continue; }
    planned.push(name);
    if (!yes) continue;
    // Existing bytes are reproduced verbatim; a file that did not end in a
    // newline gets one before anything is appended, or the append would corrupt
    // the user's own last rule.
    const head = existing === "" ? "" : (existing.endsWith("\n") ? existing : existing + "\n");
    writeFileSync(abs, `${head}${head ? "\n" : ""}# keeldocs (${why})\n${missing.join("\n")}\n`);
    written.push(name);
  }
  return { written, skipped, planned };
}

export function runInit({ root, json, yes, live = false }) {
  const cfg = loadConfig(root);
  if (!cfg.ok) {
    const env = { v: 1, ok: false, code: "CONFIG", summary: cfg.error.slice(0, 300), data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }
  if (live && (process.env.CI === "true" || process.env.CI === "1")) {
    const env = { v: 1, ok: false, code: "CONFIG",
      summary: "--live is disabled in CI: network must never enter the pure-function path (run it locally)",
      data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }
  let result;
  try {
    result = doInit(root, yes, cfg.config, live);
  } catch (err) {
    const env = { v: 1, ok: false, code: "TOOL_ERROR",
      summary: `init failed: ${String(err.message).slice(0, 200)}`, data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }
  const { report, applied } = result;
  if (report.toolError) {
    const env = { v: 1, ok: false, code: "TOOL_ERROR",
      summary: `tooling error: ${report.toolError}`.slice(0, 300), data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }

  const outDir = join(root, ".keeldocs", "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `init-${report.meta.head ? report.meta.head.slice(0, 8) : "nogit"}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 1) + "\n");

  const l = report.lies;
  const redNote = report.redactions?.length ? `SECURITY: ${report.redactions.length} secret(s) redacted from generated docs - review before commit; ` : "";
  const summary = (redNote + `${l.findings.length} doc lie(s) found with receipts; ` +
    (applied
      ? `${report.docs.written.length} starter doc(s) written`
      : `${report.docs.planned.length} starter doc(s) ready (dry-run - rerun with --yes)`) +
    (report.docs.skipped.length ? `, ${report.docs.skipped.length} skipped (already exist)` : "") +
    `; coverage ${report.coverage.before.pct ?? 0}% -> ${report.coverage.after.pct ?? 0}% of ${report.coverage.after.total} surfaces` +
    (applied ? "; drift tripwire armed" : "")).slice(0, 300);

  const envelope = {
    v: 1, ok: true, code: applied ? "INITIALIZED" : "DRY_RUN", summary,
    data: {
      card: report.card,
      lies: l.findings.slice(0, 10).map((f) => ({
        class: f.class, claim: f.claim, doc: f.doc, line: f.line, receipt: f.receipt,
        ...(f.candidates?.length ? { candidates: f.candidates } : {}),
      })),
      liesSuppressed: l.suppressed,
      ...(report.redactions?.length ? { redactions: report.redactions } : {}),
      docs: report.docs,
      gitFiles: report.gitFiles,
      coverage: report.coverage,
      plan: report.plan.slice(0, 10),
    },
    truncated: l.findings.length > 10 || report.plan.length > 10,
    full: toPosix(relative(root, outPath)),
    next: applied ? ["keeldocs check", "commit the generated docs"] : ["keeldocs init --yes"],
  };

  if (json) {
    let s = JSON.stringify(envelope);
    if (s.length > 8192) {
      envelope.data.lies = envelope.data.lies.slice(0, 5);
      envelope.data.plan = [];
      envelope.truncated = true;
      s = JSON.stringify(envelope);
    }
    process.stdout.write(s + "\n");
  } else {
    process.stdout.write(humanize(envelope, applied));
  }
  return 0;
}

function doInit(root, yes, config, live = false) {
  const { factsById, capabilities, providerSetHash, toolError, conflicts, gaps } =
    extractAll(root, { ...extractOpts(config),
      live: live ? { dsnEnv: config.live["dsn-env"] } : null });
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;
  const existingDocs = () => docPathsOf(root, config.docs.dirs);

  // Detection card - correctable before anything else runs (the agent surfaces it).
  const card = {
    package: pkg?.name ?? null,
    capabilities: Object.fromEntries(Object.entries(capabilities)
      .map(([k, v]) => [k, { status: v.status, providers: v.providers ?? [],
        ...(v.conflicts ? { conflicts: v.conflicts } : {}) }])), // ADR-003: noted on the card
    facts: factsById.size,
  };

  // Lie-detector runs against docs that exist BEFORE anything is written.
  const preDocs = existingDocs();
  const lies = detectLies({ root, docPaths: preDocs, factsById, pkg });

  // Starter docs - never overwrite; an existing file is human-owned, full stop.
  const redactions = [];
  const rendered = renderAll(factsById, redactions);
  const written = [], skipped = [], planned = [];
  for (const r of rendered) {
    const abs = join(root, r.path);
    if (existsSync(abs)) { skipped.push(r.path); continue; }
    planned.push(r.path);
    if (yes) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, r.content);
      written.push(r.path);
    }
  }

  // After the docs, before coverage: neither file is a document and neither is
  // read by any provider, so where it sits cannot move a number - it sits here
  // because this is where `init` stops proposing and starts writing.
  const gitFiles = ensureGitFiles(root, yes);

  const journal = effective(loadJournal(root), "9999-12-31T00:00:00Z");
  const covOf = (docPaths) => {
    const anchors = [], regions = [];
    for (const d of docPaths) {
      const parsed = parseDoc(readFileSync(join(root, d), "utf8"), d);
      anchors.push(...parsed.anchors);
      regions.push(...parsed.regions);
    }
    const ev = evaluate({ anchors, regions, factsById, capabilities, journal });
    return { cov: coverage(factsById, ev.documented), documented: ev.documented };
  };
  const before = covOf(preDocs);
  const after = yes ? covOf(existingDocs()) : before;

  const plan = buildPlan(factsById, after.documented);

  return {
    applied: !!yes,
    report: {
      v: 1,
      meta: { engine: `keeldocs@${ENGINE_VERSION}`, head: gitHead(root), providerSetHash,
              mode: yes ? "apply" : "dry-run" },
      card, lies, toolError, redactions,
      docs: { written, skipped, planned },
      gitFiles,
      coverage: { before: before.cov, after: after.cov },
      plan,
      // absent when empty so goldens stay byte-stable
      ...(conflicts?.length ? { conflicts } : {}),         // ADR-003 records
      ...(gaps?.length ? { extractionGaps: gaps } : {}),   // incl. E10 hostile-content drops
    },
  };
}

function humanize(envelope, applied) {
  const d = envelope.data;
  const lines = [`keeldocs init - ${envelope.code}`, ""];
  lines.push(`  stack: ${d.card.package ?? "(no package.json)"} | ${Object.entries(d.card.capabilities)
    .map(([k, v]) => `${k}:${v.status}${v.providers.length ? ` (${v.providers.join(",")})` : ""}`).join(" | ")} | ${d.card.facts} facts`);
  lines.push("");
  if (d.lies.length) {
    lines.push(`  Doc lie-detector - ${d.lies.length} finding(s)${d.liesSuppressed ? ` (${d.liesSuppressed} candidate(s) suppressed)` : ""}:`);
    for (const f of d.lies) {
      lines.push(`    [${f.class}] ${f.doc}:${f.line}  "${f.claim}"`);
      lines.push(`      receipt: ${f.receipt}${f.candidates?.length ? `  did you mean: ${f.candidates.join(", ")}` : ""}`);
    }
  } else {
    lines.push("  Doc lie-detector: no lies found in existing docs.");
  }
  lines.push("");
  lines.push(applied
    ? `  wrote: ${d.docs.written.join(", ") || "(nothing new)"}`
    : `  would write: ${d.docs.planned.join(", ") || "(nothing - no undocumented facts or no facts)"}`);
  if (d.docs.skipped.length) lines.push(`  skipped (already exist, human-owned): ${d.docs.skipped.join(", ")}`);
  const g = d.gitFiles ?? { written: [], planned: [], skipped: [] };
  if (g.planned.length) {
    lines.push(applied
      ? `  git rules appended (existing lines untouched): ${g.written.join(", ")}`
      : `  would append git rules to: ${g.planned.join(", ")}`);
  }
  lines.push(`  coverage: ${d.coverage.before.pct ?? 0}% -> ${d.coverage.after.pct ?? 0}% of ${d.coverage.after.total} surfaces`);
  if (d.plan.length) lines.push(`  plan: ${d.plan.length} surface(s) still undocumented (full report has the list)`);
  lines.push("", applied ? "  next: keeldocs check" : "  apply with: keeldocs init --yes", "");
  return lines.join("\n");
}
