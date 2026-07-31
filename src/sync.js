// keeldocs sync - the retention loop (ADR-012, DX 4d). Turns drift findings
// into reviewable proposals and applies decisions:
//   default            preview: list proposals + persist to .keeldocs/out/proposals.json
//   --apply-all        apply every appliable proposal (regenerate/restore)
//   --apply <id>       apply one (rebind uses first candidate; --to overrides)
//   --reject <id>      journal a rejection (identical proposal never re-proposed)
//   --snooze <id>      journal a snooze (--days N, default 21)
//   --tombstone <id>   journal tombstones for a dead proposal's missing facts
//   TTY, no flags      minimal y/n/s/w/q loop per finding
// Journal writes are interactive/explicit-local only - hard-guarded off in CI.
// Exit: 0 success | 1 proposals remain (preview with pending work) | 2 tool error.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { parseDoc } from "./anchors.js";
import { loadJournal, effective, appendDecisions } from "./journal.js";
import { extractAll } from "./facts.js";
import { evaluate, classifySelfCaused } from "./drift.js";
import { buildProposals } from "./proposals.js";
import { patchRegion, patchBind } from "./patch.js";
import { loadConfig, docPathsOf } from "./config.js";
import { changedFilesSince, changedFactsSince, extractAtBase, renamesSince } from "./gitx.js";
import { renameMapFromStatus } from "./reanchor.js";
import { toPosix } from "./paths.js";
import { ENGINE_VERSION } from "./registry.js";

const inCI = () => process.env.CI === "true" || process.env.CI === "1";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// --self [ref]: scope to drift CAUSED by ref..HEAD (the post-edit nudge's
// one-keystroke apply). Explicit ref wins; otherwise resolve the base the way
// a human means it, and fail LOUDLY when nothing resolves - guessing a base
// would silently mis-scope.
function resolveSelfBase(root, explicit) {
  if (explicit) return explicit;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", ref]) !== null) return ref;
  }
  throw new Error("--self: no base ref found (tried origin/HEAD, origin/main, origin/master) - pass one: keeldocs sync --self <ref>");
}

function collectState(root, config, selfScope = null) {
  const { factsById, capabilities, toolError } = extractAll(root,
    { disable: config.providers.disable, trustKeys: config.trust.keys });
  if (toolError) throw new Error(`tooling error: ${toolError}`);
  const journal = effective(loadJournal(root), new Date().toISOString());
  const anchors = [], regions = [], docTexts = new Map();
  for (const d of docPathsOf(root, config.docs.dirs)) {
    const text = readFileSync(join(root, d), "utf8");
    docTexts.set(d, text);
    const parsed = parseDoc(text, d);
    anchors.push(...parsed.anchors);
    regions.push(...parsed.regions);
  }
  const { findings } = evaluate({ anchors, regions, factsById, capabilities, journal });

  // Re-anchoring context (S1 rename map + S2 base shapes) whenever a dead ds
  // binding exists and a base is resolvable - degrades silently to the cheap
  // S1b candidates otherwise. The --self base is reused when present.
  let reanchor = null;
  let baseFacts = null;
  const deadDs = findings.some((f) => f.state === "dead" && f.missing?.some((m) => m.startsWith("ds ")));
  let base = selfScope?.base ?? null;
  if (base === null && deadDs) {
    // origin chain when available; else HEAD - the binding resolved at HEAD,
    // so HEAD carries the dead fact's last known shape for S2
    let ref;
    try { ref = resolveSelfBase(root, null); } catch { ref = "HEAD"; }
    base = git(root, ["merge-base", ref, "HEAD"]) ?? git(root, ["rev-parse", "HEAD"]);
  }
  if (base !== null && (deadDs || selfScope)) {
    baseFacts = extractAtBase(root, base,
      { disable: config.providers.disable, trustKeys: config.trust.keys });
    if (deadDs) {
      reanchor = { baseFacts, renames: renameMapFromStatus(renamesSince(root, base)) };
    }
  }

  let proposals = buildProposals({ findings, regions, anchors, factsById, reanchor });
  if (selfScope) {
    const changedFactIds = changedFactsSince(root, selfScope.base, factsById,
      { disable: config.providers.disable, trustKeys: config.trust.keys }, baseFacts);
    classifySelfCaused({ findings, anchors, regions, factsById,
      changed: selfScope.changed, changedFactIds });
    const self = new Set(findings.filter((f) => f.selfCaused).map((f) => `${f.id}\x00${f.doc}`));
    proposals = proposals.filter((p) => self.has(`${p.id}\x00${p.doc}`));
  }
  return { factsById, findings, proposals, anchors, regions, docTexts };
}

