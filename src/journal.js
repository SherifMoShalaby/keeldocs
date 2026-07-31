// Decisions journal reader (ADR-006 / D1 synthesis). Committed, append-only,
// human decisions ONLY: tombstone | snooze | waiver | rejection | rebind | revoke.
// Reader semantics: set-union of lines, latest-entry-wins per (type, target),
// ordering by the `at` field IN THE DATA (never wall clock). Revocation is a new
// entry {type:"revoke", of:<type>, target} - lines are never edited or deleted.
// The engine NEVER writes this file from check/CI paths - reading only, here.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { jcs } from "./jcs.js";

// Append human decisions. HARD GUARD (spec §6): journal writes are disabled in
// CI - only interactive/explicitly-flagged local commands may append. Entries
// are JCS-canonical single lines; revocation is a new entry, never an edit.
export function appendDecisions(repoRoot, entries) {
  if (process.env.CI === "true" || process.env.CI === "1") {
    throw new Error("journal writes are disabled in CI (decisions are made by humans, locally)");
  }
  const path = join(repoRoot, ".keeldocs", "decisions.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const lines = entries.map((e) => {
    if (typeof e.type !== "string" || typeof e.target !== "string" || typeof e.at !== "string") {
      throw new Error("journal entry requires type, target, at");
    }
    return jcs(e);
  });
  appendFileSync(path, lines.join("\n") + "\n");
  return lines.length;
}

export function loadJournal(repoRoot) {
  const path = join(repoRoot, ".keeldocs", "decisions.jsonl");
  const entries = [];
  const malformed = [];
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.type !== "string" || typeof e.target !== "string" || typeof e.at !== "string") {
          malformed.push({ line: i + 1, reason: "missing-fields" });
          continue;
        }
        entries.push(e);
      } catch {
        malformed.push({ line: i + 1, reason: "bad-json" });
      }
    }
  }
  return { entries, malformed };
}

// Accept-rate noise stats (ADR-012's self-throttle). Counts EVENTS in the
// trailing 30 days (raw entries, not latest-wins) under the policy clock -
// wall time locally, HEAD commit time in --ci, same rule as snooze expiry.
// The quiet rule is documented product behavior: when a human has rejected
// 3+ proposals in the window and rejections outnumber applies 2:1, agents
// must stop nudging (data.noise.nudgeLevel = "quiet") until the ratio heals.
export function noiseStats(journal, nowIso) {
  const windowStart = new Date(new Date(nowIso).getTime() - 30 * 86400_000).toISOString();
  let applies = 0, rejections = 0;
  for (const e of journal.entries) {
    if (String(e.at) <= windowStart || String(e.at) > String(nowIso)) continue;
    if (e.type === "applied") applies++;
    else if (e.type === "rejection") rejections++;
  }
  const quiet = rejections >= 3 && rejections > 2 * applies;
  return { applies30d: applies, rejections30d: rejections, nudgeLevel: quiet ? "quiet" : "normal" };
}

// Effective state per (type, target) after latest-wins + revocations.
export function effective(journal, nowIso) {
  const latest = new Map(); // key "type\x00target" -> entry
  for (const e of journal.entries) {
    const key = `${e.type}\x00${e.target}`;
    const prev = latest.get(key);
    if (!prev || String(e.at) > String(prev.at)) latest.set(key, e);
  }
  const active = { tombstone: new Set(), snooze: new Set(), waiver: new Set(), rejection: new Map() };
  for (const [, e] of latest) {
    if (e.type === "revoke") continue; // handled below by lookup
    const revoked = latest.get(`revoke\x00${e.target}`);
    if (revoked && revoked.of === e.type && String(revoked.at) > String(e.at)) continue;
    if (e.type === "tombstone") active.tombstone.add(e.target);
    else if (e.type === "snooze") {
      // expires at read time - no mutation ever (spec §6)
      if (!e.expires || String(e.expires) > String(nowIso)) active.snooze.add(e.target);
    } else if (e.type === "waiver") active.waiver.add(e.target);
    else if (e.type === "rejection") active.rejection.set(e.target, e.content_hash ?? null);
  }
  return active;
}
