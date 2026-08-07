// Drift comparator (ADR-008 + spec §4-5). States are disjoint:
//   clean | stale | tampered | dead | intentionally_removed | unresolvable
//   | unverified | held | snoozed
// Extraction failure is unresolvable (tooling health), NEVER drift - fail closed.
// A recorded hash this engine cannot COMPARE is `unverified`, never a verdict
// and never silence - see the ADR-008 note above NO_RECORDED_HASH below.
// Re-anchoring here is proposal-grade only: candidates are suggested for dead
// bindings; auto-rebind needs the two-signal rule and belongs to sync (ADR-007).

import { factHash, contentHash, hashesMatch, display } from "./hash.js";
import { inheritBinds } from "./anchors.js";
import { ownershipIndex, resolvePackageBind } from "./ownership.js";

// Package-scope resolution needs an ownership index over the whole fact set;
// it is built lazily and memoised per fact map, because a document full of
// per-package sections would otherwise rebuild it for every bind.
const OWNERSHIP = new WeakMap();
function ownershipFor(factsById) {
  let idx = OWNERSHIP.get(factsById);
  if (!idx) { idx = ownershipIndex(factsById); OWNERSHIP.set(factsById, idx); }
  return idx;
}

// Does this repository have a package by that name at all? A package scope that
// names a package the workspace does not contain is a BROKEN binding, not an
// empty one, and the difference is the whole finding below.
function packageExists(name, factsById) {
  for (const f of factsById.values()) {
    if (f.payload.type === "package" && f.payload.attrs.name === name) return true;
  }
  return false;
}

function resolveBind(bind, factsById) {
  if (bind.kind === "package") {
    // A wildcard that matches nothing is normally fine: `fact:db-schema/*` in a
    // repo with no database documents the empty set, which is vacuous but true,
    // and `init` never writes such a section anyway. A PACKAGE scope is not that.
    // `binds=pkg:@acme/gone#http-endpoints/*` names a scope that does not exist,
    // and because the empty set hashes to a constant - the same value in every
    // repository, one no code change can ever move - the section matched it on
    // every run and reported CLEAN in perpetuity. Measured: a document claiming
    // to inventory a package absent from the workspace exited 0, clean, twice.
    // Marking it non-wildcard routes it into `missing`, which is `dead`, which
    // already carries rebind candidates - the machinery for "the thing this
    // documented is not there" rather than a new state beside it.
    const scoped = packageExists(bind.pkg, factsById);
    return { ids: resolvePackageBind(bind, factsById, ownershipFor(factsById)), wildcard: scoped };
  }
  if (bind.wildcard) {
    const ids = [...factsById.keys()].filter((id) => id.startsWith(bind.prefix)).sort();
    return { ids, wildcard: true };
  }
  return { ids: factsById.has(bind.raw) ? [bind.raw] : [], wildcard: false };
}

// Resolved fact ids for a bind set (wildcards expanded) - shared with sync/proposals.
export function resolveBindIds(binds, factsById) {
  const ids = new Set();
  for (const b of binds) for (const id of resolveBind(b, factsById).ids) ids.add(id);
  return [...ids].sort();
}

// Aggregate hash over a bind set: JCS of sorted [id, fullHash] pairs (spec §1 wildcard rule).
export function aggregateHash(ids, factsById) {
  const pairs = ids.map((id) => [id, factsById.get(id).hash]).sort((a, b) => a[0].localeCompare(b[0]));
  if (pairs.length === 1) return pairs[0][1]; // single bind - the fact's own hash
  return factHash({ schema_version: 1, type: "aggregate", pairs });
}

