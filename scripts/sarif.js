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
//
// Everything the engine DECLINED to look at reaches here too, one result per
// disclosed unit, off `disclosuresOf` - see src/disclosure.js. It did not use
// to, and this file is the reason that abstraction has a consumer half at all:
// measured end to end on a purpose-built repository, `check` exited 1 UNREADABLE
// naming one unverifiable section while this emitter exited 0 having written
// ZERO results, so GitHub code scanning displayed "no problems found" for a run
// that failed. The Security tab is a report consumer like any other, and a
// consumer that accounts for four of twelve states is the same defect the whole
// 0.4.x line was spent on, wearing someone else's UI.
//
// Not emitted: `partialFingerprints`. GitHub's SARIF table lists it as required
// and `upload-sarif` computes one when it is absent; the fingerprints this file
// could compute would be line-based, which is precisely the input that moves
// when nothing has changed. Deferring to the uploader is the honest option, and
// it is stated here because "we left out a required property" should not have to
// be rediscovered.

import { readFileSync } from "node:fs";
import { CHANNELS, disclosuresOf } from "../src/disclosure.js";

const LEVELS = { stale: "warning", dead: "warning", tampered: "error", unresolvable: "note" };

// Levels for the disclosures. These are NOT drift and the file must not let
// them read as drift, so the reasoning is here rather than in a commit message.
//
//   verdict -> warning. The run produced no drift verdict at all, which is worse
//     than a drift finding and must not be quiet. It is deliberately not `error`
//     twice over: `error` here means a defect proved to be in the tree - the one
//     that holds it is `tampered`, where a human edited generated content - and
//     a disclosure is the ABSENCE of a verdict, not the presence of drift.
//     Raising it would also make code scanning gate a merge on it, and the gate
//     that fires where the tool cannot see is the one people switch off; the
//     failing is already carried, fail-closed, by `check` exiting 1 UNREADABLE.
//   named   -> note. The engine did not look because the user's own config said
//     not to, or because of a standing rule about dependency trees. It gates
//     nobody by design and moves no exit code. What it must never be is absent.
//
// The two must never blur into the drift states, and level alone cannot carry
// that: `stale` is a warning too. What separates them is that every disclosure
// gets its own `ruleId` and its own rule description, and its message opens with
// what the engine did rather than with what the docs did - "section the engine
// cannot verify", never "is stale". A reader who sees only the annotation still
// learns that nothing was compared.
const DISCLOSURE_LEVELS = { verdict: "warning", named: "note" };

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

function at(uri, line) {
  return [{ physicalLocation: {
    artifactLocation: { uri, uriBaseId: "SRCROOT" },
    region: { startLine: line || 1 },
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
      locations: at(f.doc, f.line),
    });
  }
  // The disclosures, in ledger order, after the findings, one result per unit.
  // This file no longer decides what a channel amounts to - it used to, and it
  // lost two channels doing it: a count-only channel produced no result because
  // there was nothing to iterate, and an item that named no path produced a
  // result with an empty `locations`, which GitHub documents as not displayed.
  // `disclosuresOf` answers both questions once, for every consumer, and a unit
  // always has a place - so there is nothing left here for a new channel to be
  // forgotten by.
  for (const u of disclosuresOf(report)) {
    results.push({
      ruleId: `keeldocs/${u.channel}`,
      level: DISCLOSURE_LEVELS[u.disclosure],
      message: { text: [u.what, u.detail, u.why].filter(Boolean).join(" - ").slice(0, 1000) },
      locations: at(u.path, u.line),
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
