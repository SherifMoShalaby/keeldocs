---
name: keeldocs-new
description: Generate a new document from a keeldocs recipe - ERD, system map, endpoint inventory, config reference, or capture an ADR. Use when the user asks for a data-model diagram, architecture map, API inventory, env-var reference, or wants to record a decision.
disable-model-invocation: true
---
# keeldocs new

Run `keeldocs new <type> --json` (types: erd, system-map, endpoint-inventory, config-reference, adr). Deterministic slots render from facts; fill any llm-prose slots via `keeldocs slot-write` only. For `new adr`, interview the user briefly (their words become the rationale - attribute it; never invent rationale from code).
