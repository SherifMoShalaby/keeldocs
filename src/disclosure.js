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

// The place a disclosure that names no place of its own points at. It is the
// file a human edits to change the disposition - `[docs] dirs` and `[providers]
// exclude-paths` both live here - which is the same rule `journalMalformed`
// already followed by anchoring at `.keeldocs/decisions.jsonl`.
//
// It exists because a disclosure with no location is a disclosure that is not
// displayed. GitHub's SARIF documentation states the rule outright - "At least
// one location is required for code scanning to display a result" - so a result
// carrying `locations: []` is emitted, accepted, counted by the emitter's own
// tests, and shown to nobody. That is this project's defect family expressed in
// someone else's UI, and it was live at HEAD: `extractionGaps` items are
// `{kind, file}` and `file` is `null` for `not-a-git-root`, a gap every one of
// the 32 shipped fixtures produces.
//
// Anchoring is deliberately the LEDGER's job and not the emitter's. Only the
// channel knows whether its item names a path at all: `extractionGaps.file`
// carries `moddatetime` (a Postgres extension), `public.rebuild_stats` (a
// procedure), `items` (a table) and `services/api` (a directory) in the shipped
// fixtures, so a consumer that treats the field as a repo path invents file
// locations that do not exist. A channel says where its own items are, once,
// and every consumer reads that instead of guessing.
export const RUN_ANCHOR = "keeldocs.toml";

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
    locate: (u) => ({ path: u.doc, line: 1 }),
    describe: (u) => `${u.anchors} anchor(s), ${u.regions} region(s)`,
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
    // The item names a line, never a file: the file is the channel's `at`.
    locate: (m) => ({ path: null, line: m.line }),
    describe: (m) => `line ${m.line}: ${m.reason}`,
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
    locate: (q) => ({ path: q.doc, line: q.line }),
    describe: (q) => q.reason,
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
    locate: (u) => ({ path: u.doc, line: u.line }),
    describe: (u) => `${u.id}: ${u.reason}`,
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
    // A directory, not a file. Code scanning annotates files, so pointing at
    // `node_modules/` would be a location nothing can be shown against; the
    // place to change this disposition is the `[docs] dirs` line, so the item
    // travels in the text and the anchor is the config.
    locate: () => ({ path: null, line: 1 }),
    describe: (d) => d,
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
    locate: (u) => ({ path: u.doc, line: 1 }),
    describe: (u) => `${u.anchors} anchor(s), ${u.regions} region(s)`,
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
    // `file` is whatever the provider called the thing it declined to read, and
    // it is a repo path only sometimes: the shipped fixtures put `moddatetime`,
    // `public.rebuild_stats`, `items` and `services/api` in it, and it is `null`
    // for `not-a-git-root`, which every fixture produces. It is offered as a
    // location because when it IS a path that is the right annotation, and it is
    // repeated in the text unconditionally so that a subject which is not a path
    // is still legible when nothing can be annotated.
    locate: (g) => ({ path: g.file ?? null, line: 1 }),
    describe: (g) => (g.file ? `${g.kind} (${g.file})` : g.kind),
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
    // Count-only: `disclosuresOf` hands these two the total, not an item. The
    // anchor is the config, which is exactly right here - a fact is only ever
    // scoped out because of an `[providers] exclude-paths` line somebody wrote,
    // so the file the disclosure points at is the file that caused it.
    locate: () => ({ path: null, line: 1 }),
    describe: (n) => `${n} fact(s)`,
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

// The same rule, one level down.
//
// `assertClassified` compared TOP-LEVEL keys only, and two of the eight channels
// above are not top-level keys: `scopedOut` is disclosed inside `meta`, and
// `unverified` is derived from `findings` and tallied into `counts`. Both
// containers sit in `NOT_DISPOSITIONS`, so the guard could not see inside the
// two places a disposition has ever actually been disclosed. It was blind to
// the shape two of its own channels already have.
//
// Measured on this tree before this list existed: a ninth decline site written
// the way `meta.scopedOut` is written - `report.meta.unreviewed = 7` - produced
// an envelope BYTE-IDENTICAL to the clean one, exit 0, CLEAN, named in no
// summary, no envelope key and no terminal line, while the top-level control
// (`wombat`) exited 2 TOOL_ERROR from the same tree. That is this family's exact
// signature reproduced against the abstraction built to end it, which is why it
// is repaired rather than filed.
//
// Two containers, not every container, and the claim is stated at exactly that
// width: a key nested inside `coverage` or `noise` is still outside the guard.
// These two are walked because these two are where a disposition has ever been
// disclosed; walking everything would mean enumerating every nested key of the
// whole report, which is a larger hand-maintained list than the one this module
// exists to replace, and over-claiming here would be the defect under repair.
// The container NAMES need no protection of their own - they are top-level keys,
// so renaming `meta` fails the half above.
export const CONTAINERS = {
  // Built in one object literal in `src/check.js`. `scopedOut` and
  // `excludePaths` appear only when the user configured a path scope, `since`
  // only under `--since`; a key that is sometimes absent is exactly the kind a
  // fixture-based check misses, which is why this is a declared list and not a
  // sample.
  meta: new Set(["engine", "head", "providerSetHash", "docsScanned", "mode",
                 "scopedOut", "excludePaths", "since"]),
  // One key per finding state (`src/drift.js`), plus the two `check.js` derives.
  // This is the half that earns its keep beyond the one defect it was written
  // for: a new finding state is a new way a section can end up not compared, and
  // it arrives here as a new key - so inventing one without deciding whether it
  // is a disposition fails the run instead of being tallied into a number
  // nobody reads.
  counts: new Set(["clean", "stale", "dead", "tampered", "unverified",
                   "unresolvable", "snoozed", "held", "intentionally_removed",
                   "driftTotal", "selfCaused"]),
};

