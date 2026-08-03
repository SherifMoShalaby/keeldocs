# E7 — cross-agent skill smoke matrix

**Status: run 2026-08-03, passed 2 of 3 — the `0.2.0` gate is cleared.** Results
and the seven defects the first run surfaced: `RESULTS.md`, beside this file.
This procedure is now for the weekly re-run R7 asks for, and for Cursor, which
is still untested.

**Read `RESULTS.md` before re-running.** Three of those defects produce a
*confidently wrong* verdict rather than an obviously broken one — two make a
correctly-behaving agent look like a failure, and one let the fixture hand an
agent the answer with the engine's own receipts attached. The prerequisites and
the pass-judging method below were rewritten because of them; the earlier
versions were not sufficient to get a trustworthy result.

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

- `keeldocs` on npm — done: `npx keeldocs` resolves `0.2.0-rc.4`. (Run that from
  anywhere *except* a clone of this repo: inside it, npx resolves the local
  package name and finds no linked bin.)
- A clone of this repo (the two scripts below live here).
- Node ≥ 20 and `npm ci` in the clone. `@electric-sql/pglite` is an
  *optional* dependency, so a fresh clone has no `node_modules` and `sql-replay`
  fails; the harness reported 8 failures until it was installed.
- Python 3 **with the pinned extractor runtime importable by the `python3` that
  the agent's shell resolves.** The engine spawns `python3` and has no override
  env var, so this is not optional and not merely the runbook author's
  convenience: with no `tree_sitter`, every provider exits 1 and
  `keeldocs check` returns `TOOL_ERROR` rather than `DRIFT_FOUND` — and you
  would score a correctly-behaving agent as FAIL.

  `pip install -r providers/requirements.txt` is refused by PEP 668 on
  Homebrew/system Python. **A venv on `PATH` is enough for Claude Code and NOT
  enough for Codex**, which runs every command through `/bin/zsh -lc` — a login
  shell that re-sources your profile and rebuilds `PATH`, discarding the venv
  before any provider runs. Install so that a *login shell* can import it:

  ```
  python3 -m pip install --user --break-system-packages -r providers/requirements.txt
  zsh -lc 'python3 -c "import tree_sitter_typescript"'   # must succeed
  ```

  `--user` keeps the Homebrew prefix untouched, which is what Homebrew's own
  PEP 668 message recommends. All eight pins install and import on Python
  3.14.5; CI pins 3.12.

  Get this wrong and Codex answers *"keeldocs hit a tooling error"* — which is
  correct, well-behaved refusal on its part, and looks exactly like a FAIL.
- At least two of: Claude Code, Codex, Cursor, **each signed in**. Installing a
  binary is not enough — Codex without `codex login` cannot run either test,
  though its *discovery* half can be checked without an account (see below).
  Two passing is the bar for cutting `0.2.0`; three is the register's matrix.
- Verify the baseline before trusting anything: `node --test tests/*.test.js`
  (151/151) and `python3 scripts/harness.py` (rc 0). Note the glob — Node 25
  rejects the bare `node --test tests/` form that `CLAUDE.md` still quotes. And
  check the exit code, not a `| tail` pipeline's.

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

### Telling a real pass from a false one

Do not take the agent's word for it. An agent can say "I ran keeldocs" without
having run it, and can run it without saying so, and the drift in this fixture
is easy enough to hand-read that a *correct answer is weak evidence*. Require
three independent signals to agree:

1. **The engine left a trace.** keeldocs writes `.keeldocs/out/check-<sha>.json`
   on every run. `rm -rf ~/e7-run/.keeldocs/out` immediately before each test;
   if it reappears, the engine executed. This needs no instrumentation and works
   for any agent, which is what makes it the load-bearing signal for Codex and
   Cursor.
2. **A skill-invocation record**, read from the agent's own transcript or event
   log rather than from its prose. For Claude Code that is a `Skill` tool call
   in `~/.claude/projects/<escaped-cwd>/*.jsonl`, or a `tool_use` block under
   `--output-format stream-json`.
3. **Fact hashes in the answer.** `h1:630e607ba8467056 → h1:803e3c5a591ea9ad`
   cannot be derived by reading the repository; only the engine emits them.

A PASS is all three. Right answer with an empty `.keeldocs/out/` is the false
pass, and it is the whole reason this experiment is worth running.

### Codex specifics

Test A and Test B need `codex login`, but the *discovery* half does not.
`codex debug prompt-input` renders the model-visible prompt as JSON and needs no
account: run it in a repo with the skills installed and confirm all six appear
by name. That separates "the agent never saw the skill" from "the agent saw it
and chose not to use it" — different failures with different fixes, and only the
first is an adapter change.

Headless form, with stdin closed — given a prompt argument *and* a piped stdin,
`codex exec` blocks forever waiting for a `<stdin>` block:

```
cd ~/e7-run && codex exec "Is my API documentation still accurate?" \
  -s workspace-write --json < /dev/null
```

Run Codex **twice**: once as shipped, once with `AGENTS.md` deleted. The Codex
adapter installs that fallback block, and the block itself says
`run keeldocs check --json` — so an as-shipped pass cannot distinguish the skill
from the fallback. Only the second run shows whether skill discovery alone
carries it.

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
