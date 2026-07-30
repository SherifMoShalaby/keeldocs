---
name: keeldocs-check
description: Report documentation drift, verification results, and coverage for a keeldocs-managed repo. Use when the user asks whether docs are stale/current/accurate, after large refactors or merges, before a release, or when CI reports doc drift.
---
# keeldocs check

Run `keeldocs check --json` (deterministic: no LLM, no network, no live DB). Envelope `code` drives the response: CLEAN -> say so, one line. DRIFT_FOUND -> summarize top findings with receipts, offer `keeldocs sync`. UNRESOLVABLE entries are tooling health, not drift - report separately. Never re-derive drift yourself by reading docs; the engine's fact-hash comparison is the truth.