function tokens(s) {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function overlap(a, b) {
  const ta = tokens(a), tb = tokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size || 1;
  return inter / union;
}

// S1b move-matcher (ADR-007 amendment 2, from the hono+zod mini-run): symbols
// lost to cross-file consolidation dominated orphans (21/24) and every one had
// a unique same-name candidate repo-wide. Same final descriptor (name+suffix)
// in another module = candidate; proposal-grade only, never auto-rebind.
function symbolCandidates(missingId, factsById) {
  const tail = missingId.slice(missingId.lastIndexOf("/") + 1);
  return [...factsById.keys()]
    .filter((id) => id.startsWith("ds ") && id !== missingId
                 && id.slice(id.lastIndexOf("/") + 1) === tail)
    .sort().slice(0, 3);
}

// Candidate suggestions for a missing bind - report-only, max 3, deterministic order.
export function candidatesFor(missingId, factsById) {
  if (missingId.startsWith("ds ")) return symbolCandidates(missingId, factsById);
  const out = [];
  const missing = missingId.replace(/^fact:[a-z0-9-]+\//, "");
  const cap = missingId.slice(0, missingId.indexOf("/"));
  for (const id of [...factsById.keys()].sort()) {
    if (!id.startsWith(cap + "/")) continue;
    const cur = id.replace(/^fact:[a-z0-9-]+\//, "");
    let score = 0;
    const mMethod = missing.match(/^([A-Z]+) (.+)$/);
    const cMethod = cur.match(/^([A-Z]+) (.+)$/);
    if (mMethod && cMethod) {
      if (mMethod[1] === cMethod[1]) score = overlap(mMethod[2], cMethod[2]);           // same method, similar path
      else if (mMethod[2] === cMethod[2]) score = 0.9;                                   // same path, different method
    } else {
      score = overlap(missing, cur);
    }
    if (score >= 0.5) out.push({ id, score: Math.round(score * 100) });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out.slice(0, 3).map((c) => c.id);
}

// The two ways a section can carry a hash the engine cannot turn into a verdict.
// They are one STATE and two REASONS on purpose: the user-visible consequence is
// identical - nothing is checking this section - and only the repair note differs.
//
// The second reason used to be its own state, `rebaseline`, and that state was a
// silent false negative of exactly the shape 0.4.0 shipped six fixes for. ADR-008
// says a cross-version hash comparison is invalid and "must re-baseline, never
// render as drift"; the intent is right and the implementation ACCEPTED. Measured
// on one tree, one byte apart: with `hash=h1:...` the section reports `stale`,
// exit 1, DRIFT_FOUND. Change that `1` to a `2` and the same document over the
// same drifted code reports CLEAN, exit 0, "0 drift finding(s)" - the state was
// absent from the summary, absent from `top`, absent from DRIFT_STATES, and
// `buildProposals` had no branch for it, so `sync` answered NOTHING_TO_SYNC and
// there was no way back. Permanently retired from drift detection by one byte.
// `h[0-9]+` is what the parser accepts, so this needed no future engine to reach
// - a merge resolving a marker line badly gets there today.
//
// `unverified` honours ADR-008's intent and refuses its silence: it is NOT in
// DRIFT_STATES, so the run still reports zero drift findings and never cries
// drift over an algorithm change; it IS counted as unreadable, so the exit code
// is 1 and the code is UNREADABLE; and it already carries a regenerate proposal,
// so one `sync` re-baselines against the current algorithm and the state clears.
// That is the re-baseline the ADR asked for, made explicit and consented to.
export const NO_RECORDED_HASH = "no-recorded-hash";
export const UNREADABLE_ALGO = "unreadable-hash-algorithm";

function capabilityOf(bindRaw) {
  if (bindRaw.startsWith("ds ")) return "module-graph"; // ADR-007 second namespace
  const m = bindRaw.match(/^fact:([a-z0-9-]+)\//);
  return m ? m[1] : null;
}

export function evaluate({ anchors, regions, factsById, capabilities, journal }) {
  const findings = [];
  const documented = new Set();
  const add = (f) => findings.push(f);

  const bindState = (binds, where) => {
    // returns {state, ids, missing[]} for a bind set, honoring capability health + journal
    const ids = [];
    const missing = [];
    let unresolvable = false;
    for (const b of binds) {
      const cap = capabilityOf(b.raw);
      if (cap && capabilities[cap]?.status === "failed") { unresolvable = true; continue; }
      const r = resolveBind(b, factsById);
      ids.push(...r.ids);
      // r.wildcard, not b.wildcard: the parsed bind says what it LOOKS like, the
      // resolver says whether it names anything real. They differ in exactly one
      // case - a package scope whose package is not in this workspace - and that
      // case is the false negative.
      if (!r.wildcard && r.ids.length === 0) missing.push(b.raw);
    }
    ids.forEach((id) => documented.add(id));
    if (unresolvable) return { state: "unresolvable", ids, missing };
    if (missing.length) {
      const tombstoned = missing.every((m) => journal.tombstone.has(m));
      return { state: tombstoned ? "intentionally_removed" : "dead", ids, missing };
    }
    return { state: "resolved", ids, missing };
  };

  // Prose slots: unfilled slots (no hash) are silent; a filled slot's recorded
  // hash= is the fact state its prose was written against - mismatch = stale
  // (the agent re-proses via slot-write; the engine never rewrites prose).
  for (const region of regions) {
    if (region.kind !== "slot" || region.hash === undefined) continue;
    const binds = inheritBinds(region, anchors);
    const bs = bindState(binds, region);
    const base = { id: region.id, doc: region.doc, line: region.line, kind: "slot" };
    if (journal.snooze.has(region.id)) { add({ ...base, state: "snoozed" }); continue; }
    if (bs.state === "unresolvable") { add({ ...base, state: "unresolvable" }); continue; }
    if (bs.state !== "resolved") { add({ ...base, state: bs.state, missing: bs.missing }); continue; }
    const cur = aggregateHash(bs.ids, factsById);
    const cmp = hashesMatch(region.hash, cur);
    if (cmp === "version-mismatch") { add({ ...base, state: "unverified", reason: UNREADABLE_ALGO }); continue; }
    if (!cmp) {
      const rejectedAt = journal.rejection.get(region.id);
      if (rejectedAt && rejectedAt === display(cur)) { add({ ...base, state: "held" }); continue; }
      add({ ...base, state: "stale", currentHash: cur.slice(0, 19), recorded: region.hash }); continue;
    }
    add({ ...base, state: "clean" });
  }

  // Gen regions: the committed hash= records what the content was rendered from.
  for (const region of regions) {
    if (region.kind !== "gen") continue;
    const binds = inheritBinds(region, anchors);
    const bs = bindState(binds, region);
    const base = { id: region.id, doc: region.doc, line: region.line, kind: "gen" };
    if (journal.snooze.has(region.id)) { add({ ...base, state: "snoozed" }); continue; }
    if (bs.state === "unresolvable") { add({ ...base, state: "unresolvable" }); continue; }
    if (bs.state !== "resolved") {
      add({ ...base, state: bs.state, missing: bs.missing,
            candidates: bs.state === "dead" ? bs.missing.flatMap((m) => candidatesFor(m, factsById)) : undefined });
      continue;
    }
    // Rejection memory (spec §6 / DX 4d): a recorded rejection holds an identical
    // proposal - identical = the current content/fact hash matches what was rejected.
    const rejectedAt = journal.rejection.get(region.id);
    // tamper check first: hand-edited generated content (ADR-009)
    if (region.content !== undefined) {
      const cur = contentHash(region.body ?? "");
      const cmp = hashesMatch(region.content, cur);
      if (cmp === "version-mismatch") { add({ ...base, state: "unverified", reason: UNREADABLE_ALGO }); continue; }
      if (!cmp) {
        if (rejectedAt && rejectedAt === display(cur)) { add({ ...base, state: "held", detail: "restore proposal rejected; human edit stands" }); continue; }
        add({ ...base, state: "tampered", detail: "gen region content edited by hand" }); continue;
      }
    }
    // Neither hash recorded. The block still looks managed - markers, an id, a
    // body the engine wrote - and it is checked against nothing at all. Deleting
    // two attributes, by hand or by a merge that resolved a marker line badly,
    // made a generated section permanently invisible to drift while continuing to
    // render as keeldocs-managed: the same wrong content reports `stale` with a
    // hash and `clean` without one, exit 0. `patchRegion` already inserts both
    // attributes when they are absent, so one `sync` converges this.
    if (region.hash !== undefined) {
      const cur = aggregateHash(bs.ids, factsById);
      const cmp = hashesMatch(region.hash, cur);
      if (cmp === "version-mismatch") { add({ ...base, state: "unverified", reason: UNREADABLE_ALGO }); continue; }
      if (!cmp) {
        if (rejectedAt && rejectedAt === display(cur)) { add({ ...base, state: "held", detail: "regenerate proposal rejected for this fact state" }); continue; }
        add({ ...base, state: "stale", currentHash: cur.slice(0, 19), recorded: region.hash }); continue;
      }
    }
    // EITHER attribute absent, not both. The two record different things -
    // `content` is the tamper check, `hash` is the fact check - so a region
    // carrying one of them has had exactly half of itself compared, and the half
    // that was skipped is the half that reports nothing. 0.4.1 caught the case
    // where both are gone and left this one: deleting `hash=` alone took a
    // genuinely drifted section from `stale` exit 1 to `clean` exit 0, and
    // deleting `content=` alone does the same for a hand-edited body. Both are
    // one attribute from a bad merge, and `clean` is a claim about a comparison
    // that never happened. The checks above still run first, so a region that IS
    // caught still reports `stale` or `tampered` rather than being softened to
    // `unverified` - this only replaces the fall-through.
    if (region.hash === undefined || region.content === undefined) {
      add({ ...base, state: "unverified", reason: NO_RECORDED_HASH }); continue;
    }
    add({ ...base, state: "clean" });
  }

  // Section anchors: identity + binding health (prose currency is sync's business).
  for (const a of anchors) {
    const bs = bindState(a.binds, a);
    const base = { id: a.id, doc: a.doc, line: a.line, kind: "anchor" };
    if (journal.snooze.has(a.id)) { add({ ...base, state: "snoozed" }); continue; }
    if (bs.state === "unresolvable") { add({ ...base, state: "unresolvable" }); continue; }
    if (bs.state !== "resolved") {
      add({ ...base, state: bs.state, missing: bs.missing,
            candidates: bs.state === "dead" ? bs.missing.flatMap((m) => candidatesFor(m, factsById)) : undefined });
      continue;
    }
    add({ ...base, state: "clean" });
  }

  findings.sort((x, y) => x.doc.localeCompare(y.doc) || x.line - y.line || x.id.localeCompare(y.id));
  return { findings, documented };
}

// Coverage denominator = CONCRETE surfaces only (owner decision 2026-07-30):
// endpoints, tables, env vars, owned services, CLIENT ROUTES and MESSAGING
// CHANNELS (owner decision 2026-08-01 - all six carry natural keys and
// objective existence, the ADR-012 test). Packages are containers, not
// surfaces; external services (postgres:16) are someone else's architecture.
export function isCoverageSurface(f) {
  const t = f.payload.type;
  if (t === "package" || t === "module" || t === "symbol" || t === "churn") return false;
  // attributes OF a table, not surfaces of their own; policies and views DO count
  if (t === "rls" || t === "pk") return false;
  if (t === "service" && f.payload.attrs.kind === "external") return false;
  return true;
}

const SELF_DRIFT_STATES = new Set(["stale", "tampered", "dead"]);

// Self-caused classification (ADR-012, the post-edit nudge's mechanical basis):
// a drift finding is caused by ref..HEAD when its DOC changed (tampered = doc
// edit) or any bound fact - resolved OR missing - is in the FACT-LEVEL change
// set (hash moved, appeared, or disappeared since the base). Fact granularity
// is the point: a fact merely living in an edited file was not caused by the
// edit. Dead findings attribute precisely too - the missing id existed at the
// base, so it is in the change set. Mutates findings (adds selfCaused: bool).
export function classifySelfCaused({ findings, anchors, regions, factsById, changed, changedFactIds }) {
  const bindsOf = new Map();
  for (const a of anchors) bindsOf.set(`anchor\x00${a.id}\x00${a.doc}\x00${a.line}`, a.binds);
  for (const r of regions) bindsOf.set(`${r.kind}\x00${r.id}\x00${r.doc}\x00${r.line}`, inheritBinds(r, anchors));
  for (const f of findings) {
    if (!SELF_DRIFT_STATES.has(f.state)) continue;
    let self = changed.has(f.doc);
    if (!self) {
      const binds = bindsOf.get(`${f.kind}\x00${f.id}\x00${f.doc}\x00${f.line}`) ?? [];
      const bound = [...resolveBindIds(binds, factsById), ...(f.missing ?? [])];
      self = bound.some((id) => changedFactIds.has(id));
    }
    f.selfCaused = self;
  }
}

export function coverage(factsById, documented) {
  const perCap = {};
  for (const [id, f] of factsById) {
    if (!isCoverageSurface(f)) continue;
    const cap = id.startsWith("ds ") ? "module-graph" : id.slice(5, id.indexOf("/"));
    const c = (perCap[cap] ??= { total: 0, documented: 0 });
    c.total++;
    if (documented.has(id)) c.documented++;
  }
  let total = 0, doc = 0;
  for (const c of Object.values(perCap)) { total += c.total; doc += c.documented; }
  return { perCapability: perCap, total, documented: doc,
           pct: total ? Math.round((doc / total) * 100) : null };
}
