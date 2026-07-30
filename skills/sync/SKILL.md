---
name: keeldocs-sync
description: Propose and apply section-level documentation patches for drift found by keeldocs. Use when the user wants stale docs fixed, accepts a post-edit nudge, or asks to sync docs after code changes.
disable-model-invocation: true
---
# keeldocs sync

1. `keeldocs sync --json` previews proposals (kinds: regenerate, restore, rebind, tombstone, unrenderable), each with evidence. Nothing is written.
2. Walk the user through them; apply decisions via the CLI, never by editing docs directly:
   - `keeldocs sync --apply <id>` (rebind honors `--to <fact-id>` to pick a different candidate)
   - `keeldocs sync --apply-all` for the regenerate/restore set
   - `keeldocs sync --reject <id>` - records a rejection; an identical proposal is never re-made (the user's hand edit stands; check reports it as held, not drift)
   - `keeldocs sync --snooze <id> [--days N]`
3. `restore` proposals DISCARD a human's hand edit inside a gen region - always show the diff and get explicit consent, or reject to keep it.
4. After applying, run `keeldocs check` to confirm the loop closed clean. Journal writes are disabled in CI by design; decisions happen locally.
