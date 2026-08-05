// slot-write + approve: the LLM boundary made mechanical (ADR-009).
// The model NEVER edits doc files. Prose enters exactly here, through gates a
// weak local model cannot talk its way past; the TOOL applies the draft label
// and records the fact state the prose was written against. approve converts
// the label to a human attestation - provenance changes, it never becomes
// machine-"verified", because approval is attestation, not derivation.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDoc, inheritBinds } from "./anchors.js";
import { extractAll } from "./facts.js";
import { loadConfig, extractOpts } from "./config.js";
import { resolveBindIds, aggregateHash } from "./drift.js";
import { display, hashesMatch } from "./hash.js";
import { patchSlot } from "./patch.js";
import { redact } from "./redact.js";

export const DRAFT_LABEL = "> ⚠ Inferred draft - not human-reviewed.";

function ciGuard(action) {
  if (process.env.CI === "true" || process.env.CI === "1") {
    throw new Error(`${action} is disabled in CI - prose and approvals happen locally, under review`);
  }
}

function knownEntities(factsById) {
  const known = new Set();
  for (const f of factsById.values()) {
    known.add(f.id);
    const a = f.payload.attrs;
    if (f.payload.type === "endpoint") { known.add(a.path); known.add(`${a.method} ${a.path}`); }
    if (f.payload.type === "table") {
      known.add(a.name);
      for (const c of a.columns) { known.add(c.name); known.add(`${a.name}.${c.name}`); known.add(c.type); }
    }
    if (f.payload.type === "enum") { known.add(a.name); for (const v of a.values) known.add(v); }
    if (f.payload.type === "env-var") known.add(a.name);
    if (f.payload.type === "package") { known.add(a.name); known.add(a.path); }
    if (f.payload.type === "symbol") { known.add(a.name); known.add(a.module); }
    if (f.payload.type === "module") known.add(a.path);
    if (f.payload.type === "policy") { known.add(a.name); known.add(`${a.schema}.${a.table}`); known.add(a.table); }
    if (f.payload.type === "rls") { known.add(`${a.schema}.${a.table}`); known.add(a.table); }
    if (f.payload.type === "service") {
      known.add(a.name);
      if (a.image) known.add(a.image);
      for (const d of a.depends_on) known.add(d);
    }
  }
  return known;
}

// ---- the validation gates (every rejection names its gate + the fix) ----
export function validateProse({ prose, slot, factsById }) {
  const errors = [];
  if (!prose.trim()) errors.push("empty: no prose provided on stdin");
  if (/<!--\s*\/?keeldocs/.test(prose)) {
    errors.push("marker-injection: payload contains keeldocs markers - prose may not create or close regions");
  }
  const maxWords = slot.maxWords ?? 150;
  const words = prose.trim().split(/\s+/).filter(Boolean).length;
  if (words > maxWords) errors.push(`word-cap: ${words} words > max-words=${maxWords} - tighten the prose`);

  const cited = [...prose.matchAll(/`([^`\n]{1,120})`/g)].map((m) => m[1]);
  const known = knownEntities(factsById);
  const unresolved = cited.filter((c) => !known.has(c));
  if (unresolved.length) {
    errors.push(`unresolved-citations: [${unresolved.join(", ")}] do not match any extracted fact ` +
      "(endpoints, tables, columns, enums) - hallucinated identifiers are rejected, not softened");
  }
  if (cited.length === 0) {
    errors.push("zero-citations: prose must cite at least one backticked known entity so it stays falsifiable");
  }
  const stripped = prose.replace(/`[^`\n]*`/g, "");
  if (/\d/.test(stripped)) {
    errors.push("numbers-in-prose: digits outside backticks rot silently - counts/dates belong in deterministic regions, not prose");
  }
  return errors;
}

