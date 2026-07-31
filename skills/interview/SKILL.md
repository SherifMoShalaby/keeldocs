---
name: keeldocs-interview
description: Capture human rationale about a keeldocs-managed repo through short question batches. Use when the user wants to answer open documentation questions, confirm whether removed code was intentional, or decide what to document next.
disable-model-invocation: true
---
# keeldocs interview

The engine generates ALL cards deterministically from repo state - you only
relay questions and record verdicts. Never invent, rephrase into new claims,
or answer on the user's behalf.

1. `keeldocs interview --json` - up to 5 cards per batch (`data.cards`), with
   `data.progress` (answered/open/total). Two kinds:
   - `removal`: a doc-bound fact no longer exists in code ("was this
     intentional?"). confirm records a tombstone; check then reports
     `intentionally_removed` instead of drift.
   - `document`: an undocumented hot surface ("document this next?").
2. Present each card with your native structured-question UI: the question,
   its `evidence` lines verbatim, and the four options from `verdicts`
   (confirm / correct / reject / unknown).
3. Record each verdict immediately:
   `keeldocs answer <qid> <verdict> [--text "..."] [--by <name>]`
   - `correct` REQUIRES --text (the correction is the answer)
   - `reject` is final: journaled, never re-asked
   - `unknown` skips; the card returns in a later batch
4. When the batch is settled, run `keeldocs interview --json` again; repeat
   until `NOTHING_TO_ASK` or the user stops. Commit
   `.keeldocs/interview/` and `.keeldocs/decisions.jsonl` with the session -
   progress resumes purely from those files, and teammates can read
   `queue.yaml` without running anything.

Answering is disabled in CI by design; decisions are made by humans, locally.
After a confirmed removal, `keeldocs check` shows the drift resolved. For
confirmed document-next cards, draft via `keeldocs new` / slot-write - the
interview only records the decision.
