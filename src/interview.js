// keeldocs interview / answer - brownfield elicitation (design §10, the
// audit-item-7 v0.2 slice). Rationale is ELICITED, never asserted: cards are
// generated ONLY from state the engine already computes deterministically -
//   removal:  a dead binding with no tombstone ("was this removal intentional?")
//             confirm -> journal tombstone, the drift engine's existing semantic
//   document: the hotspot-x-fan-in plan's top surfaces ("document this next?")
// PR/commit-subject mining stays v0.3 (`mine`, outside agent context, as
// designed). No LLM, no network, no wall clock in generation.
//
// Resumable purely from committed files (the roadmap gate):
//   .keeldocs/interview/answers.jsonl - append-only, latest-wins per qid:
//       {qid, kind, subject, verdict: confirm|correct|reject|unknown,
//        author, at, text?}
//   .keeldocs/interview/queue.yaml    - regenerated open-card export so
//       teammates SEE open questions without running the tool (never re-read
//       by the engine: state lives in facts + answers, not in the export)
// Batch cap: 5 cards, <=6000 chars (~1,500 tokens at ADR-010's 4 chars/token).
// `unknown` keeps a card open (re-asked later, sorted last); confirm/correct/
// reject settle it. A reject is ALSO journaled (type interview-reject) - the
// roadmap's "rejected candidates never re-asked (journal-verified)" gate.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { jcs } from "./jcs.js";
import { parseDoc } from "./anchors.js";
import { loadJournal, effective, appendDecisions } from "./journal.js";
import { extractAll } from "./facts.js";
import { evaluate } from "./drift.js";
import { loadConfig, docPathsOf, extractOpts } from "./config.js";
import { buildPlan } from "./init.js";
import { redact } from "./redact.js";

export const BATCH_CAP = 5;
export const BATCH_CHAR_BUDGET = 6000; // ~1,500 tokens at 4 chars/token (ADR-010 arithmetic)
const EVIDENCE_CAP = 200;

export const qidOf = (kind, subject) =>
  "iv-" + createHash("sha256").update(`${kind}\x00${subject}`).digest("hex").slice(0, 12);

const inCI = () => process.env.CI === "true" || process.env.CI === "1";

// ---------- answers (committed, append-only, latest-wins per qid) ----------

const answersPath = (root) => join(root, ".keeldocs", "interview", "answers.jsonl");

export function loadAnswers(root) {
  const byQid = new Map();
  const p = answersPath(root);
  if (!existsSync(p)) return byQid;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.qid !== "string" || typeof e.verdict !== "string" || typeof e.at !== "string") continue;
      const prev = byQid.get(e.qid);
      if (!prev || String(e.at) > String(prev.at)) byQid.set(e.qid, e);
    } catch { /* malformed lines are skipped, never fatal - append-only human record */ }
  }
  return byQid;
}

// ---------- card generation (pure; exported for tests) ----------

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const scrub = (s) => redact(String(s)).clean; // evidence quotes pass the barrier (ADR-013)

export function loadMined(root) {
  const p = join(root, ".keeldocs", "cache", "mined", "candidates.jsonl");
  const out = [];
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.sha === "string" && typeof e.subject === "string") out.push(e);
    } catch { /* mined cache is disposable - skip bad lines */ }
  }
  return out;
}

