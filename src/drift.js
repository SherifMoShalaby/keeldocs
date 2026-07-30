// Drift comparator (ADR-008 + spec §4-5). States are disjoint:
//   clean | stale | tampered | dead | intentionally_removed | unresolvable | snoozed
// Extraction failure is unresolvable (tooling health), NEVER drift - fail closed.
// Re-anchoring here is proposal-grade only: candidates are suggested for dead
// bindings; auto-rebind needs the two-signal rule and belongs to sync (ADR-007).

import { factHash, contentHash, hashesMatch, display } from "./hash.js";
import { inheritBinds } from "./anchors.js";

function resolveBind(bind, factsById) {
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

// Candidate suggestions for a missing bind - report-only, max 3, deterministic order.
export function candidatesFor(missingId, factsById) {
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

function capabilityOf(bindRaw) {
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
      if (!b.wildcard && r.ids.length === 0) missing.push(b.raw);
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
    if (cmp === "version-mismatch") { add({ ...base, state: "rebaseline" }); continue; }
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
      if (cmp === "version-mismatch") { add({ ...base, state: "rebaseline" }); continue; }
      if (!cmp) {
        if (rejectedAt && rejectedAt === display(cur)) { add({ ...base, state: "held", detail: "restore proposal rejected; human edit stands" }); continue; }
        add({ ...base, state: "tampered", detail: "gen region content edited by hand" }); continue;
      }
    }
    if (region.hash !== undefined) {
      const cur = aggregateHash(bs.ids, factsById);
      const cmp = hashesMatch(region.hash, cur);
      if (cmp === "version-mismatch") { add({ ...base, state: "rebaseline" }); continue; }
      if (!cmp) {
        if (rejectedAt && rejectedAt === display(cur)) { add({ ...base, state: "held", detail: "regenerate proposal rejected for this fact state" }); continue; }
        add({ ...base, state: "stale", currentHash: cur.slice(0, 19), recorded: region.hash }); continue;
      }
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

export function coverage(factsById, documented) {
  const perCap = {};
  for (const id of factsById.keys()) {
    const cap = id.slice(5, id.indexOf("/"));
    const c = (perCap[cap] ??= { total: 0, documented: 0 });
    c.total++;
    if (documented.has(id)) c.documented++;
  }
  let total = 0, doc = 0;
  for (const c of Object.values(perCap)) { total += c.total; doc += c.documented; }
  return { perCapability: perCap, total, documented: doc,
           pct: total ? Math.round((doc / total) * 100) : null };
}
