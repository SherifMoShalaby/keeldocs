// keeldocs check - drift + verify + coverage. Deterministic by contract:
// no LLM, no network, no wall clock in fact/drift computation. Policy state
// (snooze expiry) uses wall clock locally and the HEAD COMMIT TIME in --ci,
// so CI output is a pure function of (SHA, committed journal) - spec §6.
// Codes: CLEAN 0 | DRIFT_FOUND 1 | UNREADABLE 1 | TOOL_ERROR 2 | CONFIG 2, and
// nothing else - enumerated in src/envelope.js, which the harness holds both this
// file and every agent-facing contract to. This line used to end "| 3
// budget-degraded", which `check` has never returned: a comment describing an
// unreachable state, in the file whose job is to refuse exactly that (see the
// same story at the top of bin/keeldocs.js).

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDoc } from "./anchors.js";
import { loadJournal, effective, noiseStats } from "./journal.js";
import { extractAll } from "./facts.js";
import { evaluate, coverage, classifySelfCaused } from "./drift.js";
import { planUpgrade } from "./upgrade.js";
import { loadConfig, docPathsOf, extractOpts, unscannedAnchoredDocs } from "./config.js";
import { ledgerOf, unreadableOf, assertClassified, CAP } from "./disclosure.js";
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
      summary: cfg.error.slice(0, 300), data: {}, next: [] });
  }
  if (live && (ci || process.env.CI === "true" || process.env.CI === "1")) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: "--live is disabled in CI: network must never enter the pure-function check path (run it locally)",
      data: {}, next: [] });
  }
  let report;
  try {
    report = buildReport(repoRoot, ci, cfg.config, since, live);
  } catch (err) {
    return emit(json, 2, {
      v: 1, ok: false, code: "TOOL_ERROR",
      summary: `check failed: ${String(err.message).slice(0, 200)}`, data: {}, next: [],
    });
  }

  // Every point at which the engine declined to look at something has one
  // disposition entry in the ledger, and the verdict is DERIVED from it. This
  // line used to be a hand-maintained sum over four names:
  //
  //     const unreadable = refused.length + unverified + unscanned.length
  //                      + journalMalformed.length;
  //
  // Six releases each added a channel and hand-wired it into the sum, the
  // envelope, the report and the human rendering. A hand-maintained sum is a
  // list nothing enumerates, so the ninth channel that forgot to join it would
  // have been invisible in the exact way the previous eight were - exit 0,
  // CLEAN, over something nobody checked. Nothing below names a channel: see
  // src/disclosure.js, which owns the enumeration, and whose `assertClassified`
  // makes a report key that joins neither side of it a TOOL_ERROR rather than a
  // silence.
  //
  // A drift count computed over a tree the engine cannot fully read is a number
  // it should decline to headline, so UNREADABLE outranks DRIFT_FOUND.
  const ledger = ledgerOf(report);
  const unreadable = unreadableOf(ledger);
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
  // Coverage is a ratio and both of its terms have to be legible - the same
  // argument the path-scope disclosure exists for. A path scope is a blind spot
  // the user chose; an extraction gap is one they did not, and it was strictly
  // less visible: "100% of surfaces documented" over a monorepo whose second
  // `schema.prisma` was never opened read exactly like a repo with one database.
  // The note comes off the ledger, so a future channel with something to say
  // about coverage says it here without this line being edited again.
  const covTxt = (report.coverage.pct === null ? "no facts" : `${report.coverage.documented}/${report.coverage.total} surfaces documented (${report.coverage.pct}%)`)
    + ledger.map((e) => e.note?.(e.items, e.total) ?? "").join("");
  const sinceTxt = report.meta.since ? `; ${c.selfCaused ?? 0} caused since ${report.meta.since.ref}` : "";
  // Each term appears only when it is non-zero, and a term NAMES its documents:
  // "1 anchored doc(s) outside every scan root" without saying which one is the
  // same unactionable count that let `rebaseline` hide, and the fix (which
  // directory to add to `[docs] dirs`) is not derivable from a number. Which
  // channels contribute, and in what order, is the ledger's to say.
  const unreadableParts = ledger
    .filter((e) => e.disclosure === "verdict" && e.total && e.summary)
    .map((e) => e.summary(e.items, e.total));
  const summary = report.toolError
    ? `tooling error: ${report.toolError}`.slice(0, 300)
    : unreadable
    ? `${unreadableParts.join("; ")} - no drift verdict for this run; fix them, then re-run`.slice(0, 300)
    : `${c.driftTotal} drift finding(s) [stale ${c.stale ?? 0}, dead ${c.dead ?? 0}, tampered ${c.tampered ?? 0}]${sinceTxt} across ${report.meta.docsScanned} doc(s); ${c.clean ?? 0} clean; ${covTxt}`.slice(0, 300);

  const top = report.findings.filter((f) => DRIFT_STATES.has(f.state)).slice(0, 20)
    .map((f) => ({ id: f.id, state: f.state, doc: f.doc, line: f.line,
                   ...(f.selfCaused !== undefined ? { selfCaused: f.selfCaused } : {}),
                   ...(f.missing ? { missing: f.missing } : {}),
                   ...(f.candidates && f.candidates.length ? { candidates: f.candidates } : {}) }));

  const envelope = {
    v: 1, ok: exit === 0, code, summary,
    // Every disclosure key is projected from the ledger, absent when empty and
    // capped there - the 8KB trimmer only ever shrinks `data.top`, so an
    // uncapped list here could bust a cap it cannot repair. A channel that
    // carries no envelope key of its own (it rides `meta`, or the coverage
    // sentence) declares that by having none, rather than by being forgotten.
    data: { counts: c, coverage: report.coverage, noise: report.noise, top,
            ...Object.fromEntries(ledger
              .filter((e) => e.envelope && e.items.length)
              .map((e) => [e.envelope, e.items.slice(0, CAP)])),
            ...(upgrades?.length ? { upgrades } : {}) },
    truncated: report.findings.length > top.length,
    full: toPosix(relative(repoRoot, outPath)),
    next: [...(exit === 1 ? ["keeldocs sync"] : []),
           ...(upgrades?.length ? ["keeldocs sync --upgrade"] : [])],
  };
  return emit(json, exit, envelope, ledger, cache);
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
  // One list for both walks: what the doc scan and the sweep declined to enter
  // and have to say so about (`docSkip`). It is deliberately NOT part of the
  // verdict - a repository with a dependency tree is not a repository with a
  // problem - but a run that passed over part of the tree in silence is the
  // defect this family keeps producing, so the directories are named.
  const skippedDirs = [];
  const docPaths = docPathsOf(repoRoot, config.docs.dirs, skippedDirs);
  for (const p of docPaths) {
    const parsed = parseDoc(readFileSync(join(repoRoot, p), "utf8"), p);
    anchors.push(...parsed.anchors);
    regions.push(...parsed.regions);
    quarantined.push(...parsed.quarantined);
  }
  // What the scan roots did NOT cover, computed from the same doc list so the
  // two can never disagree about which documents were read. `excludedDocs` is
  // the other half of that answer: an anchored document the user's own
  // `exclude-paths` suppressed is not a finding - they asked for it - but it is
  // not clean either, and it was invisible. `["**/*.md"]` excludes no code and
  // silently restored the whole `git mv docs handbook` regression.
  const excludedDocs = [];
  const unscanned = unscannedAnchoredDocs(repoRoot, docPaths, config.providers["exclude-paths"],
                                          skippedDirs, excludedDocs);
  // Both walks reach `docs/node_modules`, so the raw list double-counts - and it
  // also names directories that WERE read. `node_modules` is skipped during
  // recursion but never as a root, so naming one in `[docs] dirs` is the
  // documented escape hatch; reporting it as `NOT READ` told a user their
  // documents were unchecked when the findings above came out of those very
  // files, and then advised the exact thing they had already done. A disclosure
  // that fires when it is false is the same defect as silence, pointed the other
  // way, and it is worse in one respect: it teaches the reader to discount the
  // line. `docPaths` is what was actually read, so it - not the walk - decides.
  const roots = new Set(config.docs.dirs.map((d) => d.replace(/\/+$/, "")));
  const wasRead = (d) => roots.has(d) || docPaths.some((p) => p.startsWith(`${d}/`));
  const skipped = [...new Set(skippedDirs)].filter((d) => !wasRead(d)).sort();

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

  const report = {
    v: 1,
    meta: { engine: `keeldocs@${ENGINE_VERSION}`, head, providerSetHash,
            docsScanned: docPaths.length, mode: ci ? "ci" : "local",
            // A path scope is a deliberate blind spot, and a blind spot the
            // report does not name is indistinguishable from a repo that simply
            // has nothing there. Coverage is a ratio; both of its terms have to
            // be legible.
            //
            // Emitted for a CONFIGURED scope, not for a non-zero count. Keying
            // it on `scopedOut` meant the two fields vanished in exactly the
            // cases where the scope did the most damage and the least of what it
            // advertises: `["vendor"]` removed a provider and an anchored
            // document while pruning no fact at all, and reported neither field.
            // `scopedOut: 0` beside a scope the user wrote is information - it
            // says the line is not doing what they think.
            ...(config.providers["exclude-paths"].length
                  ? { scopedOut, excludePaths: config.providers["exclude-paths"] } : {}),
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
    // absent when empty, like `conflicts`, so every clean golden stays byte-stable
    ...(rawJournal.malformed.length ? { journalMalformed: rawJournal.malformed } : {}),
    ...(unscanned.length ? { unscanned } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(excludedDocs.length ? { excludedDocs } : {}),
    // ADR-003 conflict records ride the full report; absent when empty so
    // conflict-free goldens stay byte-stable
    ...(conflicts?.length ? { conflicts } : {}),
  };
  // The forcing function, and the reason the next decline site cannot be silent.
  // Every top-level key above is either a disclosure channel or declared not to
  // be one; a key that is neither throws, and a throw here is TOOL_ERROR exit 2.
  // It runs on every repository on every run rather than only where a fixture
  // trips a channel - the channels are absent-when-empty, so a fixture-only
  // check would notice only the unjoined channels it was lucky enough to
  // trigger, which is how this family stayed alive for four releases. Pure key
  // comparison: no clock, no network, nothing that stops `check` being a pure
  // function of the tree.
  assertClassified(report);
  return report;
}

function emit(json, exit, envelope, ledger = [], cache = null) {
  if (json) {
    let out = JSON.stringify(envelope);
    if (out.length > 8192) { // hard envelope cap - trim top findings until it fits
      envelope.data.top = envelope.data.top.slice(0, 5);
      envelope.truncated = true;
      out = JSON.stringify(envelope);
    }
    process.stdout.write(out + "\n");
  } else {
    process.stdout.write(humanize(envelope, ledger, cache));
  }
  return exit;
}

function humanize(envelope, ledger = [], cache = null) {
  const lines = [`keeldocs check - ${envelope.code}`, envelope.summary, ""];
  for (const f of envelope.data.top ?? []) {
    lines.push(`  ${f.state.toUpperCase().padEnd(9)} ${f.doc}:${f.line}  ${f.id}${f.missing ? `  (missing: ${f.missing.join(", ")})` : ""}`);
    if (f.candidates?.length) lines.push(`            candidates: ${f.candidates.join(", ")}`);
  }
  // One rendering per channel, off the same ledger the verdict came from, so a
  // human reading the terminal and a machine reading the envelope are told about
  // the same set of things. Six of these lines used to be written by hand here,
  // which is why three channels reached the envelope before they reached a
  // reader, and one never reached either.
  for (const e of ledger) lines.push(...(e.human?.(e.items.slice(0, CAP), e.total) ?? []));
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
