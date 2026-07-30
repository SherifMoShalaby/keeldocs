---
name: keeldocs-new
description: Generate a new document from a keeldocs recipe - ERD, endpoint inventory, or capture an ADR - and write validated prose into doc slots. Use when the user asks for a data-model diagram, API inventory, wants to record a decision, or asks you to write/refresh doc prose.
disable-model-invocation: true
---
# keeldocs new + slot-write

- `keeldocs new erd | endpoint-inventory --json` renders from current facts, born clean; existing files are never overwritten (EXISTS -> use sync instead). `system-map`/`config-reference` return NOT_AVAILABLE until their providers land - never hand-fabricate them.
- `keeldocs new adr --title "..."` scaffolds a numbered ADR. The Context/Decision/Consequences prose is the USER's - interview them briefly and use their words; never infer rationale from code.
- Doc prose goes ONLY through `echo "<prose>" | keeldocs slot-write <doc> <slot-id> --json`. If rejected, the envelope names the gate (unresolved-citations, numbers-in-prose, word-cap, prose-stability...); fix the prose and resubmit - never edit the doc file directly, never work around a gate.
- Cite real entities in backticks (`GET /items`, `Item`, `Status`) - that is what the citation gate verifies. Keep numbers out of prose; they belong in generated tables.
- After a human confirms a draft reads true: `keeldocs approve <doc> <slot-id> --by <name>`.
