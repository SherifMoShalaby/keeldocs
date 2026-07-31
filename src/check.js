// keeldocs check - drift + verify + coverage. Deterministic by contract:
// no LLM, no network, no wall clock in fact/drift computation. Policy state
// (snooze expiry) uses wall clock locally and the HEAD COMMIT TIME in --ci,
// so CI output is a pure function of (SHA, committed journal) - spec §6.
// Exit codes: 0 clean | 1 findings | 2 tool/config error | 3 budget-degraded.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDoc } from "./anchors.js";
import { loadJournal, effective, noiseStats } from "./journal.js";
import { extractAll } from "./facts.js";
import { evaluate, coverage, classifySelfCaused } from "./drift.js";
import { loadConfig, docPathsOf } from "./config.js";
import { changedFilesSince, changedFactsSince } from "./gitx.js";
import { ENGINE_VERSION } from "./registry.js";

const DRIFT_STATES = new Set(["stale", "tampered", "dead"]);

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function runCheck({ root, json, ci, since = null }) {
  const repoRoot = root;
  const cfg = loadConfig(repoRoot);
  if (!cfg.ok) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: cfg.error.slice(0, 300), data: {}, next: [] }, null);
  }
  let report;
  try {
    report = buildReport(repoRoot, ci, cfg.config, since);
  } catch (err) {
    return emit(json, 2, {
      v: 1, ok: false, code: "TOOL_ERROR",
      summary: `check failed: ${String(err.message).slice(0, 200)}`, data: {}, next: [],
    }, null);
  }

  const exit = report.toolError ? 2 : report.counts.driftTotal > 0 ? 1 : 0;
  const code = report.toolError ? "TOOL_ERROR" : exit === 1 ? "DRIFT_FOUND" : "CLEAN";

  // Full report spills to .keeldocs/out; stdout stays inside the 8KB envelope cap.
  // `noise` stays envelope-only: its 30-day window moves with the wall clock,
  // and a golden-compared report must never carry time-varying fields.
  const outDir = join(repoRoot, ".keeldocs", "out");
  mkdirSync(outDir, { recursive: true });
  const outName = `check-${report.meta.head ? report.meta.head.slice(0, 8) : "nogit"}.json`;
  const outPath = join(outDir, outName);
  const { noise, ...spill } = report;
  writeFileSync(outPath, JSON.stringify(spill, null, 1) + "\n");

  const c = report.counts;
  const covTxt = report.coverage.pct === null ? "no facts" : `${report.coverage.documented}/${report.coverage.total} surfaces documented (${report.coverage.pct}%)`;
  const sinceTxt = report.meta.since ? `; ${c.selfCaused ?? 0} caused since ${report.meta.since.ref}` : "";
  const summary = report.toolError
    ? `tooling error: ${report.toolError}`.slice(0, 300)
    : `${c.driftTotal} drift finding(s) [stale ${c.stale ?? 0}, dead ${c.dead ?? 0}, tampered ${c.tampered ?? 0}]${sinceTxt} across ${report.meta.docsScanned} doc(s); ${c.clean ?? 0} clean; ${covTxt}`.slice(0, 300);

  const top = report.findings.filter((f) => DRIFT_STATES.has(f.state)).slice(0, 20)
    .map((f) => ({ id: f.id, state: f.state, doc: f.doc, line: f.line,
                   ...(f.selfCaused !== undefined ? { selfCaused: f.selfCaused } : {}),
                   ...(f.missing ? { missing: f.missing } : {}),
                   ...(f.candidates && f.candidates.length ? { candidates: f.candidates } : {}) }));

  const envelope = {
    v: 1, ok: exit === 0, code, summary,
    data: { counts: c, coverage: report.coverage, noise: report.noise, top },
    truncated: report.findings.length > top.length,
    full: relative(repoRoot, outPath),
    next: exit === 1 ? ["keeldocs sync"] : [],
  };
  return emit(json, exit, envelope, report);
}

function buildReport(repoRoot, ci, config, since) {
  // now: policy clock only (snooze expiry) - HEAD commit time in CI (spec §6)
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const nowIso = ci
    ? (git(repoRoot, ["show", "-s", "--format=%cI", "HEAD"]) ?? "9999-12-31T00:00:00Z")
    : new Date().toISOString();

  const { factsById, capabilities, gaps, providerSetHash, toolError } =
    extractAll(repoRoot, { disable: config.providers.disable });
  const rawJournal = loadJournal(repoRoot);
  const journal = effective(rawJournal, nowIso);

  const anchors = [], regions = [], quarantined = [];
  const docPaths = docPathsOf(repoRoot, config.docs.dirs);
  for (const p of docPaths) {
    const parsed = parseDoc(readFileSync(join(repoRoot, p), "utf8"), p);
    anchors.push(...parsed.anchors);
    regions.push(...parsed.regions);
    quarantined.push(...parsed.quarantined);
  }

  const { findings, documented } = evaluate({ anchors, regions, factsById, capabilities, journal });
  const cov = coverage(factsById, documented);

  let sinceInfo = null;
  if (since) {
    const { changed, base } = changedFilesSince(repoRoot, since);
    const changedFactIds = changedFactsSince(repoRoot, base, factsById,
      { disable: config.providers.disable });
    classifySelfCaused({ findings, anchors, regions, factsById, changed, changedFactIds });
    sinceInfo = { ref: since, changedFiles: changed.size, changedFacts: changedFactIds.size };
  }

  const counts = {};
  for (const f of findings) counts[f.state] = (counts[f.state] ?? 0) + 1;
  counts.driftTotal = findings.filter((f) => DRIFT_STATES.has(f.state)).length;
  if (since) counts.selfCaused = findings.filter((f) => DRIFT_STATES.has(f.state) && f.selfCaused).length;

  return {
    v: 1,
    meta: { engine: `keeldocs@${ENGINE_VERSION}`, head, providerSetHash,
            docsScanned: docPaths.length, mode: ci ? "ci" : "local",
            ...(sinceInfo ? { since: sinceInfo } : {}) },
    capabilities, counts, findings, coverage: cov,
    noise: noiseStats(rawJournal, nowIso),
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