export function runSlotWrite({ root, json, args }) {
  try {
    ciGuard("slot-write");
    const [docRel, slotId] = args.filter((a) => !a.startsWith("--")).slice(1);
    if (!docRel || !slotId) throw new Error("usage: keeldocs slot-write <doc> <slot-id>  (prose on stdin)");
    const docPath = join(root, docRel);
    if (!existsSync(docPath)) throw new Error(`doc not found: ${docRel}`);
    const prose = readFileSync(0, "utf8"); // stdin

    const text = readFileSync(docPath, "utf8");
    const parsed = parseDoc(text, docRel);
    const slot = parsed.regions.find((r) => r.kind === "slot" && r.id === slotId);
    if (!slot) {
      throw new Error(`unknown-slot: no slot ${slotId} in ${docRel} - slots are declared by templates, never invented by the model`);
    }

    const cfg = loadConfig(root);
    if (!cfg.ok) throw new Error(cfg.error);
    const { factsById, toolError } = extractAll(root, extractOpts(cfg.config));
    if (toolError) throw new Error(`tooling error: ${toolError}`);
    const binds = slot.binds?.length ? slot.binds : inheritBinds(slot, parsed.anchors);
    const ids = resolveBindIds(binds, factsById);
    const curHash = ids.length ? aggregateHash(ids, factsById) : null;

    // Prose-stability gate: rewriting prose while the underlying facts are
    // unchanged is diff thrash, not maintenance - rejected by design.
    const existingBody = (slot.body ?? "").trim();
    if (existingBody && slot.hash !== undefined && curHash && hashesMatch(slot.hash, curHash) === true) {
      const env = { v: 1, ok: false, code: "SLOT_REJECTED",
        summary: "prose-stability: this slot already has prose and its bound facts are unchanged - a rewrite would be pure diff churn. If facts changed, run keeldocs check first; to force review, have a human edit it.",
        data: { gate: "prose-stability" }, next: [] };
      process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
      return 1;
    }

    const errors = validateProse({ prose, slot, factsById });
    if (errors.length) {
      const env = { v: 1, ok: false, code: "SLOT_REJECTED",
        summary: `rejected by ${errors.length} gate(s); fix and resubmit`.slice(0, 300),
        data: { gates: errors }, next: ["revise the prose and pipe it to slot-write again"] };
      process.stdout.write(json ? JSON.stringify(env) + "\n" : ["slot-write - SLOT_REJECTED", ...errors.map((e) => "  - " + e)].join("\n") + "\n");
      return 1;
    }

    // The TOOL labels, redacts, and records - never the model (ADR-013).
    const rp = redact(prose.trim());
    const body = `${DRAFT_LABEL}\n\n${rp.clean}`;
    const patched = patchSlot(text, slotId, body, curHash ? display(curHash) : "h1:0000000000000000");
    writeFileSync(docPath, patched);
    const env = { v: 1, ok: true, code: "SLOT_WRITTEN",
      summary: `${rp.redactions.length ? `SECURITY: ${rp.redactions.length} secret(s) redacted; ` : ""}draft written to ${docRel}#${slotId} (labeled, fact-state recorded); a human can attest it with: keeldocs approve ${docRel} ${slotId}`,
      data: { doc: docRel, slot: slotId, words: prose.trim().split(/\s+/).length, ...(rp.redactions.length ? { redactions: rp.redactions } : {}) }, next: [`keeldocs approve ${docRel} ${slotId}`] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 0;
  } catch (err) {
    const env = { v: 1, ok: false, code: "TOOL_ERROR", summary: String(err.message).slice(0, 300), data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }
}

export function runApprove({ root, json, args }) {
  try {
    ciGuard("approve");
    const [docRel, slotId] = args.filter((a) => !a.startsWith("--")).slice(1);
    if (!docRel || !slotId) throw new Error("usage: keeldocs approve <doc> <slot-id> [--by <name>]");
    const byIdx = args.indexOf("--by");
    const actor = byIdx !== -1 ? args[byIdx + 1] : (process.env.KEELDOCS_ACTOR || process.env.USER || "unknown");
    const docPath = join(root, docRel);
    const text = readFileSync(docPath, "utf8");
    if (!text.includes(DRAFT_LABEL)) throw new Error(`no draft label found in ${docRel} - nothing to approve`);
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
    const sha = r.status === 0 ? r.stdout.trim() : "no-git";
    // Attestation, not derivation: the reviewed marker names a human + a SHA.
    const parsed = parseDoc(text, docRel);
    const slot = parsed.regions.find((x) => x.kind === "slot" && x.id === slotId);
    if (!slot || !(slot.body ?? "").includes(DRAFT_LABEL)) throw new Error(`slot ${slotId} has no draft to approve`);
    const newBody = slot.body.replace(DRAFT_LABEL, `> ✎ Reviewed by ${actor}, ${sha}.`).replace(/^\n|\n$/g, "");
    const patched = patchSlot(text, slotId, newBody, slot.hash ?? "h1:0000000000000000");
    writeFileSync(docPath, patched);
    const env = { v: 1, ok: true, code: "APPROVED",
      summary: `${docRel}#${slotId} attested by ${actor} at ${sha}`, data: { doc: docRel, slot: slotId, by: actor, sha }, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 0;
  } catch (err) {
    const env = { v: 1, ok: false, code: "TOOL_ERROR", summary: String(err.message).slice(0, 300), data: {}, next: [] };
    process.stdout.write(json ? JSON.stringify(env) + "\n" : env.summary + "\n");
    return 2;
  }
}