export function generateCards({ findings, factsById, documented, journal, answers, mined = [] }) {
  const cards = [];
  const seen = new Set();

  // removal cards: dead bindings, per missing fact id, tombstone-free only
  for (const f of findings) {
    if (f.state !== "dead") continue;
    for (const m of f.missing ?? []) {
      if (journal.tombstone.has(m) || seen.has(`removal\x00${m}`)) continue;
      seen.add(`removal\x00${m}`);
      const cands = (f.candidates ?? []).slice(0, 2);
      cards.push({
        qid: qidOf("removal", m), kind: "removal", subject: m,
        question: `\`${m}\` is bound in ${f.doc}:${f.line} (anchor \`${f.id}\`) but no longer exists in code. Was the removal intentional?`,
        evidence: cands.length ? [clip(scrub(`possible successor(s): ${cands.join(", ")}`), EVIDENCE_CAP)] : [],
        verdicts: {
          confirm: "intentional - record a tombstone (check reports intentionally_removed, not drift)",
          correct: "explain what happened (--text required); recorded, binding stays for rebind/edit",
          reject: "not intentional - keep as drift to fix",
          unknown: "skip for now (re-asked later)",
        },
      });
    }
  }

  // rationale cards (R4): mined commit subjects, outside-agent-context by
  // design - the card only QUOTES the (redacted, capped) subject; the human
  // owns the why. Ranked between removals and document-next.
  for (const m of mined) {
    if (seen.has(`rationale\x00${m.sha}`)) continue;
    seen.add(`rationale\x00${m.sha}`);
    cards.push({
      qid: qidOf("rationale", m.sha), kind: "rationale", subject: m.sha,
      question: `Commit ${m.sha} says ${JSON.stringify(clip(scrub(m.subject), 120))}${m.file ? ` (touching \`${m.file}\`)` : ""}. Is the WHY behind it worth capturing?`,
      evidence: [],
      verdicts: {
        confirm: "yes - draft it as an ADR (keeldocs new adr) and link the commit",
        correct: "capture with your own wording (--text required)",
        reject: "no - never ask about this commit again",
        unknown: "skip for now (re-asked later)",
      },
    });
  }

  // document cards: the plan's ranked undocumented surfaces
  for (const p of buildPlan(factsById, documented)) {
    if (seen.has(`document\x00${p.surface}`)) continue;
    seen.add(`document\x00${p.surface}`);
    const hotTxt = p.hot.commits || p.hot.fanIn
      ? ` and hot (${p.hot.commits} commit(s) in window, ${p.hot.fanIn} importer(s))` : "";
    const src = factsById.get(p.surface)?.provenance?.source?.[0]?.file;
    cards.push({
      qid: qidOf("document", p.surface), kind: "document", subject: p.surface,
      question: `\`${p.surface}\` is undocumented${hotTxt}. Document it next?`,
      evidence: src ? [clip(scrub(`source: ${src}`), EVIDENCE_CAP)] : [],
      verdicts: {
        confirm: "yes - document it (agent drafts via new/slot-write; you review)",
        correct: "document it, with a note (--text required)",
        reject: "no - never ask about this surface again",
        unknown: "skip for now (re-asked later)",
      },
    });
  }

  // settled answers close a card; `unknown` keeps it open but sorts it last
  // within its kind (removal cards always precede document cards). The sort is
  // STABLE on (kind, skipped) only - within a kind, generation order IS the
  // ranking (findings order for removals, plan hotspot-x-fan-in for documents).
  const open = cards.filter((c) => {
    const v = answers.get(c.qid)?.verdict;
    return v !== "confirm" && v !== "correct" && v !== "reject";
  });
  const kindRank = { removal: 0, rationale: 1, document: 2 };
  open.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind])
    || ((answers.get(a.qid) ? 1 : 0) - (answers.get(b.qid) ? 1 : 0)));
  return { open, total: cards.length };
}

// Batch = the next <=5 open cards under the char budget (drop from the end -
// the ordering already encodes priority). Deterministic by construction.
export function batchOf(open) {
  const batch = [];
  let chars = 0;
  for (const c of open) {
    const size = JSON.stringify(c).length;
    if (batch.length >= BATCH_CAP || chars + size > BATCH_CHAR_BUDGET) break;
    batch.push(c);
    chars += size;
  }
  return { batch, chars };
}

// ---------- state assembly shared by both commands ----------

function assemble(root) {
  const cfg = loadConfig(root);
  if (!cfg.ok) return { error: { code: "CONFIG", summary: cfg.error } };
  const { factsById, capabilities, toolError } =
    extractAll(root, extractOpts(cfg.config));
  if (toolError) return { error: { code: "TOOL_ERROR", summary: `interview needs a healthy extraction: ${toolError}` } };
  const anchors = [], regions = [];
  for (const p of docPathsOf(root, cfg.config.docs.dirs)) {
    const parsed = parseDoc(readFileSync(join(root, p), "utf8"), p);
    anchors.push(...parsed.anchors);
    regions.push(...parsed.regions);
  }
  const journal = effective(loadJournal(root), "9999-12-31T00:00:00Z"); // structure only; expiry is check's concern
  const { findings, documented } = evaluate({ anchors, regions, factsById, capabilities, journal });
  const answers = loadAnswers(root);
  return { state: { findings, factsById, documented, journal, answers, mined: loadMined(root) } };
}

// ---------- queue.yaml export (written, never re-read by the engine) ----------

