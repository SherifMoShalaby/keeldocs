// The envelope-code enumeration: every value the CLI can put in `code`, which
// command emits it, and the exit code it leaves with.
//
// This is the disclosure ledger's argument applied to the other half of the
// envelope. `src/disclosure.js` made "the engine declined to look at this"
// derivable from one list, because eight hand-assembled channels with nothing
// enumerating them produced the same defect six releases running. The `code`
// field had the identical shape and nobody had noticed: thirty-seven codes
// spread across ten files as bare string literals, no list anywhere, and the
// consumer-facing contracts describing whichever subset their author remembered.
//
// The failure mode is not hypothetical and it ran in both directions.
//
// Outward, a code the engine emits that no contract names. `UNREADABLE` is the
// verdict the whole 0.4.x campaign invented so that `check` would stop reporting
// CLEAN over a tree it had not read - and it appeared zero times in `skills/`,
// zero times in `AGENTS.md`, zero times in `adapters/`, and `action.yml`'s
// `outputs.code` description read `CLEAN | DRIFT_FOUND | TOOL_ERROR | CONFIG`.
// An agent that has never been told a code exists cannot act on it, so on the
// surface this project's whole distribution bet runs through, the fix for
// silent non-checking was itself silent.
//
// Inward, a code named in the contracts that the engine cannot emit. That one
// is recorded at the top of `bin/keeldocs.js`: exit 3 was documented there, in
// `AGENTS.md` and in the core skill as `check`'s "budget-degraded" from v0.1,
// and nothing in `src/` ever returned it. Three agent-facing files described an
// unreachable state. Both directions are the same defect - the contract and the
// engine were maintained by hand, separately, from memory - so this list is
// checked both ways.
//
// What forces the joining, since a list nothing enumerates is the thing that
// failed here twice already:
//
//   * The harness scans the ten files that build envelopes for bare uppercase
//     literals. Every one must be a code below or be named in `NOT_CODES`. A new
//     code that joins neither fails the build, which is the `assertClassified`
//     idiom - a choke point rather than a rule each author has to re-apply.
//   * The same gate runs the other way: a code enumerated here must actually
//     appear in the source of a command that claims it, so the exit-3 shape
//     cannot come back.
//   * `CONTRACTS` below says which consumer-facing file instructs an agent on
//     which command, and the required set is DERIVED from that. Adding a code to
//     `sync` makes `skills/sync/SKILL.md` owe it with nothing else edited, which
//     is the property the hand-maintained descriptions never had.
//
// Deliberately inert. Nothing in `src/` imports this module: it is a description
// of the engine that the harness holds the engine to, not a layer the engine
// runs through. Wiring the emit sites to constants would put a new import in the
// `check` path and would not close the hole anyway, because a new site can
// always hand-write a literal - which is exactly what the scan catches and an
// import cannot.

// Uppercase literals in the envelope-building files that are not envelope codes,
// named once so that a literal which is neither can not exist. The list is four
// entries and every one is load-bearing: `HEAD` is the git revision, `ENOENT` is
// a spawn error, and `OK` and `MISSING` are the words `doctor` prints in its
// human table. If this set starts growing, that is the signal that the scan's
// file list has drifted onto files that do not build envelopes.
export const NOT_CODES = new Set(["HEAD", "ENOENT", "OK", "MISSING"]);

// Where each command's envelopes are built. `interview`, `answer` and `mine`
// share `src/interview.js`; `slot-write` and `approve` share `src/slots.js`;
// `skills` builds part of its envelope in `bin/keeldocs.js`, where the catch
// around `installSkills` turns a missing `skills/` directory into TOOL_ERROR
// rather than a Node stack trace on the stream an agent is parsing. `cli` is
// not a command - it is the dispatcher, which owes an envelope for a command
// name it does not know.
export const SOURCES = {
  check: ["src/check.js"],
  init: ["src/init.js"],
  sync: ["src/sync.js"],
  doctor: ["src/doctor.js"],
  new: ["src/newcmd.js"],
  interview: ["src/interview.js"],
  answer: ["src/interview.js"],
  mine: ["src/interview.js"],
  provider: ["src/providercmd.js"],
  skills: ["src/skillscmd.js", "bin/keeldocs.js"],
  "slot-write": ["src/slots.js"],
  approve: ["src/slots.js"],
  noise: ["bin/keeldocs.js"],
  cli: ["bin/keeldocs.js"],
};

