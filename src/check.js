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
import { planUpgrade } from "./upgrade.js";
import { loadConfig, docPathsOf, extractOpts } from "./config.js";
import { toPosix } from "./paths.js";
import { changedFilesSince, changedFactsSince } from "./gitx.js";
import { ENGINE_VERSION } from "./registry.js";

const DRIFT_STATES = new Set(["stale", "tampered", "dead"]);

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function runCheck({ root, json, ci, since = null, live = false }) {
  const repoRoot = root;
  const cfg = loadConfig(repoRoot);
  if (!cfg.ok) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: cfg.error.slice(0, 300), data: {}, next: [] }, null);
  }
  if (live && (ci || process.env.CI === "true" || process.env.CI === "1")) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: "--live is disabled in CI: network must never enter the pure-function check path (run it locally)",
      data: {}, next: [] }, null);
  }
  let report;
  try {
    report = buildReport(repoRoot, ci, cfg.config, since, live);
  } catch (err) {
    return emit(json, 2, {
      v: 1, ok: false, code: "TOOL_ERROR",
      summary: `check failed: ${String(err.message).slice(0, 200)}`, data: {}, next: [],
    }, null);
  }

  // A refused marker had no verdict at all: it was recorded in the spilled report
  // and appeared in neither the envelope, the summary, nor the exit code. So an
  // engine that had stopped checking a section still printed CLEAN and exited
  // zero - and the user was never told which section, or that there was one.
  // A drift count computed over a tree the engine cannot fully read is a number
  // it should decline to headline, so UNREADABLE outranks DRIFT_FOUND.
  const refused = report.quarantined ?? [];
  const unverified = report.counts.unverified ?? 0;
  const unreadable = refused.length + unverified;
  // A refused MARKER is named by document, line and reason; an unverified
  // SECTION was only ever counted. "3 sections are not being checked" without
  // saying which three is a finding the user cannot act on - and the count alone
  // is what let `rebaseline` hide for as long as it did.
  const unverifiedTop = report.findings
    .filter((f) => f.state === "unverified")
    .slice(0, 20)
    .map((f) => ({ id: f.id, doc: f.doc, line: f.line, reason: f.reason }));
  const exit = report.toolError ? 2 : (unreadable || report.counts.driftTotal > 0) ? 1 : 0;
  const code = report.toolError ? "TOOL_ERROR"
    : unreadable ? "UNREADABLE"
    : exit === 1 ? "DRIFT_FOUND" : "CLEAN";

  // Full report spills to .keeldocs/out; stdout stays inside the 8KB envelope cap.
  // `noise` stays envelope-only: its 30-day window moves with the wall clock,
  // and a golden-compared report must never carry time-varying fields.
  const outDir = join(repoRoot, ".keeldocs", "out");
  mkdirSync(outDir, { recursive: true });
  const outName = `check-${report.meta.head ? report.meta.head.slice(0, 8) : "nogit"}.json`;
  const outPath = join(outDir, outName);
  // `cache` leaves with `noise` and `upgrades`: how a run was SERVED is run
  // state, not repository state. Two runs of the same tree - one cold, one
  // warm - must produce byte-identical envelopes and byte-identical reports, or
  // the cache has become visible in the deterministic channel and every golden
  // comparison in the harness turns into a coin flip.
  const { noise, upgrades, cache, ...spill } = report;
  writeFileSync(outPath, JSON.stringify(spill, null, 1) + "\n");

  const c = report.counts;
  const covTxt = report.coverage.pct === null ? "no facts" : `${report.coverage.documented}/${report.coverage.total} surfaces documented (${report.coverage.pct}%)`;
  const sinceTxt = report.meta.since ? `; ${c.selfCaused ?? 0} caused since ${report.meta.since.ref}` : "";
  const summary = report.toolError
    ? `tooling error: ${report.toolError}`.slice(0, 300)
    : unreadable
    ? `${refused.length} unparseable marker(s) and ${unverified} section(s) the engine cannot verify - no drift verdict for this run; repair them, then re-run`.slice(0, 300)
    : `${c.driftTotal} drift finding(s) [stale ${c.stale ?? 0}, dead ${c.dead ?? 0}, tampered ${c.tampered ?? 0}]${sinceTxt} across ${report.meta.docsScanned} doc(s); ${c.clean ?? 0} clean; ${covTxt}`.slice(0, 300);

  const top = report.findings.filter((f) => DRIFT_STATES.has(f.state)).slice(0, 20)
    .map((f) => ({ id: f.id, state: f.state, doc: f.doc, line: f.line,
                   ...(f.selfCaused !== undefined ? { selfCaused: f.selfCaused } : {}),
                   ...(f.missing ? { missing: f.missing } : {}),
                   ...(f.candidates && f.candidates.length ? { candidates: f.candidates } : {}) }));

  const envelope = {
    v: 1, ok: exit === 0, code, summary,
    data: { counts: c, coverage: report.coverage, noise: report.noise, top,
            ...(refused.length ? { refused: refused.slice(0, 20) } : {}),
            ...(unverifiedTop.length ? { unverified: unverifiedTop } : {}),
            ...(upgrades?.length ? { upgrades } : {}) },
    truncated: report.findings.length > top.length,
    full: toPosix(relative(repoRoot, outPath)),
    next: [...(exit === 1 ? ["keeldocs sync"] : []),
           ...(upgrades?.length ? ["keeldocs sync --upgrade"] : [])],
  };
  return emit(json, exit, envelope, report, cache);
}