function writeQueue(root, progress, batch) {
  const lines = [
    "# keeldocs interview queue - REGENERATED by `keeldocs interview`; do not edit.",
    "# Answer with: keeldocs answer <qid> <confirm|correct|reject|unknown> [--text \"...\"] [--by name]",
    "# Committed so teammates see open questions without running the tool.",
    `progress: { answered: ${progress.answered}, open: ${progress.open}, total: ${progress.total} }`,
    "cards:",
  ];
  for (const c of batch) {
    lines.push(`  - qid: ${c.qid}`);
    lines.push(`    kind: ${c.kind}`);
    lines.push(`    subject: ${JSON.stringify(c.subject)}`);
    lines.push(`    question: ${JSON.stringify(c.question)}`);
    for (const e of c.evidence) lines.push(`    evidence: ${JSON.stringify(e)}`);
  }
  const p = join(root, ".keeldocs", "interview", "queue.yaml");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}

// ---------- commands ----------

function emit(json, exit, env) {
  process.stdout.write(json ? JSON.stringify(env) + "\n" : humanize(env));
  return exit;
}

function humanize(env) {
  const lines = [`keeldocs interview - ${env.code}`, env.summary, ""];
  for (const c of env.data.cards ?? []) {
    lines.push(`  [${c.qid}] (${c.kind}) ${c.question}`);
    for (const e of c.evidence) lines.push(`      ${e}`);
  }
  if (env.next?.length) lines.push("", `next: ${env.next.join(" | ")}`);
  return lines.join("\n") + "\n";
}

// keeldocs mine (doc 11 R4): rationale CANDIDATES from local git history -
// commit subjects only, scored why-strength x file-churn, written to the
// gitignored mined cache. Runs OUTSIDE agent context (design §10): nothing
// here enters a prompt; the interview quotes candidates one card at a time.
// Deterministic: HEAD-anchored window (no wall clock), sorted output.
// Local git only - PR-title mining waits for a fetch story under the R2
// injection posture (forge text is attacker-influenceable by definition).
const WHY_STRONG = /\b(fix|revert|workaround|hotfix|perf|regression|security)\b/i;
const WHY_WEAK = /\b(because|cap|limit|increase|decrease|switch|migrate|replace|deprecate|tune)\b/i;

export function runMine({ root, json }) {
  const g = (a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  const head = g(["show", "-s", "--format=%ct", "HEAD"]);
  if (head.status !== 0) {
    return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR",
      summary: "mine needs git history (no HEAD here)", data: {}, next: [] });
  }
  const since = new Date((parseInt(head.stdout.trim(), 10) - 365 * 86400) * 1000).toISOString();
  const log = g(["log", "--no-merges", `--since=${since}`, "--date-order",
    "--pretty=%x00%h%x1f%s", "--name-only"]);
  if (log.status !== 0) {
    return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR",
      summary: `git log failed: ${(log.stderr || "").slice(0, 200)}`, data: {}, next: [] });
  }
  const touch = new Map(); // file -> commits touching it in window
  const commits = [];
  for (const block of log.stdout.split("\x00").slice(1)) {
    const [headLine, ...files] = block.split("\n").filter(Boolean);
    const [sha, subject] = headLine.split("\x1f");
    const fs_ = files.filter((f) => !f.startsWith(".keeldocs/"));
    commits.push({ sha, subject: subject ?? "", files: fs_ });
    for (const f of fs_) touch.set(f, (touch.get(f) ?? 0) + 1);
  }
  const cands = [];
  for (const c of commits) {
    const strength = WHY_STRONG.test(c.subject) ? 2 : WHY_WEAK.test(c.subject) ? 1 : 0;
    if (!strength || c.subject.length < 10) continue;
    const hot = c.files.map((f) => touch.get(f) ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const file = [...c.files].sort((a, b) => (touch.get(b) - touch.get(a)) || a.localeCompare(b))[0] ?? null;
    cands.push({ sha: c.sha, subject: scrub(c.subject).slice(0, 200), file,
      score: strength * (1 + hot) });
  }
  cands.sort((a, b) => b.score - a.score || a.sha.localeCompare(b.sha));
  const top = cands.slice(0, 20);
  const dir = join(root, ".keeldocs", "cache", "mined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "candidates.jsonl"),
    top.map((c) => jcs(c)).join("\n") + (top.length ? "\n" : ""));
  return emit(json, 0, {
    v: 1, ok: true, code: top.length ? "MINED" : "NOTHING_MINED",
    summary: `${top.length} rationale candidate(s) from ${commits.length} commit(s) in the HEAD-anchored 365d window (cache only, gitignored)`.slice(0, 300),
    data: { candidates: top.length, window: { since } },
    truncated: cands.length > top.length,
    next: top.length ? ["keeldocs interview"] : [],
  });
}