// Applies are journaled locally as accept-rate signal (ADR-012 self-throttle);
// CI applies (the rollup) are machine acts, not human decisions - never recorded.
function journalApplied(root, entries) {
  if (inCI() || entries.length === 0) return;
  appendDecisions(root, entries.map((a) => ({
    at: new Date().toISOString(), actor: actor(), type: "applied",
    target: a.id, action: a.action,
  })));
}

function actor() { return process.env.KEELDOCS_ACTOR || process.env.USER || "unknown"; }

function applyOne(root, docTexts, p, toOverride) {
  const doc = docTexts.get(p.doc);
  if (doc === undefined) throw new Error(`doc ${p.doc} not loaded`);
  if (p.kind === "regenerate" || p.kind === "restore") {
    const patched = patchRegion(doc, p.id, p.newBody, p.newHash, p.newContent);
    writeFileSync(join(root, p.doc), patched);
    docTexts.set(p.doc, patched);
    return { id: p.id, action: p.kind };
  }
  if (p.kind === "rebind") {
    const target = toOverride ?? p.candidate;
    if (!p.allCandidates.includes(target) && !toOverride) throw new Error("no rebind target");
    let patched = doc;
    for (const miss of p.missing) patched = patchBind(patched, p.id, miss, target);
    writeFileSync(join(root, p.doc), patched);
    docTexts.set(p.doc, patched);
    appendDecisions(root, p.missing.map((m) => ({
      at: new Date().toISOString(), actor: actor(), type: "rebind",
      target: m, to: target, marker: p.id,
    })));
    return { id: p.id, action: "rebind", to: target };
  }
  if (p.kind === "tombstone") {
    appendDecisions(root, p.missing.map((m) => ({
      at: new Date().toISOString(), actor: actor(), type: "tombstone",
      target: m, evidence: `tombstoned via sync for marker ${p.id}`,
    })));
    return { id: p.id, action: "tombstone" };
  }
  throw new Error(`proposal ${p.id} (${p.kind}) is not appliable`);
}

function rejectOne(root, p, findings) {
  // Hold key = the CURRENT state's display hash so an identical proposal never returns.
  const f = findings.find((x) => x.id === p.id);
  const held = p.kind === "restore" || p.kind === "regenerate"
    ? (p.kind === "restore" ? currentContentDisplay(root, p) : f?.currentHash ?? p.newHash)
    : null;
  appendDecisions(root, [{ at: new Date().toISOString(), actor: actor(), type: "rejection",
    target: p.id, ...(held ? { content_hash: held } : {}) }]);
}

import { contentHash, display } from "./hash.js";
function currentContentDisplay(root, p) {
  const text = readFileSync(join(root, p.doc), "utf8");
  const m = new RegExp(`id=${p.id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^>]*-->`).exec(text);
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  const close = text.indexOf("<!-- /keeldocs:gen -->", bodyStart);
  return close === -1 ? null : display(contentHash(text.slice(bodyStart, close)));
}

