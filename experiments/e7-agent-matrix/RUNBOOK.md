# E7 — cross-agent skill smoke matrix

**Status: runnable since 2026-08-03, not yet run.** This is the last thing
between `main` and a `0.2.0` cut, and the only outstanding experiment that has
to happen on a human's own machine.

## Why this cannot be run from a cloud session

E7 does not test keeldocs. Every part of keeldocs it touches is already gated by
151 unit tests and 80 harness checks that run on three operating systems on
every push. E7 tests **the agents** — whether Claude Code, Codex and Cursor
actually discover a skill from its directory and invoke it *without being told
to*. That needs the real agent binaries, signed into real accounts, on a machine
where they are installed. A cloud sandbox can install the files; it cannot be
the thing that decides to read them.

This is R7's assumption in the risk register, and it is a bet, not a fact: the
Agent Skills standard demonstrably *exists*, but that all three implementations
behave uniformly is exactly what has never been checked. The whole
agent-native distribution strategy sits on it.

## What you need

- `keeldocs` on npm — done: `npx keeldocs` resolves `0.2.0-rc.4`.
- A clone of this repo (the two scripts below live here).
- Node ≥ 20, Python 3, and `pip install -r providers/requirements.txt`.
- At least two of: Claude Code, Codex, Cursor. Two passing is the bar for
  cutting `0.2.0`; three is the register's stated matrix.

## Step 1 — build a repo whose committed docs are lying

```
python3 experiments/e7-agent-matrix/prep-fixture.py ~/e7-run
```

It copies `fixtures/express-mounts`, commits it, runs `keeldocs init --yes` so
the docs are anchored and **CLEAN**, commits that, and only then moves the code:
`/api/orders` becomes `/api/purchase-orders` and the whole `/api/v1` surface is
deleted. The drift is committed, so nothing depends on an agent inspecting your
working tree.

The order is the point. The docs must have been *true and committed* before the
code moved, because E7 is not asking whether an agent can read a diff — it is
asking whether an agent notices, unprompted, that a document in front of it has
become false. The script refuses to continue if the baseline is not CLEAN or if
seeding produces no drift, so a vacuous pass is not available.

## Step 2 — install one agent's skills

```
python3 experiments/e7-agent-matrix/install-skills.py claude-code ~/e7-run
python3 experiments/e7-agent-matrix/install-skills.py codex       ~/e7-run
python3 experiments/e7-agent-matrix/install-skills.py cursor      ~/e7-run
```

Everything the installer does is read from `adapters/<agent>/manifest.yaml` —
the install path, which frontmatter fields that agent chokes on, whether it also
needs the `AGENTS.md` fallback block. Nothing is hardcoded, deliberately: if the
manifest and the installer could disagree, E7 would be testing the installer
instead of the adapter contract. It also fails loudly if the skills listing
exceeds Codex's 8,000-character cap.

Installing all three into one repo is fine — they use different directories.

## Step 3 — the two tests, per agent

**Test A — auto-invoke (the actual bet).** Open the agent in `~/e7-run` and ask
something a user would ask, that never names the tool:

> Is my API documentation still accurate?

PASS if the agent invokes the keeldocs skill on its own and reports the drift
with the engine's receipts. FAIL if it hand-reads the markdown and answers from
its own impression of the code — that is the failure mode that matters, because
it is indistinguishable from success until it is wrong. Record which one
happened, verbatim.

**Test B — headless drift detection.** Run the agent in whatever
non-interactive mode it offers, in the same repo, with the same question. PASS
if it exits reporting the drift. This is the mode CI and hooks use, and it is
the one most likely to differ from the interactive path.

Sanity check, if a run looks strange — the engine's own answer is:

```
cd ~/e7-run && npx keeldocs check --json
```

That must say `DRIFT_FOUND`. If it does and the agent said "looks fine", the
agent failed; the tool did not.

## Pass criteria

| | Threshold | Source |
|---|---|---|
| Per agent | Test A **and** Test B green | R7 |
| To cut `0.2.0` | ≥ 2 of 3 agents green | ROADMAP §3 |
| Full matrix | all 3 green, re-run weekly | R7 |

R7 also asks for one deliberate breaking-change drill fixed within a week. That
is a later exercise against a real upstream change, not part of this first run —
do not let it block the `0.2.0` decision.

## Step 4 — write it down

Fill in `RESULTS.md` beside this file: per agent, both tests, the verbatim first
response to Test A, and the agent version. Then update the E7 row in
`docs/design/08-risks-experiments.md` and the ledger in `ROADMAP.md §7`.

**Record failures in full.** A "no" here is more valuable than a "yes" — it
falsifies the distribution bet while there is still time to change the strategy,
which is the entire reason the experiment is ordered before the launch rather
than after it.