function buildReport(repoRoot, ci, config, since, live = false) {
  // now: policy clock only (snooze expiry) - HEAD commit time in CI (spec §6)
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const nowIso = ci
    ? (git(repoRoot, ["show", "-s", "--format=%cI", "HEAD"]) ?? "9999-12-31T00:00:00Z")
    : new Date().toISOString();

  const { factsById, capabilities, gaps, providerSetHash, toolError, conflicts, cache, scopedOut } =
    extractAll(repoRoot, { ...extractOpts(config),
      live: live ? { dsnEnv: config.live["dsn-env"] } : null });
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

  // Recipe migration is DISCOVERY, never a verdict: a document that predates a
  // section is not stale, not lying, and not drift - it is merely older than
  // the recipe. It rides the envelope so `sync --upgrade` is findable, and it
  // can never move the exit code. Envelope-only, like `noise`, so the
  // golden-compared spill stays byte-stable.
  let upgrades = [];
  try {
    upgrades = planUpgrade({ root: repoRoot, factsById, journal }).proposals
      .map((p) => ({ id: p.id, doc: p.doc }));
  } catch { /* discovery must never fail a check */ }

  let sinceInfo = null;
  if (since) {
    const { changed, base } = changedFilesSince(repoRoot, since);
    const changedFactIds = changedFactsSince(repoRoot, base, factsById, extractOpts(config));
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
            // A path scope is a deliberate blind spot, and a blind spot the
            // report does not name is indistinguishable from a repo that simply
            // has nothing there. Coverage is a ratio; both of its terms have to
            // be legible.
            ...(scopedOut ? { scopedOut, excludePaths: config.providers["exclude-paths"] } : {}),
            ...(sinceInfo ? { since: sinceInfo } : {}) },
    // fail closed: a provider failure must surface as TOOL_ERROR exit 2, never
    // as a smaller-but-CLEAN report (this line was missing once - check said
    // CLEAN while db-schema was failed; caught by the live DSN-missing test)
    ...(toolError ? { toolError } : {}),
    // D1 cache accounting is HUMAN-CHANNEL ONLY (see below): it rides the
    // report object in memory so `humanize` can reach it, and is stripped
    // before the report is written or the envelope is built.
    cache,
    capabilities, counts, findings, coverage: cov,
    noise: noiseStats(rawJournal, nowIso), upgrades,
    quarantined, extractionGaps: gaps,
    // ADR-003 conflict records ride the full report; absent when empty so
    // conflict-free goldens stay byte-stable
    ...(conflicts?.length ? { conflicts } : {}),
  };
}

function emit(json, exit, envelope, report, cache = null) {
  if (json) {
    let out = JSON.stringify(envelope);
    if (out.length > 8192) { // hard envelope cap - trim top findings until it fits
      envelope.data.top = envelope.data.top.slice(0, 5);
      envelope.truncated = true;
      out = JSON.stringify(envelope);
    }
    process.stdout.write(out + "\n");
  } else {
    process.stdout.write(humanize(envelope, report, cache));
  }
  return exit;
}

function humanize(envelope, report, cache = null) {
  const lines = [`keeldocs check - ${envelope.code}`, envelope.summary, ""];
  for (const f of envelope.data.top ?? []) {
    lines.push(`  ${f.state.toUpperCase().padEnd(9)} ${f.doc}:${f.line}  ${f.id}${f.missing ? `  (missing: ${f.missing.join(", ")})` : ""}`);
    if (f.candidates?.length) lines.push(`            candidates: ${f.candidates.join(", ")}`);
  }
  for (const u of envelope.data.unverified ?? []) {
    lines.push(`  UNVERIFIED ${u.doc}:${u.line}  ${u.id}  (${u.reason})`);
  }
  if (report?.quarantined?.length) lines.push(`  note: ${report.quarantined.length} malformed marker(s) quarantined`);
  // Stated, not silent: a reader must be able to tell that work was skipped,
  // and must be told how to stop skipping it. Human channel only - the JSON
  // envelope stays a pure function of the repository.
  if (cache && (cache.hits || cache.misses)) {
    const total = cache.hits + cache.misses;
    lines.push("", cache.hits
      ? `cache: ${cache.hits}/${total} provider(s) reused from .keeldocs/cache (--no-cache to re-extract)`
      : `cache: 0/${total} provider(s) reused - everything re-extracted`);
  } else if (cache && !cache.enabled) {
    lines.push("", "cache: disabled (KEELDOCS_NO_CACHE)");
  }
  if (envelope.full) lines.push("", `full report: ${envelope.full}`);
  return lines.join("\n") + "\n";
}