// One entry per code. `commands` maps every command that emits it to the exit
// code that command leaves with - a map rather than a list because the same code
// does not always mean the same exit: `EXISTS` is a success from `new` (the
// document is already there, use `sync`) and a refusal from `provider` (declining
// to overwrite a key). Flattening those to one number would have made this file
// the kind of nearly-true documentation the project exists to detect.
//
// An array of exits means the code genuinely spans more than one, and the entry
// says what decides it. Exactly one code is in that position today.
export const CODES = [
  // ---- check: a pure function of the tree, and the four verdicts it reaches --
  {
    code: "CLEAN",
    commands: { check: 0 },
    means: "every anchored section was read and matches the facts it binds",
  },
  {
    code: "DRIFT_FOUND",
    commands: { check: 1 },
    means: "at least one section is stale, dead or tampered; `keeldocs sync` proposes the fix",
  },
  {
    code: "UNREADABLE",
    commands: { check: 1 },
    means:
      "the engine declined to look at part of the repository, so the run has NO drift verdict - " +
      "it outranks DRIFT_FOUND because a drift count over a tree the engine cannot fully read is a " +
      "number it should decline to headline (spec §12)",
  },
  // ---- init ---------------------------------------------------------------
  {
    code: "INITIALIZED",
    commands: { init: 0 },
    means: "starter docs were written and the drift tripwire is armed",
  },
  {
    code: "DRY_RUN",
    commands: { init: 0, skills: 0 },
    means: "the run planned the writes and made none; re-run with --yes (init) or without --dry-run (skills)",
  },
  // ---- sync, both modes ---------------------------------------------------
  {
    code: "APPLIED",
    commands: { sync: 0 },
    means: "section-level patches were applied; run `keeldocs check` to confirm the loop closed",
  },
  {
    code: "PROPOSALS",
    commands: { sync: [0, 1] },
    means:
      "proposals are outstanding and none was applied. Exit 1 when at least one of them is " +
      "appliable, 0 when every remaining proposal needs a human decision the CLI cannot take",
  },
  {
    code: "NOTHING_TO_SYNC",
    commands: { sync: 0 },
    means: "no drift to propose against",
  },
  {
    code: "UPGRADED",
    commands: { sync: 0 },
    means: "`--upgrade` inserted recipe sections a generated doc predated",
  },
  {
    code: "UPGRADES_AVAILABLE",
    commands: { sync: 1 },
    means: "`--upgrade` found recipe sections to insert and inserted none",
  },
  {
    code: "NOTHING_TO_UPGRADE",
    commands: { sync: 0 },
    means: "every generated doc already carries the current recipe's sections",
  },
  {
    code: "DECISION_RECORDED",
    commands: { sync: 0, answer: 0 },
    means: "a human decision was journaled - a rejection, a snooze, or an interview verdict",
  },
  // ---- doctor: the preflight, and the only command that returns 3 ----------
  {
    code: "READY",
    commands: { doctor: 0 },
    means: "every hard prerequisite is present and every shipped provider can run",
  },
  {
    code: "BLOCKED",
    commands: { doctor: 1 },
    means: "a hard prerequisite is missing - node below the engines floor, no python3, or no git",
  },
  {
    code: "DEGRADED",
    commands: { doctor: 3 },
    means:
      "the run is usable but partial: some providers cannot run, so the answer is incomplete " +
      "rather than wrong. `doctor` is the only command that returns 3",
  },
  // ---- shared failure codes ------------------------------------------------
  {
    code: "CONFIG",
    commands: { check: 2, init: 2, sync: 2, new: 2, interview: 2, answer: 2, provider: 2 },
    means: "keeldocs.toml could not be read, or the invocation is refused by policy (`--live` in CI)",
  },
  {
    code: "TOOL_ERROR",
    commands: {
      check: 2, init: 2, sync: 2, doctor: 2, new: 2, interview: 2, answer: 2, mine: 2,
      provider: 2, skills: 2, "slot-write": 2, approve: 2,
    },
    means:
      "the run did not happen - usually an extractor that could not start. It is never evidence " +
      "that the documentation is fine; `keeldocs doctor --json` names the fix for this machine",
  },
  {
    code: "USAGE",
    commands: { cli: 2, new: 2, answer: 2, provider: 2, skills: 2 },
    means: "the command line was malformed; nothing ran",
  },
  // ---- plumbing (ADR-012). No contract covers these commands, so no
  // consumer-facing file owes their codes - see CONTRACTS.
  {
    code: "CREATED",
    commands: { new: 0 },
    means: "a document was rendered from a recipe, born clean",
  },
  {
    code: "EXISTS",
    commands: { new: 0, provider: 2 },
    means:
      "the thing is already there. From `new` that is success - the file is never overwritten, " +
      "use `sync` - and from `provider` it is a refusal to overwrite a key or re-trust a signer",
  },
  {
    code: "NOT_AVAILABLE",
    commands: { new: 2 },
    means: "the recipe's facts do not exist in this repository, so there is nothing to render",
  },
  {
    code: "INTERVIEW",
    commands: { interview: 0 },
    means: "question cards are open for a human to answer",
  },
  {
    code: "NOTHING_TO_ASK",
    commands: { interview: 0 },
    means: "every candidate has been answered and no open removal or plan surface remains",
  },
  {
    code: "UNKNOWN_ID",
    commands: { answer: 2 },
    means: "no open question card carries that id",
  },
  {
    code: "MINED",
    commands: { mine: 0 },
    means: "rationale candidates were written to the gitignored cache",
  },
  {
    code: "NOTHING_MINED",
    commands: { mine: 0 },
    means: "the HEAD-anchored window yielded no rationale candidate",
  },
  {
    code: "KEY_GENERATED",
    commands: { provider: 0 },
    means: "a provider signing keypair was written",
  },
  {
    code: "SIGNED",
    commands: { provider: 0 },
    means: "a provider manifest was signed",
  },
  {
    code: "TRUSTED",
    commands: { provider: 0 },
    means: "a signer was added to [trust] keys",
  },
  {
    code: "PERMISSIONS",
    commands: { provider: 0 },
    means: "the provider's permission manifest was printed; nothing was installed",
  },
  {
    code: "CONSENT_REQUIRED",
    commands: { provider: 1 },
    means:
      "installing a third-party provider is a human decision. The manifest is printed and the " +
      "command stops; never pass --yes on the user's behalf",
  },
  {
    code: "REFUSED",
    commands: { provider: 2 },
    means: "the provider failed a trust or permission precondition and was not installed",
  },
  {
    code: "INSTALLED",
    commands: { provider: 0, skills: 0 },
    means: "a provider, or the agent skill files, were written into place",
  },
  {
    code: "SLOT_WRITTEN",
    commands: { "slot-write": 0 },
    means: "prose passed every gate and was written into the slot with its draft label",
  },
  {
    code: "SLOT_REJECTED",
    commands: { "slot-write": 1 },
    means:
      "a prose gate refused the text and the envelope names which one - unresolved citations, " +
      "numbers in prose, the word cap, prose stability. Fix the prose; never edit the doc directly",
  },
  {
    code: "APPROVED",
    commands: { approve: 0 },
    means: "a human signed off a draft slot and the draft label was cleared",
  },
  {
    code: "NOISE",
    commands: { noise: 0 },
    means: "journal counts and the current nudge level; reads nothing but the journal",
  },
];

