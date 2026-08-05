// `keeldocs noise` - the counts-only noise report (KEEL-17).
//
// E9's pass condition is an accept rate sustained over four weeks across a
// cohort, and the standing kill list forbids required telemetry. Both hold at
// once only if the measurement travels by hand: a user runs this, reads what it
// says, and decides whether to paste it into an issue. Nothing here is invoked
// by `check`, and no command in this project opens a socket.
//
// The output is counts and rates. It carries no path, no document title, no
// section id, no fact id and no repository name - which matters because the
// journal is made of exactly those things: every entry's `target` is a section
// or fact identifier, so a report that summarized entries carelessly would ship
// a map of someone's private repository to a public issue tracker.
//
// It is also a pure function of the journal, with no clock read at all. The
// window is anchored on the newest entry rather than on `now`, so two people
// running it on the same journal get the same bytes, and so does a test.

const TYPES = ["applied", "rejection", "snooze", "tombstone", "waiver", "rebind", "revoke"];
const DAY = 86400_000;
const WEEKS = 4;

// Same rule as src/journal.js noiseStats: 3+ rejections in the window AND
// rejections outnumbering applies 2:1. Restated here against the report's own
// window rather than imported, because the two windows are anchored differently
// (that one on the policy clock, this one on the data) and a shared helper
// would hide the difference rather than remove it.
const quietOf = (applied, rejected) => (rejected >= 3 && rejected > 2 * applied ? "quiet" : "normal");

export function noiseReport({ entries = [], malformed = [] } = {}) {
  const dated = entries.filter((e) => typeof e.at === "string" && !isNaN(Date.parse(e.at)));
  if (!dated.length) {
    return { v: 1, windowWeeks: WEEKS, windowEnd: null, entries: 0, malformed: malformed.length,
             counts: Object.fromEntries(TYPES.map((t) => [t, 0])), decided: 0, acceptRate: null,
             nudgeLevel: "normal", weeks: [] };
  }
  const end = dated.map((e) => Date.parse(e.at)).sort((a, b) => b - a)[0];
  const start = end - WEEKS * 7 * DAY;

  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const weeks = Array.from({ length: WEEKS }, () => ({ applied: 0, rejected: 0 }));
  let inWindow = 0;
  for (const e of dated) {
    const t = Date.parse(e.at);
    if (t <= start || t > end) continue;
    inWindow++;
    if (e.type in counts) counts[e.type]++;
    // Week 1 is the OLDEST of the four, so a pasted report reads left to right
    // as time moving forward. Math.min pins the newest entry, which sits exactly
    // on `end`, inside the last bucket instead of one past it.
    const idx = Math.min(WEEKS - 1, Math.floor((t - start) / (7 * DAY)));
    if (e.type === "applied") weeks[idx].applied++;
    else if (e.type === "rejection") weeks[idx].rejected++;
  }
  const decided = counts.applied + counts.rejection;
  return {
    v: 1,
    windowWeeks: WEEKS,
    windowEnd: new Date(end).toISOString(),
    entries: inWindow,
    malformed: malformed.length,
    counts,
    decided,
    // null, never 0, when nothing was decided: a rate of zero is a claim that
    // every proposal was rejected, and "no data" is a different answer.
    acceptRate: decided ? Number((counts.applied / decided).toFixed(3)) : null,
    nudgeLevel: quietOf(counts.applied, counts.rejection),
    weeks,
  };
}

export function renderNoise(r) {
  const pct = r.acceptRate === null ? "n/a" : `${Math.round(r.acceptRate * 100)}%`;
  const L = [
    "keeldocs noise - counts only, safe to paste in public",
    "",
    `  window        ${r.windowWeeks} weeks ending ${r.windowEnd ?? "(no decisions recorded)"}`,
    `  decisions     ${r.entries} in window` + (r.malformed ? ` (${r.malformed} malformed line(s) skipped)` : ""),
    `  accept rate   ${pct}  (${r.counts.applied} applied / ${r.counts.rejection} rejected)`,
    `  other         ${r.counts.snooze} snoozed, ${r.counts.tombstone} tombstoned, ` +
      `${r.counts.waiver} waived, ${r.counts.rebind} rebound, ${r.counts.revoke} revoked`,
    `  nudge level   ${r.nudgeLevel}`,
  ];
  if (r.weeks.length) {
    L.push("", "  week  applied  rejected");
    r.weeks.forEach((w, i) => L.push(`  ${String(i + 1).padStart(4)}  ${String(w.applied).padStart(7)}  ${String(w.rejected).padStart(8)}`));
  }
  L.push("", "  Nothing above identifies a file, a section, or this repository.",
    "  keeldocs sends nothing anywhere; pasting this is your decision.");
  return L.join("\n");
}
