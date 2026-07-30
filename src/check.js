// keeldocs check - drift + verify + coverage. Deterministic by contract:
// no LLM, no network, no wall clock in fact/drift computation. Policy state
// (snooze expiry) uses wall clock locally and the HEAD COMMIT TIME in --ci,
// so CI output is a pure function of (SHA, committed journal) - spec §6.
// Exit codes: 0 clean | 1 findings | 2 tool/config error | 3 budget-degraded.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDoc } from "./anchors.js";
import { loadJournal, effective } from "./journal.js";
import { extractAll } from "./facts.js";
import { evaluate, coverage } from "./drift.js";
import { ENGINE_VERSION } from "./registry.js";

const DRIFT_STATES = new Set(["stale", "tampered", "dead"]);

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findDocs(repoRoot) {
  const docs = [];
  const docsDir = join(repoRoot, "docs");
  const skip = new Set(["node_modules", ".git", ".keeldocs", "golden"]);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) docs.push(p);
    }
  };
  if (existsSync(docsDir)) walk(docsDir);
  const readme = join(repoRoot, "README.md");
  if (existsSync(readme)) docs.push(readme);
  return docs.sort();
}

export function runCheck({ root, json, ci }) {
  const repoRoot = root;
  let report;
  try {
    report = buildReport(repoRoot, ci);
  } catch (err) {
    return emit(json, 2, {
      v: 1, ok: false, code: "TOOL_ERROR",
      summary: `check failed: ${String(err.message).slice(0, 200)}`, data: {}, next: [],
    }, null);
  }

  const exit = report.toolError ? 2 : report.counts.driftTotal > 0 ? 1 : 0;
  const code = report.toolError ? "TOOL_ERROR" : exit === 1 ? "DRIFT_FOUND" : "CLEAN";

  // Full report spills to .keeldocs/out; stdout stays inside the 8KB envelope cap.
  const outDir = join(repoRoot, ".keeldocs", "out");
  mkdirSync(outDir, { recursive: true });
  const outName = `check-${report.meta.head ? report.meta.head.slice(0, 8) : "nogit"}.json`;
  const outPath = join(outDir, outName);
  writeFileSync(outPath, JSON.stringify(report, null, 1) + "\n");

  const c = report.counts;
  const covTxt = report.coverage.pct === null ? "no facts" : `${report.coverage.documented}/${report.coverage.total} surfaces documented (${report.coverage.pct}%)`;
  const summary = report.toolError
    ? `tooling error: ${report.toolError}`.slice(0, 300)
    : `${c.driftTotal} drift finding(s) [stale ${c.stale ?? 0}, dead ${c.dead ?? 0}, tampered ${c.tampered ?? 0}] across ${report.meta.docsScanned} doc(s); ${c.clean ?? 0} clean; ${covTxt}`.slice(0, 300);

  const top = report.findings.filter((f) => DRIFT_STATES.has(f.state)).slice(0, 20)
    .map((f) => ({ id: f.id, state: f.state, doc: f.doc, line: f.line,
                   ...(f.missing ? { missing: f.missing } : {}),
                   ...(f.candidates && f.candidates.length ? { candidates: f.candidates } : {}) }));

  const envelope = {
    v: 1, ok: exit === 0, code, summary,
    data: { counts: c, coverage: report.coverage, top },
    truncated: report.findings.length > top.length,
    full: relative(repoRoot, outPath),
    next: exit === 1 ? ["keeldocs sync"] : [],
  };
  return emit(json, exit, envelope, report);
}

function buildReport(repoRoot, ci) {
  // now: policy clock only (snooze expiry) - HEAD commit time in CI (spec §6)
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const nowIso = ci
    ? (git(repoRoot, ["show", "-s", "--format=%cI", "HEAD"]) ?? "9999-12-31T00:00:00Z")
    : new Date().toISOString();

  const { factsById, capabilities, gaps, providerSetHash, toolError } = extractAll(repoRoot);
  const journal = effective(loadJournal(repoRoot), nowIso);

  const anchors = [], regions = [], quarantined = [];
  const docPaths = findDocs(repoRoot);
  for (const p of docPaths) {
    const parsed = parseDoc(readFileSync(p, "utf8"), relative(repoRoot, p));
    anchors.push(...parsed.anchors);
    regions.push(...parsed.regions);
    quarantined.push(...parsed.quarantined);
  }

  const { findings, documented } = evaluate({ anchors, regions, factsById, capabilities, journal });
  const cov = coverage(factsById, documented);

  const counts = {};
  for (const f of findings) counts[f.state] = (counts[f.state] ?? 0) + 1;
  counts.driftTotal = findings.filter((f) => DRIFT_STATES.has(f.state)).length;

  return {
    v: 1,
    meta: { engine: `keeldocs@${ENGINE_VERSION}`, head, providerSetHash,
            docsScanned: docPaths.length, mode: ci ? "ci" : "local" },
    capabilities, counts, findings, coverage: cov,
    quarantined, extractionGaps: gaps,
  };
}

function emit(json, exit, envelope, report) {
  if (json) {
    let out = JSON.stringify(envelope);
    if (out.length > 8192) { // hard envelope cap - trim top findings until it fits
      envelope.data.top = envelope.data.top.slice(0, 5);
      envelope.truncated = true;
      out = JSON.stringify(envelope);
    }
    process.stdout.write(out + "\n");
  } else {
    process.stdout.write(humanize(envelope, report));
  }
  return exit;
}

function humanize(envelope, report) {
  const lines = [`keeldocs check - ${envelope.code}`, envelope.summary, ""];
  for (const f of envelope.data.top ?? []) {
    lines.push(`  ${f.state.toUpperCase().padEnd(9)} ${f.doc}:${f.line}  ${f.id}${f.missing ? `  (missing: ${f.missing.join(", ")})` : ""}`);
    if (f.candidates?.length) lines.push(`            candidates: ${f.candidates.join(", ")}`);
  }
  if (report?.quarantined?.length) lines.push(`  note: ${report.quarantined.length} malformed marker(s) quarantined`);
  if (envelope.full) lines.push("", `full report: ${envelope.full}`);
  return lines.join("\n") + "\n";
}