// The consumer-facing contracts, and the commands each one instructs an agent to
// run or read. This is the whole ownership rule, stated once: a file that tells
// an agent to act on a command's envelope owes every code that command can emit.
//
// `covers` is what makes the requirement derived rather than a second list to
// keep in step with the first. Adding a code to `check` makes all three of
// check's contracts owe it immediately, with nothing here edited - which is
// precisely what did not happen when `UNREADABLE` was invented.
//
// Two absences are deliberate. `doctor` has no skill of its own, so the core
// skill carries it: that is the file every other keeldocs skill loads as shared
// context, and `TOOL_ERROR` already sends the agent to `doctor` from there. And
// `adapters/*/manifest.yaml` is not listed because those files describe install
// locations - `skills_dir`, `strip_fields`, `agents_md_block` - and say nothing
// about outcomes, so there is no claim in them to keep true.
export const CONTRACTS = [
  {
    path: "action.yml",
    covers: ["check"],
    role: "the GitHub Action's outputs.code description - the contract a workflow author reads",
  },
  {
    path: "AGENTS.md",
    covers: ["check", "doctor"],
    role: "the universal fallback block, shipped to repositories whose agent has no skills support",
  },
  { path: "skills/check/SKILL.md", covers: ["check"], role: "the check skill" },
  { path: "skills/init/SKILL.md", covers: ["init"], role: "the init skill" },
  { path: "skills/sync/SKILL.md", covers: ["sync"], role: "the sync skill" },
  {
    path: "skills/keeldocs-core/SKILL.md",
    covers: ["doctor"],
    role: "shared context for every keeldocs skill, and doctor's only contract",
  },
];

// Every code a command can emit, in enumeration order.
export function codesOf(command) {
  return CODES.filter((c) => Object.hasOwn(c.commands, command));
}

// Every code a contract must name, derived from the commands it covers. A code
// reachable from two covered commands is owed once.
export function requiredCodes(contract) {
  return CODES.filter((c) => contract.covers.some((cmd) => Object.hasOwn(c.commands, cmd)));
}

// The exits a code can leave with under one command, always as an array, so a
// caller never has to ask which of the two shapes `commands` used here.
export function exitsOf(entry, command) {
  const e = entry.commands[command];
  return Array.isArray(e) ? e : [e];
}

// The files the scan reads: every file any command builds an envelope in.
export function envelopeSources() {
  return [...new Set(Object.values(SOURCES).flat())].sort();
}