export function runSync({ root, json, args }) {
  const cfg = loadConfig(root);
  if (!cfg.ok) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: cfg.error.slice(0, 300), data: {}, next: [] });
  }
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] ?? true); };
  let selfScope = null;
  if (args.includes("--self")) {
    try {
      const raw = flag("--self");
      const baseRef = resolveSelfBase(root, typeof raw === "string" && !raw.startsWith("--") ? raw : null);
      const { changed, base } = changedFilesSince(root, baseRef);
      selfScope = { changed, base };
    } catch (err) {
      return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR",
        summary: String(err.message).slice(0, 300), data: {}, next: [] });
    }
  }
  let state;
  try {
    state = collectState(root, cfg.config, selfScope);
  } catch (err) {
    return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR",
      summary: String(err.message).slice(0, 300), data: {}, next: [] });
  }
  const { proposals, findings, docTexts } = state;

  const applied = [], errors = [];

  try {
    if (args.includes("--apply-all")) {
      // regenerate/restore always; rebinds ONLY when the two-signal gate held
      for (const p of proposals.filter((p) => p.kind === "regenerate" || p.kind === "restore" || (p.kind === "rebind" && p.auto && !inCI()))) {
        applied.push(applyOne(root, docTexts, p));
      }
    } else if (flag("--apply")) {
      const p = proposals.find((x) => x.id === flag("--apply"));
      if (!p) throw new Error(`no proposal with id ${flag("--apply")}`);
      applied.push(applyOne(root, docTexts, p, flag("--to") || null));
    } else if (flag("--reject")) {
      const p = proposals.find((x) => x.id === flag("--reject"));
      if (!p) throw new Error(`no proposal with id ${flag("--reject")}`);
      rejectOne(root, p, findings);
      return emit(json, 0, { v: 1, ok: true, code: "DECISION_RECORDED",
        summary: `rejection recorded for ${p.id}; an identical proposal will not be re-made`,
        data: { id: p.id }, next: [] });
    } else if (flag("--snooze")) {
      const id = flag("--snooze");
      const days = parseInt(flag("--days") || "21", 10);
      const expires = new Date(Date.now() + days * 86400_000).toISOString();
      appendDecisions(root, [{ at: new Date().toISOString(), actor: actor(), type: "snooze", target: id, expires }]);
      return emit(json, 0, { v: 1, ok: true, code: "DECISION_RECORDED",
        summary: `snoozed ${id} until ${expires.slice(0, 10)}`, data: { id, expires }, next: [] });
    } else if (flag("--tombstone")) {
      const p = proposals.find((x) => x.id === flag("--tombstone") && x.kind === "tombstone");
      if (!p) throw new Error(`no tombstone proposal with id ${flag("--tombstone")}`);
      applied.push(applyOne(root, docTexts, p));
    } else if (process.stdin.isTTY && process.stdout.isTTY && !json) {
      return interactive(root, docTexts, proposals, findings, json);
    }
  } catch (err) {
    errors.push(String(err.message));
  }

  try { journalApplied(root, applied); } catch { /* stats-only signal; applies already landed */ }

  const remaining = collectRemaining(root, cfg.config, selfScope);
  const code = errors.length ? "TOOL_ERROR"
    : applied.length ? "APPLIED"
    : proposals.length ? "PROPOSALS" : "NOTHING_TO_SYNC";
  const exit = errors.length ? 2 : remaining.appliable > 0 && applied.length === 0 && proposals.length > 0 ? 1 : 0;

  // Persist full proposals for review tooling / agents.
  const outDir = join(root, ".keeldocs", "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "proposals.json");
  writeFileSync(outPath, JSON.stringify({ v: 1, engine: `keeldocs@${ENGINE_VERSION}`, proposals: remaining.proposals }, null, 1) + "\n");

  const summary = (errors.length ? `sync error: ${errors[0]}`
    : `${applied.length} applied; ${remaining.proposals.length} proposal(s) remaining` +
      (remaining.proposals.length ? ` (${remaining.byKind})` : "") +
      (applied.length ? " - run keeldocs check to confirm clean" : "")).slice(0, 300);

  return emit(json, exit, {
    v: 1, ok: !errors.length, code, summary,
    data: {
      applied,
      proposals: remaining.proposals.slice(0, 10).map((p) => ({
        id: p.id, kind: p.kind, doc: p.doc, line: p.line, evidence: p.evidence.slice(0, 200),
        ...(p.candidate ? { candidate: p.candidate } : {}),
        ...(p.auto ? { auto: true } : {}),
        ...(p.signals ? { signals: p.signals } : {}),
      })),
    },
    truncated: remaining.proposals.length > 10,
    full: toPosix(relative(root, outPath)),
    next: remaining.proposals.length
      ? ["keeldocs sync --apply-all", "keeldocs sync --apply <id> | --reject <id> | --snooze <id>"]
      : ["keeldocs check"],
  });
}

