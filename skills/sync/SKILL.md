---
name: keeldocs-sync
description: Propose and apply section-level documentation patches for drift found by keeldocs. Use when the user wants stale docs fixed, accepts a post-edit nudge, or asks to sync docs after code changes.
disable-model-invocation: true
---
# keeldocs sync

Run `keeldocs sync --json` and walk the per-section proposals with the y/n/e/s/w grammar (accept / reject / edit / snooze / why - `w` prints the evidence chain). Sections with human edits are proposal-only: show the diff, never auto-apply. Rejections and snoozes are recorded in the decisions journal and will not be re-proposed. If prose slots need rewriting, generate the prose and submit it via `keeldocs slot-write` - never edit the doc file directly.
