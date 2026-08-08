// The disclosure ledger: one disposition for every point where the engine
// declined to look at something.
//
// Six releases in a row shipped a fix for the same defect. `0.4.0` found six
// shapes in which `check` reported CLEAN over something it had not checked,
// `0.4.1` three more, `0.4.2` three, `0.4.3` twelve - and every one of them was
// found in the tree its predecessor shipped from. They were never twelve bugs.
// They were one missing abstraction, and the proof is that each fix added a
// NEW hand-assembled channel - `quarantined`, `unverified`, `unscanned`,
// `skipped`, `excludedDocs`, `journalMalformed`, `extractionGaps`,
// `meta.scopedOut` - and then hand-wired it into four separate places: the
// report, the envelope, the human rendering, and a summing expression in
// `check.js` that read
//
//     const unreadable = refused.length + unverified + unscanned.length
//                      + journalMalformed.length;
//
// A hand-maintained sum is a list nothing enumerates. A ninth decline site that
// forgot to join it would be invisible in exactly the way the previous eight
// were: no verdict, no envelope key, no line of output, exit 0, CLEAN. That is
// the whole family in one sentence, and the fix is not a ninth patch - it is to
// make the sum DERIVED from an enumeration that a new site cannot avoid joining.
//
// Two things force the joining, and neither is a convention anybody has to
// remember:
//
//   * `assertClassified` runs inside `buildReport` on every run of every
//     repository. Every top-level key of the report must be either a channel
//     here or named in `NOT_DISPOSITIONS`. A new key that is neither throws,
//     which surfaces as TOOL_ERROR exit 2 - fail closed, in the direction this
//     project's whole thesis points. It is a pure key-set comparison: no clock,
//     no network, no LLM, nothing that could make `check` stop being a pure
//     function of the tree.
//   * The harness holds `check.js` to naming no channel at all. Verdict,
//     summary, envelope projection and human rendering all iterate `CHANNELS`,
//     so adding a channel is adding one entry here and touching nothing else -
//     and hand-assembling one somewhere else fails the build.
//
// This is the `isHostileFact` idiom applied a second time: one choke point
// instead of a rule everyone has to re-apply per site. That one has produced no
// recurring injection family in four releases of changelog, which is the only
// evidence available that the idiom works.
//
// Deliberately NOT a serialized key. The ledger is derived from the report, in
// memory, and is never written to it: the drift-scenario golden compares the
// full report, item shapes here are the shapes consumers already parse, and a
// new top-level key would be a breaking change bought for nothing.

// Envelope and terminal lists are capped so the 8KB trimmer, which only ever
// shrinks `data.top`, is never handed an unbounded list it cannot repair. The
// cap is applied by those two projections, never by the ledger itself: a
// consumer with no 8KB budget - the SARIF emitter - must see every item, and a
// count that a display cap had silently lowered would be this whole family
// happening one more time.
export const CAP = 20;