function collectRemaining(root, config, selfScope = null) {
  const { proposals } = collectState(root, config, selfScope);
  const kinds = {};
  for (const p of proposals) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  return {
    proposals,
    appliable: proposals.filter((p) => p.kind === "regenerate" || p.kind === "restore").length,
    byKind: Object.entries(kinds).sort().map(([k, n]) => `${k} ${n}`).join(", "),
  };
}

function interactive(root, docTexts, proposals, findings, json) {
  if (proposals.length === 0) {
    process.stdout.write("keeldocs sync - nothing to sync.\n");
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  (async () => {
    let applied = 0;
    for (const p of proposals) {
      process.stdout.write(`\n[${p.kind}] ${p.doc}:${p.line}  ${p.id}\n`);
      let done = false;
      while (!done) {
        const a = (await ask("  apply/next/snooze/why/quit [y/n/s/w/q]? ")).trim().toLowerCase();
        if (a === "y") { try { const r = applyOne(root, docTexts, p); journalApplied(root, [r]); applied++; } catch (e) { process.stdout.write(`  error: ${e.message}\n`); } done = true; }
        else if (a === "n") { try { rejectOne(root, p, findings); } catch (e) { process.stdout.write(`  error: ${e.message}\n`); } done = true; }
        else if (a === "s") { appendDecisions(root, [{ at: new Date().toISOString(), actor: actor(), type: "snooze", target: p.id, expires: new Date(Date.now() + 21 * 86400_000).toISOString() }]); done = true; }
        else if (a === "w") { process.stdout.write(`  ${p.evidence}\n`); }
        else if (a === "q") { rl.close(); process.stdout.write(`\n${applied} applied. run keeldocs check to confirm.\n`); process.exit(0); }
        else done = true; // anything else = skip
      }
    }
    rl.close();
    process.stdout.write(`\n${applied} applied. run keeldocs check to confirm.\n`);
    process.exit(0);
  })();
  return null; // process exits inside the loop
}

function emit(json, exit, envelope) {
  if (json) {
    let s = JSON.stringify(envelope);
    if (s.length > 8192) { envelope.data.proposals = (envelope.data.proposals ?? []).slice(0, 3); envelope.truncated = true; s = JSON.stringify(envelope); }
    process.stdout.write(s + "\n");
  } else {
    const d = envelope.data;
    const lines = [`keeldocs sync - ${envelope.code}`, envelope.summary, ""];
    for (const a of d.applied ?? []) lines.push(`  APPLIED   ${a.id} (${a.action}${a.to ? ` -> ${a.to}` : ""})`);
    for (const p of d.proposals ?? []) {
      lines.push(`  PROPOSED  [${p.kind}] ${p.doc}:${p.line}  ${p.id}${p.candidate ? `  -> ${p.candidate}` : ""}`);
      lines.push(`            why: ${p.evidence}`);
    }
    if (envelope.full) lines.push("", `full proposals: ${envelope.full}`);
    process.stdout.write(lines.join("\n") + "\n");
  }
  return exit;
}
