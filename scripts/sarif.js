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

const LEVELS = { stale: "warning", dead: "warning", tampered: "error", unresolvable: "note" };

const RULES = [
  { id: "keeldocs/stale", desc: "Documented facts changed: the bound fact-hash no longer matches the recorded one." },
  { id: "keeldocs/dead", desc: "Doc section is bound to a fact that no longer exists (no tombstone recorded)." },
  { id: "keeldocs/tampered", desc: "Machine-generated region was edited by hand; regenerate or approve via sync." },
  { id: "keeldocs/unresolvable", desc: "Extractor failed - tooling health, never treated as drift (fail closed)." },
];

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
