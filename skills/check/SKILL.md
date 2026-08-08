---
name: keeldocs-check
description: Report documentation drift, verification results, and coverage for a keeldocs-managed repo. Use when the user asks whether docs are stale/current/accurate, after large refactors or merges, before a release, or when CI reports doc drift.
---
# keeldocs check

Run `keeldocs check --json` — or `npx keeldocs check --json` if `keeldocs` is not on `PATH`, which is the normal case after the documented `npx keeldocs init` install. A `command not found` is an invocation problem; it is never a reason to answer from your own reading of the code. (Deterministic: no LLM, no network, no live DB.) Envelope `code` drives the response: CLEAN -> say so, one line. DRIFT_FOUND -> summarize top findings with receipts, offer `keeldocs sync`. UNREADABLE -> the engine declined to look at part of the repo and so has NO drift verdict for this run; never report it as clean and never report it as drift. Name what the envelope names (`data.refused`, `data.unverified`, `data.unscanned`, `data.journalMalformed` each carry document and line) and say those have to be fixed before any drift count means anything. TOOL_ERROR / CONFIG -> the run did not happen; see the core skill. UNRESOLVABLE entries are tooling health, not drift - report separately.

`data.skipped` and `data.excludedDocs` are disclosures, not findings: a directory the engine will not walk on its own, and an anchored document the user's own `[providers] exclude-paths` suppressed. They never move the exit code, and a CLEAN check that carries them is still clean - but say they are there, because a blind spot nobody mentions is indistinguishable from an empty one. Never re-derive drift yourself by reading docs; the engine's fact-hash comparison is the truth.

`data.upgrades` is NOT drift and never moves the exit code: a generated doc predates a section the current recipe renders. Mention it once, offer `keeldocs sync --upgrade`, and never read a CLEAN check that carries upgrades as a failure.
