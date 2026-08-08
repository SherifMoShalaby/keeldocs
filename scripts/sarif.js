#!/usr/bin/env node
// keeldocs check report -> SARIF 2.1.0 (for GitHub code scanning).
// Zero-dep, deterministic: results sorted as the report already sorts findings.
// Usage: node scripts/sarif.js <path-to-full-check-report.json> [> out.sarif]
//
// Mapping: drift states become results anchored to the doc file + line where
// the anchor/region lives - the doc is where a human fixes drift, so that is
// where the annotation belongs. Tooling health (unresolvable) surfaces as
// "note": it is not drift and must not gate anyone (fail-closed happens via
// the CLI exit code, not via findings).

import { readFileSync } from "node:fs";
import { CHANNELS, ledgerOf } from "../src/disclosure.js";

const LEVELS = { stale: "warning", dead: "warning", tampered: "error", unresolvable: "note" };

const RULES = [
  { id: "keeldocs/stale", desc: "Documented facts changed: the bound fact-hash no longer matches the recorded one." },
  { id: "keeldocs/dead", desc: "Doc section is bound to a fact that no longer exists (no tombstone recorded)." },
  { id: "keeldocs/tampered", desc: "Machine-generated region was edited by hand; regenerate or approve via sync." },
  { id: "keeldocs/unresolvable", desc: "Extractor failed - tooling health, never treated as drift (fail closed)." },
  // Every disclosure channel gets a rule, generated from the ledger rather than
  // typed out here. This emitter used to know four states and nothing else: a
  // grep for `refused`, `unscanned`, `journalMalformed`, `skipped`,
  // `excludedDocs` and `extractionGaps` in this file returned zero for all six.
  // Measured on a purpose-built repository, `check` exited 1 UNREADABLE naming a
  // section it could not verify while this file exited 0 emitting ZERO results -
  // so GitHub code scanning displayed "no problems found" for a run that failed.
  // A Security tab that is clean when the run was not is the project's own
  // defect wearing someone else's UI, and it was written DURING the campaign
  // that fixed twelve instances of it. Joining the ledger is what stops the next
  // channel needing anyone to remember this file exists.
  ...CHANNELS.map((c) => ({ id: `keeldocs/${c.channel}`, desc: `${c.what} - ${c.why}.` })),
];

// A disposition points at a place: the document, the file an extractor gave up
// on, the directory nobody walked, or the one file a channel names for itself
// (`at`). Deriving it beats a per-channel mapping that the next channel would
// not be added to.
function locate(entry, item) {
  const uri = typeof item === "string" ? item : (item.doc ?? item.file ?? entry.at);
  if (!uri) return [];
  return [{ physicalLocation: {
    artifactLocation: { uri, uriBaseId: "SRCROOT" },
    region: { startLine: item.line || 1 },
  } }];
}

export function toSarif(report) {
  const results = [];
  for (const f of report.findings ?? []) {
    const level = LEVELS[f.state];
    if (!level) continue; // clean/snoozed/held/intentionally_removed are not annotations
    const bits = [`${f.kind} \`${f.id}\` is ${f.state}`];
    if (f.missing?.length) bits.push(`missing: ${f.missing.join(", ")}`);
    if (f.candidates?.length) bits.push(`did you mean: ${f.candidates.join(", ")}`);
    if (f.detail) bits.push(f.detail);
    results.push({
      ruleId: `keeldocs/${f.state}`,
      level,
      message: { text: bits.join(" - ").slice(0, 1000) },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: f.doc, uriBaseId: "SRCROOT" },
        region: { startLine: f.line || 1 },
      } }],
    });
  }
  // The disclosures, in ledger order, after the findings. A `verdict` channel
  // means the run has no drift verdict at all, so it is a warning; a `named` one
  // is a blind spot the user chose or a standing rule about dependency trees, so
  // it is a note and gates nobody - the same split the exit code makes, read off
  // the same enumeration rather than restated here.
  for (const entry of ledgerOf(report)) {
    for (const item of entry.items) {
      const detail = typeof item === "string" ? "" : (item.reason ?? item.kind ?? item.id ?? "");
      results.push({
        ruleId: `keeldocs/${entry.channel}`,
        level: entry.disclosure === "verdict" ? "warning" : "note",
        message: { text: [entry.what, detail, entry.why].filter(Boolean).join(" - ").slice(0, 1000) },
        locations: locate(entry, item),
      });
    }
  }
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "keeldocs",
        informationUri: "https://github.com/SherifMoShalaby/keeldocs",
        version: (report.meta?.engine ?? "keeldocs@0").split("@")[1],
        rules: RULES.map((r) => ({ id: r.id, shortDescription: { text: r.desc } })),
      } },
      originalUriBaseIds: { SRCROOT: { uri: "file:///" } },
      results,
    }],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  process.stdout.write(JSON.stringify(toSarif(report), null, 1) + "\n");
}
