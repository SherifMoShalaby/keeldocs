// Proposal builder (sync). Maps drift findings to concrete, appliable proposals.
// Kinds:
//   regenerate  - stale gen region the engine can re-render from current facts
//   restore     - tampered gen region, re-rendered content (human diff shows the loss)
//   rebind      - dead binding with candidates; NEVER auto-applied (ADR-007:
//                 fact-key rebinding lacks the two-signal evidence - human chooses)
//   tombstone   - dead binding with no candidates; records intentionally-removed
//   unrenderable- stale/tampered region with no registered renderer (hand-authored
//                 gen id) - listed with evidence, not appliable in v0.1
// Every proposal carries evidence ("w" in the y/n/e/s/w grammar).

import { renderRegionBody } from "./render.js";
import { resolveBindIds, aggregateHash } from "./drift.js";
import { contentHash, display } from "./hash.js";
import { inheritBinds } from "./anchors.js";

export function buildProposals({ findings, regions, anchors, factsById }) {
  const regionById = new Map(regions.map((r) => [r.id, r]));
  const proposals = [];

  for (const f of findings) {
    // Stale prose slot: the engine NEVER rewrites prose - the agent re-proses
    // via slot-write. Listed with evidence, deliberately not appliable here.
    if (f.state === "stale" && f.kind === "slot") {
      proposals.push({ id: f.id, kind: "reprose", doc: f.doc, line: f.line,
        evidence: `bound facts changed since this prose was written (recorded ${f.recorded}, current ${f.currentHash}); rewrite it via: keeldocs slot-write ${f.doc} ${f.id}` });
      continue;
    }
    if (f.state === "stale" || f.state === "tampered") {
      const region = regionById.get(f.id);
      if (!region) continue;
      if (region.kind !== "gen") continue;
      const binds = region.binds?.length ? region.binds : inheritBinds(region, anchors);
      const ids = resolveBindIds(binds, factsById);
      const newBody = renderRegionBody(f.id, ids, factsById);
      if (newBody === null) {
        proposals.push({ id: f.id, kind: "unrenderable", doc: f.doc, line: f.line,
          evidence: `${f.state} but no registered renderer for this region id - edit by hand, then re-run init-style generation or update the recorded hashes deliberately` });
        continue;
      }
      proposals.push({
        id: f.id, kind: f.state === "tampered" ? "restore" : "regenerate",
        doc: f.doc, line: f.line,
        newBody,
        newHash: display(aggregateHash(ids, factsById)),
        newContent: display(contentHash(newBody)),
        evidence: f.state === "tampered"
          ? `content hash mismatch: gen region was edited by hand (recorded ${region.content}); restoring regenerates from current facts and discards the hand edit - reject to keep it`
          : `bound facts changed: recorded ${region.hash}, current ${display(aggregateHash(ids, factsById))}`,
      });
      continue;
    }
    if (f.state === "dead") {
      if (f.candidates?.length) {
        proposals.push({ id: f.id, kind: "rebind", doc: f.doc, line: f.line,
          missing: f.missing, candidate: f.candidates[0], allCandidates: f.candidates,
          evidence: `binding(s) ${f.missing.join(", ")} no longer resolve; nearest surviving fact(s): ${f.candidates.join(", ")}` });
      } else {
        proposals.push({ id: f.id, kind: "tombstone", doc: f.doc, line: f.line,
          missing: f.missing,
          evidence: `binding(s) ${f.missing.join(", ")} no longer resolve and nothing similar exists; tombstoning records the removal as intentional and stops re-prompting` });
      }
    }
  }

  proposals.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line || a.id.localeCompare(b.id));
  return proposals;
}
