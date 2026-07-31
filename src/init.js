// keeldocs init - the wow loop (ADR-012/D5), zero LLM calls:
//   detection card -> deterministic extraction -> doc lie-detector with
//   receipts -> anchored starter docs (born clean) -> plan.
// Safety (ADR-010 CLI backstop, agent-independent): DRY-RUN by default; --yes
// applies writes; existing files are NEVER overwritten (skip + report).
// Exit codes: 0 success (lies are the value, not a failure) | 2 tool error.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { extractAll } from "./facts.js";
import { renderAll } from "./render.js";
import { detectLies } from "./lies.js";
import { parseDoc } from "./anchors.js";
import { evaluate, coverage, isCoverageSurface } from "./drift.js";
import { loadJournal, effective } from "./journal.js";
import { ENGINE_VERSION } from "./registry.js";

function existingDocs(root) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if ([".keeldocs", "node_modules", "golden", ".git"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith(".md")) out.push(relative(root, p));
    }
  };
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) rec(docsDir);
  if (existsSync(join(root, "README.md"))) out.push("README.md");
  return out.sort();
}

function gitHead(root) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function runInit({ root, json, yes }) {
  let result;
  try {
    result = doInit(root, yes);
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
      coverage: report.coverage,
      plan: report.plan.slice(0, 10),
    },
    truncated: l.findings.length > 10 || report.plan.length > 10,
    full: relative(root, outPath),
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

function doInit(root, yes) {
  const { factsById, capabilities, providerSetHash, toolError } = extractAll(root);
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;

  // Detection card - correctable before anything else runs (the agent surfaces it).
  const card = {
    package: pkg?.name ?? null,
    capabilities: Object.fromEntries(Object.entries(capabilities)
      .map(([k, v]) => [k, { status: v.status, providers: v.providers ?? [] }])),
    facts: factsById.size,
  };

  // Lie-detector runs against docs that exist BEFORE anything is written.
  const preDocs = existingDocs(root);
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
  const after = yes ? covOf(existingDocs(root)) : before;

  // Plan = undocumented CONCRETE surfaces (the honest v0.1 hotspot proxy) -
  // same whitelist as coverage: packages and external services are not owed docs.
  const plan = [...factsById.values()].filter((f) => isCoverageSurface(f) && !after.documented.has(f.id))
    .map((f) => f.id).sort().map((id) => ({ surface: id, action: "document" }));

  return {
    applied: !!yes,
    report: {
      v: 1,
      meta: { engine: `keeldocs@${ENGINE_VERSION}`, head: gitHead(root), providerSetHash,
              mode: yes ? "apply" : "dry-run" },
      card, lies, toolError, redactions,
      docs: { written, skipped, planned },
      coverage: { before: before.cov, after: after.cov },
      plan,
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
  lines.push(`  coverage: ${d.coverage.before.pct ?? 0}% -> ${d.coverage.after.pct ?? 0}% of ${d.coverage.after.total} surfaces`);
  if (d.plan.length) lines.push(`  plan: ${d.plan.length} surface(s) still undocumented (full report has the list)`);
  lines.push("", applied ? "  next: keeldocs check" : "  apply with: keeldocs init --yes", "");
  return lines.join("\n");
}