// The forcing function. Called from `buildReport` before it returns, so it runs
// on every repository on every run rather than only where a fixture happens to
// trip a channel - the channels are absent-when-empty, so a fixture-only check
// would notice exactly the unjoined channels it was already lucky enough to
// trigger. Throwing is deliberate: it reaches the user as TOOL_ERROR exit 2,
// and a decline-to-look site nobody classified is precisely the thing this
// project must never report CLEAN over.
export function assertClassified(report) {
  const stray = Object.keys(report).filter((k) => !CLASSIFIED.has(k));
  for (const [name, allowed] of Object.entries(CONTAINERS)) {
    const inner = report[name];
    // An absent container is not a hole: it has no key to classify. A container
    // RENAMED rather than removed fails the top-level pass above, which is where
    // its name lives, so there is no way to escape by moving the walk's target.
    if (!inner || typeof inner !== "object") continue;
    for (const k of Object.keys(inner)) if (!allowed.has(k)) stray.push(`${name}.${k}`);
  }
  if (stray.length) {
    throw new Error(
      `unclassified check-report key(s): ${stray.join(", ")} - every top-level key must be a ` +
      `disclosure channel in src/disclosure.js CHANNELS or listed in NOT_DISPOSITIONS, and every ` +
      `key of meta and counts must be listed in CONTAINERS. A site that declines to look at ` +
      `something and joins none of them is invisible to the verdict, which is the defect 0.4.0 ` +
      `through 0.4.3 each shipped a fix for`);
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

// What a report discloses, flattened into the units a CONSUMER has to account
// for - one per disclosed thing, in ledger order, every channel, uncapped.
//
// The ledger made the ENGINE's disclosures derivable. This makes the consumers'
// derivable too, and it exists because the first consumer to be wired to the
// ledger still lost two channels, in two different ways that a per-channel item
// loop could not see:
//
//   * `scopedOut` discloses a count and no items, so iterating `entry.items`
//     produced ZERO results for a live channel - and the gate that was supposed
//     to catch that asserted `results == items.length`, which for this channel
//     is `0 == 0`. A gate that passes vacuously is not a gate.
//   * `extractionGaps` items name a place only sometimes, so the rest emitted
//     `locations: []`, which GitHub documents as not displayed at all.
//
// Both are the same mistake as the hand-maintained sum: a consumer deciding for
// itself what a channel amounts to. A unit is the answer instead - it always has
// a place, its `path` is never null, and a count-only channel is one unit rather
// than none. A consumer maps units; it does not interpret channels.
//
// Derived in memory from the report, like the rest of the ledger: nothing here
// is serialized, no report or envelope key is added, and no hashed payload is
// touched.
export function disclosuresOf(report) {
  const units = [];
  for (const e of ledgerOf(report)) {
    if (!e.total) continue;
    // A channel that discloses a count with no item list gets exactly one unit,
    // and it is handed the total where the others are handed an item. Zero is
    // not a unit: `scopedOut: 0` beside a scope the user wrote is worth saying
    // in a terminal, where the scope is on screen next to it, and is noise in a
    // list of problems.
    const subjects = e.items.length ? e.items : [e.total];
    for (const subject of subjects) {
      const at = e.locate?.(subject) ?? { path: null, line: 1 };
      units.push({
        channel: e.channel,
        disclosure: e.disclosure,
        what: e.what,
        why: e.why,
        detail: e.describe?.(subject) ?? "",
        // Never null, by construction: the item's own path, else the file this
        // channel is about, else the file that configures the run. A unit with
        // no place is a unit code scanning does not show.
        path: at.path ?? e.at ?? RUN_ANCHOR,
        line: at.line || 1,
      });
    }
  }
  return units;
}

// The verdict, derived. This is the line that used to be a hand-maintained sum
// over four names, and it is now a sum over whatever is declared "verdict"
// above - which a new channel cannot fail to be counted by, because it cannot
// exist without declaring one.
export function unreadableOf(entries) {
  return entries.reduce((n, e) => n + (e.disclosure === "verdict" ? e.total : 0), 0);
}
