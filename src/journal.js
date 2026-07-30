// Decisions journal reader (ADR-006 / D1 synthesis). Committed, append-only,
// human decisions ONLY: tombstone | snooze | waiver | rejection | rebind | revoke.
// Reader semantics: set-union of lines, latest-entry-wins per (type, target),
// ordering by the `at` field IN THE DATA (never wall clock). Revocation is a new
// entry {type:"revoke", of:<type>, target} - lines are never edited or deleted.
// The engine NEVER writes this file from check/CI paths - reading only, here.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