// `disclosure` is the only thing that decides whether a channel moves the exit
// code, and it has exactly two values:
//
//   "verdict" - the engine could not read something it was asked to read. The
//               run has no drift verdict; `check` exits 1 with UNREADABLE,
//               which outranks DRIFT_FOUND, because a drift count computed over
//               a tree the engine cannot fully read is a number it should
//               decline to headline (spec §11, §12).
//   "named"   - the engine did not look, and that is either the user's written
//               instruction or a standing rule about dependency trees. Naming
//               it moves no exit code: a gate that fires on every repository
//               that has ever run `npm install` is the one people switch off.
//               What it must never do is stay silent, which is what each of
//               these did until the release that found it.
export const CHANNELS = [
  {
    channel: "unscanned",
    key: "unscanned",
    envelope: "unscanned",
    disclosure: "verdict",
    what: "anchored document outside every scan root",
    why: "no [docs] dirs scan root covers it, so it was never read",
    read: (r) => r.unscanned ?? [],
    summary: (items, total) =>
      `${total} anchored doc(s) outside every scan root, unchecked (${items.slice(0, 3).map((u) => u.doc).join(", ")}${total > 3 ? ", ..." : ""}; add to [docs] dirs)`,
    human: (items) => items.map((u) =>
      `  UNSCANNED ${u.doc}  (${u.anchors} anchor(s), ${u.regions} region(s) - outside every [docs] dirs scan root)`),
  },
  {
    channel: "journalMalformed",
    key: "journalMalformed",
    envelope: "journalMalformed",
    disclosure: "verdict",
    at: ".keeldocs/decisions.jsonl",
    what: "unreadable decisions-journal line",
    why: "the reader could not parse it, and a dropped line reinstates whatever it revoked",
    read: (r) => r.journalMalformed ?? [],
    summary: (items, total) =>
      `${total} unreadable decisions-journal line(s) (.keeldocs/decisions.jsonl ${items.slice(0, 3).map((m) => `line ${m.line}: ${m.reason}`).join(", ")}${total > 3 ? ", ..." : ""}; a dropped line reinstates the decision it revoked)`,
    human: (items) => items.map((m) =>
      `  UNREADABLE .keeldocs/decisions.jsonl:${m.line}  (${m.reason} - a line the reader drops reinstates whatever it revoked)`),
  },
  {
    // `quarantined` in the report, `refused` in the envelope. The two names
    // predate this module and are both load-bearing to consumers, so the ledger
    // carries the mapping rather than renaming either.
    channel: "quarantined",
    key: "quarantined",
    envelope: "refused",
    disclosure: "verdict",
    what: "unparseable marker",
    why: "refused byte for byte and contributing no bindings, per spec §12",
    read: (r) => r.quarantined ?? [],
    summary: (items, total) => `${total} unparseable marker(s)`,
    human: (items, total) => total ? [`  note: ${total} malformed marker(s) quarantined`] : [],
  },
  {
    // Derived from `findings`, not from a key of its own: `counts.unverified` is
    // a count, and "3 sections are not being checked" without saying which three
    // is a finding nobody can act on - which is what let `rebaseline` hide for as
    // long as it did.
    channel: "unverified",
    key: null,
    envelope: "unverified",
    disclosure: "verdict",
    what: "section the engine cannot verify",
    why: "a gen region carrying neither hash nor content, or a hash naming an algorithm this engine cannot compare",
    read: (r) => (r.findings ?? []).filter((f) => f.state === "unverified")
      .map((f) => ({ id: f.id, doc: f.doc, line: f.line, reason: f.reason })),
    summary: (items, total) => `${total} section(s) the engine cannot verify`,
    human: (items) => items.map((u) => `  UNVERIFIED ${u.doc}:${u.line}  ${u.id}  (${u.reason})`),
  },
  {
    channel: "skipped",
    key: "skipped",
    envelope: "skipped",
    disclosure: "named",
    what: "directory neither scanned nor swept",
    why: "a standing skip rule; name it in [docs] dirs to read it",
    read: (r) => r.skipped ?? [],
    summary: null,
    human: (items) => items.length
      ? [`  NOT READ  ${items.join(", ")}  (neither scanned nor swept - name one in [docs] dirs to read it)`]
      : [],
  },
  {
    channel: "excludedDocs",
    key: "excludedDocs",
    envelope: "excludedDocs",
    disclosure: "named",
    what: "anchored document the user's own path scope suppressed",
    why: "it matched [providers] exclude-paths, so honouring it is the point of having written it",
    read: (r) => r.excludedDocs ?? [],
    summary: null,
    human: (items) => items.map((u) =>
      `  EXCLUDED  ${u.doc}  (${u.anchors} anchor(s), ${u.regions} region(s) - matched [providers] exclude-paths, so it is not checked)`),
  },
  {
    // Counted, not classified. The full report already names every gap and its
    // reason, and inventing a severity taxonomy here would claim more than is
    // known. `note` rides the coverage sentence because coverage is a ratio and
    // both of its terms have to be legible: "100% of surfaces documented" over a
    // monorepo whose second schema.prisma was never opened read exactly like a
    // repository with one database.
    channel: "extractionGaps",
    key: "extractionGaps",
    envelope: null,
    disclosure: "named",
    what: "surface an extractor declined to read",
    why: "the extractor reported it as a gap rather than failing the run",
    read: (r) => r.extractionGaps ?? [],
    summary: null,
    note: (items, total) => total ? `; ${total} extraction gap(s) - see the full report` : "",
    human: () => [],
  },
  {
    // A count with no item list, disclosed in `meta` beside the scope that
    // caused it. It is here because the enumeration is the point: an entry
    // saying "disclosed in meta, moves no verdict" is the documentation this
    // family never had. `scopedOut: 0` beside a scope the user wrote is itself
    // information - it says the line is not doing what they think.
    channel: "scopedOut",
    key: null,
    envelope: null,
    disclosure: "named",
    what: "fact pruned by the user's path scope",
    why: "it matched [providers] exclude-paths before extraction",
    read: (r) => r.meta?.scopedOut ?? 0,
    summary: null,
    human: () => [],
  },
];

// Every other top-level key of the check report, stated once so that a key which
// is neither a channel nor listed here cannot exist. `conflicts` belongs on this
// side deliberately: ADR-003 conflict records are claims the engine DID look at
// and resolved by a stated rule, which is the opposite of a disposition.
export const NOT_DISPOSITIONS = new Set([
  "v", "meta", "toolError", "cache", "capabilities", "counts", "findings",
  "coverage", "noise", "upgrades", "conflicts",
]);

const CLASSIFIED = new Set([
  ...NOT_DISPOSITIONS,
  ...CHANNELS.map((c) => c.key).filter(Boolean),
]);

// The forcing function. Called from `buildReport` before it returns, so it runs
// on every repository on every run rather than only where a fixture happens to
// trip a channel - the channels are absent-when-empty, so a fixture-only check
// would notice exactly the unjoined channels it was already lucky enough to
// trigger. Throwing is deliberate: it reaches the user as TOOL_ERROR exit 2,
// and a decline-to-look site nobody classified is precisely the thing this
// project must never report CLEAN over.
export function assertClassified(report) {
  const stray = Object.keys(report).filter((k) => !CLASSIFIED.has(k));
  if (stray.length) {
    throw new Error(
      `unclassified check-report key(s): ${stray.join(", ")} - every top-level key must be a ` +
      `disclosure channel in src/disclosure.js CHANNELS or listed in NOT_DISPOSITIONS. A site ` +
      `that declines to look at something and joins neither is invisible to the verdict, which ` +
      `is the defect 0.4.0 through 0.4.3 each shipped a fix for`);
  }
}

// One ledger entry per channel, always all of them, present or empty. `items` is
// every item the channel has; `total` counts them, and is a plain number for the
// one channel that discloses a count with no item list. Both are uncapped here -
// see CAP.
export function ledgerOf(report) {
  return CHANNELS.map((c) => {
    const raw = c.read(report);
    return { ...c, items: Array.isArray(raw) ? raw : [],
             total: Array.isArray(raw) ? raw.length : (raw ?? 0) };
  });
}

// The verdict, derived. This is the line that used to be a hand-maintained sum
// over four names, and it is now a sum over whatever is declared "verdict"
// above - which a new channel cannot fail to be counted by, because it cannot
// exist without declaring one.
export function unreadableOf(entries) {
  return entries.reduce((n, e) => n + (e.disclosure === "verdict" ? e.total : 0), 0);
}
