# E4 Wow-Test Protocol: undrift init doc lie-detector (10 users)

## Purpose
Measure whether `undrift init` produces a "wow" on real brownfield repos: starter docs
worth committing, plus lie-detector findings a dev verifies as TRUE in under a minute.
This protocol operationalizes the gates the prototype (this folder) cannot test alone.

## Gates
- G1 COMMIT: >= 60% of participants (>=6/10) commit the generated starter docs
  (or open a PR) during or within 48h of the session.
- G2 TRUTH: >= 8/10 participants verify at least one lie-detector finding as TRUE
  on their own repo in < 1 minute (from finding shown to participant saying
  "yes, that's real"). If the run yields zero findings on their repo, that
  participant counts toward G2's denominator only if a seeded-drift fallback repo
  is used (record separately; do not silently mix populations).
- G3 TIME-TO-WOW: p50 < 5 minutes from `undrift init` invocation to the
  participant's first unprompted positive reaction (see "wow event" definition).
- Precision side-gate (from E4): every finding shown must be receipt-backed;
  any finding the participant proves FALSE is logged as a precision failure
  (target: >= 95% true across all findings shown in all 10 sessions).

## Recruiting (n=10)
- Profile: professional devs maintaining a brownfield repo >= 6 months old,
  >= 3 contributors OR >= 300 commits, with an existing README (the drift
  population). Node/JS-first for this iteration (detector coverage), mixed
  seniority, max 2 per company.
- Source: dev communities, X/Mastodon, warm network; screen via 3-question form
  (repo age, commit count, README exists, willing to screen-share a private repo
  or pick a public one they maintain).
- Incentive: $50-75 gift card, 45-minute slot.
- Exclusions: repos we tuned the detector on; greenfield/toy repos; docs-less repos.

## Session script (45 min, recorded with consent)
1. (5 min) Setup: participant shares screen, clones THEIR repo fresh, confirms
   `git log` depth and README present. Facilitator does not touch the keyboard.
2. (2 min) Baseline questions (before tool):
   - B1: "When did you last read your README top to bottom?"
   - B2: "Do you trust your README's setup instructions? (1-5)"
   - B3: "Estimate how many claims in your README are stale." (number)
3. (T0, start timer) Participant runs `undrift init` on their repo. Facilitator
   logs timestamps for: first output, starter docs generated, first finding shown.
4. (10 min) Unscripted exploration. Facilitator stays silent except "keep thinking
   aloud". Log the WOW EVENT: first unprompted positive utterance tied to output
   ("oh wow", "ha, that's true", "I forgot about that", laughter at a finding).
   Record timestamp (T_wow - T0). If none by minute 10, mark "no wow".
5. (5 min) Verification task (G2): facilitator picks the top finding (highest-
   confidence class first: env var > npm script > file > link > route). Prompt:
   "Is this true about your repo? Prove it however you like." Start 60s timer.
   Record: verified-true / proved-false / inconclusive, and time taken. Repeat for
   up to 3 findings if time allows (each contributes to the precision side-gate).
6. (5 min) Commit decision (G1): "Would you commit these starter docs? If yes,
   do it now (branch is fine)." Record: committed now / will PR later / no.
   Follow up at 48h for "later" cases; only actual commits/PRs count.
7. (8 min) Debrief questions:
   - D1: "Which finding was most valuable? Why?" (verbatim quote — demo material)
   - D2: "Was any finding wrong or unfair?" (false-positive log, verbatim)
   - D3: "What would make you run this weekly?" 
   - D4: NPS-style: "0-10, how likely to recommend to a teammate?"
   - D5: "Would you pay? At what price shape (one-off / per-repo / per-seat)?"
8. (Facilitator, post-session) Re-verify every finding shown, offline, against the
   participant's repo state at session time. Any finding that fails offline
   re-verification counts against precision even if the participant accepted it.

## Instrumentation
- Tool logs (with consent): repo size, commit count, claims checked per class,
  findings per class, suppressions fired, runtime.
- Session sheet per participant: T0, T_wow, G1/G2 outcomes, 60s-verification times,
  per-finding true/false verdicts, verbatim quotes.
- All timings from the screen recording, not memory.

## Analysis
- G1: count committed / 10. G2: count verified-true-in-<60s / 10.
- G3: p50 of (T_wow - T0) across sessions with a wow; report no-wow rate separately.
- Precision: true findings / all findings shown, pooled and per class.
- Secondary: B3 (estimated stale claims) vs actual findings — the gap is the
  marketing number ("devs think 2 things are stale; undrift proves N with receipts").
- Failure honesty: report no-wow sessions, false positives verbatim, and any
  participant who declined to commit, with reasons.

## Risks / notes from E4 prototype
- Well-maintained repos can yield ZERO findings (1 of 3 in E4). Zero-finding
  sessions still measure G1 (starter docs value) but starve G2/G3; the screen
  for old, multi-contributor repos is load-bearing.
- Env-var class (C) produced both E4 lies; lead the demo with it.
- Expect FP pressure from: tutorial/recipe sections, npm package names, runtime
  URLs, placeholders, dynamic env construction. The E4 suppression catalog
  (results.json) must ship in the wow-test build.