export function runInterview({ root, json }) {
  const { error, state } = assemble(root);
  if (error) {
    return emit(json, 2, { v: 1, ok: false, code: error.code,
      summary: error.summary.slice(0, 300), data: {}, next: [] });
  }
  const { open, total } = generateCards(state);
  const { batch, chars } = batchOf(open);
  const progress = { answered: total - open.length, open: open.length, total };
  if (!inCI()) writeQueue(root, progress, batch); // CI stays read-only, like every decision surface
  const code = batch.length ? "INTERVIEW" : "NOTHING_TO_ASK";
  const summary = batch.length
    ? `${batch.length} question card(s) (${progress.answered}/${total} answered); reply via \`keeldocs answer <qid> <verdict>\``
    : `nothing to ask: ${progress.answered}/${total} candidate(s) answered, no open drift-removals or plan surfaces`;
  return emit(json, 0, {
    v: 1, ok: true, code, summary: summary.slice(0, 300),
    data: { progress, cards: batch, budget: { chars, cap: BATCH_CHAR_BUDGET, cards: BATCH_CAP } },
    truncated: open.length > batch.length,
    next: batch.length ? ["keeldocs answer <qid> <confirm|correct|reject|unknown>"] : [],
  });
}

export function runAnswer({ root, json, args }) {
  const pos = args.filter((a) => !a.startsWith("--"));
  const [, qid, verdict] = pos;
  const VERDICTS = new Set(["confirm", "correct", "reject", "unknown"]);
  const usage = "usage: keeldocs answer <qid> <confirm|correct|reject|unknown> [--text \"...\"] [--by name]";
  if (!qid || !VERDICTS.has(verdict)) {
    return emit(json, 2, { v: 1, ok: false, code: "USAGE", summary: usage, data: {}, next: [] });
  }
  if (inCI()) {
    return emit(json, 2, { v: 1, ok: false, code: "CONFIG",
      summary: "answer is disabled in CI: interview decisions are made by humans, locally",
      data: {}, next: [] });
  }
  const tIdx = args.indexOf("--text");
  const text = tIdx !== -1 ? args[tIdx + 1] : undefined;
  if (verdict === "correct" && !text) {
    return emit(json, 2, { v: 1, ok: false, code: "USAGE",
      summary: "verdict `correct` requires --text (the correction IS the answer)", data: {}, next: [] });
  }
  const { error, state } = assemble(root);
  if (error) {
    return emit(json, 2, { v: 1, ok: false, code: error.code,
      summary: error.summary.slice(0, 300), data: {}, next: [] });
  }
  const { open } = generateCards(state);
  const card = open.find((c) => c.qid === qid);
  if (!card) {
    return emit(json, 2, { v: 1, ok: false, code: "UNKNOWN_ID",
      summary: `no open card \`${qid}\` (already settled, or regenerate with keeldocs interview)`,
      data: {}, next: ["keeldocs interview"] });
  }
  const bIdx = args.indexOf("--by");
  const gitName = spawnSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" });
  const author = bIdx !== -1 ? args[bIdx + 1] : (gitName.status === 0 ? gitName.stdout.trim() : "unknown");
  const at = new Date().toISOString(); // policy clock; this command is CI-forbidden

  const entry = { qid, kind: card.kind, subject: card.subject, verdict, author, at,
    ...(text ? { text: String(text).slice(0, 500) } : {}) };
  const p = answersPath(root);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, jcs(entry) + "\n");

  // side-effects ride the EXISTING journal semantics - nothing new to trust:
  // confirm(removal) -> tombstone (drift reports intentionally_removed);
  // reject(any)      -> interview-reject (the journal-verified never-re-ask)
  const effects = [];
  if (verdict === "confirm" && card.kind === "removal") {
    appendDecisions(root, [{ at, actor: author, type: "tombstone", target: card.subject }]);
    effects.push(`tombstone ${card.subject}`);
  } else if (verdict === "reject") {
    appendDecisions(root, [{ at, actor: author, type: "interview-reject", target: qid }]);
    effects.push(`interview-reject ${qid}`);
  }

  const remaining = open.length - (verdict === "unknown" ? 0 : 1);
  return emit(json, 0, {
    v: 1, ok: true, code: "DECISION_RECORDED",
    summary: `${verdict} recorded for ${card.kind} \`${card.subject}\`${effects.length ? ` (${effects.join("; ")})` : ""}; ${remaining} open card(s) remain`.slice(0, 300),
    data: { qid, verdict, kind: card.kind, subject: card.subject, effects, remaining },
    truncated: false,
    next: remaining > 0 ? ["keeldocs interview"] : ["keeldocs check"],
  });
}
