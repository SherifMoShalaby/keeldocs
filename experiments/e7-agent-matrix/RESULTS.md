# E7 — cross-agent skill smoke matrix: results

**Run 2026-08-03. 2 of 3 green — the `0.2.0` gate is cleared.** Claude Code and
Codex each passed Test A and Test B, on two independent implementations of the
Agent Skills standard, in six runs total. Every one of those runs invoked the
skill as its **first** action. Cursor was not tested: it is absent from this
host and has no trustworthy unattended install path.

Seven defects were found on the way and are recorded below. **Three of them
would have produced a confidently wrong verdict** rather than no verdict, which
is the outcome this experiment exists to avoid: two would have scored a
correctly-behaving agent as FAIL, and one would have let an agent produce a
flawless answer carrying the engine's own receipts while never invoking the
engine. The gate is cleared on evidence that survived all three.

- Date run: 2026-08-03
- keeldocs version: `0.2.0-rc.4` (npm, published artifact — not the working tree)
- Host: macOS (Darwin 25.5.0), Node v25.1.0, Python 3.14.5 (Homebrew)
- Fixture: `prep-fixture.py` → baseline CLEAN → seeded `DRIFT_FOUND` (1 stale
  doc, `/api/orders` renamed to `/api/purchase-orders`, `/api/v1` deleted)
- Repo baseline before running anything: `node --test tests/*.test.js` 151/151,
  `python3 scripts/harness.py` rc=0 with 0 FAIL

## Matrix

| Agent | Version | Test A: auto-invoke | Test B: headless | Notes |
|---|---|---|---|---|
| Claude Code | 2.1.220 | **PASS** | **PASS** ×2 conditions | invoked `Skill check` as its first action in all three runs |
| Codex | 0.146.0 | **PASS** | **PASS** ×2 conditions | read `.agents/skills/check/SKILL.md` first, ran the engine, reported the drift — with and without the `AGENTS.md` block |
| Cursor | — | **N/A — not installed** | **N/A — not installed** | no binary, no app bundle, no config dir, no npm global, no cask |

Test A is PASS only if the agent invoked the skill **unprompted**. An agent that
answered correctly by reading the markdown itself is a FAIL: it got the right
answer by the wrong mechanism, and the mechanism is what E7 measures.

## How mechanism was established, rather than assumed

Self-report is not evidence here — an agent can say "I ran keeldocs" without
having run it, and can run it without saying so. Three independent signals were
used, and a PASS required all three to agree:

1. **The `Skill` tool call**, read from the `stream-json` event log rather than
   from the prose answer.
2. **`.keeldocs/out/check-<sha>.json` appearing on disk.** The directory was
   deleted immediately before each run, so its reappearance is proof the engine
   executed. This signal needs no instrumentation and works for any agent, which
   matters for Codex and Cursor later.
3. **Fact hashes in the answer.** `h1:630e607ba8467056 → h1:803e3c5a591ea9ad` is
   not derivable by reading the repository; only the engine emits it.

## Test A — verbatim first response, per agent

### Claude Code — PASS

Run in a real interactive TUI under a pseudo-TTY, not `-p`: `claude -p` is the
headless mode and is Test B. The instrument is a *fresh* `claude` process with
no knowledge of E7; the session orchestrating this experiment never answered the
question itself, because it authored the fixture and knows the answer, which
would make its own response worthless as evidence.

Sent verbatim, and the only thing sent: `Is my API documentation still accurate?`

Tool sequence, read from the session transcript rather than from the prose:

```
 1. Skill  check
 2. Bash   ls -R ~/e7-run/.claude/skills/ | head -50
 3. Read   ~/e7-run/.claude/skills/keeldocs-core/SKILL.md
 4. Bash   keeldocs check --json; echo "EXIT: $?"
 5. Bash   cat ~/e7-run/.keeldocs/out/check-8ff08e6d.json
 6. Read   ~/e7-run/docs/reference/endpoints.md
```

`Skill check` is the **first** action, before any file is opened. The engine ran
at call 4. `docs/reference/endpoints.md` is not read until call 6 — after the
answer already existed. All three mechanism signals agree.

```
No — one thing is stale.

**`docs/reference/endpoints.md:7`** — generated endpoint table (`api.inventory.table`), state `stale`. Fact hash moved `630e607b…` → `803e3c5a…`, which lines up with your last commit `8ff08e6 refactor: rename the orders routes, drop the v1 surface`. The table still lists 4 rows including `/api/v1/users/:id`; the engine now sees 3 endpoints.

Everything else is fine: the `api.inventory` anchor is clean, coverage is 3/3 surfaces documented (100%), nothing dead or tampered, no unresolvable entries or extraction gaps.

Fix: `keeldocs sync` — want me to run it?

(Unrelated: your ponytail statusline badge isn't configured. Say the word and I'll add the `statusLine` entry to `~/.claude/settings.json`.)
```

Model in the TUI banner: Opus 5. Verified independently of the run's own report,
from the transcript and the filesystem.

Four caveats, recorded rather than smoothed over.

The trailing paragraph of the answer is unrelated to E7 — it comes from a
`SessionStart` hook in this host's user configuration, which the test agent
inherited. The instrument is this machine's real Claude Code, not a pristine
one. (It is also a request addressed to a user, arriving through experimental
output; it was read as data and not acted on.)

**The first launch was aborted and is disclosed rather than dropped.** Claude
Code's first-run "do you trust this folder" dialog swallowed the typed question
— the Enter keystroke answered the dialog instead. No question was asked and the
detector stayed empty, so nothing was measured; the log is kept at
`/tmp/e7-testA-raw.log.attempt0-trustdialog`. Anyone re-running E7 on a fresh
directory will meet the same dialog, and it is worth knowing that it can silently
consume the prompt rather than fail loudly.

**The child's environment was modified, deliberately, to make the run
observable.** Launched from inside another Claude Code session, the child
inherits markers (`CLAUDE_CODE_CHILD_SESSION` and friends) that put it in nested
mode, where it writes no transcript — and the transcript is signal 2 of the three
required to distinguish a real pass from a false one. Those markers were stripped
and session persistence forced. This changes logging, not skill discovery, and
signals 1 and 3 are independent of it; but the launch was not byte-identical to a
user typing `claude` in a plain terminal, and that is worth naming.

Test A ran with `keeldocs` globally installed, so it matches Test B condition 2;
the cold-machine invocation path is covered by condition 1 only.

### Codex — PASS

Codex CLI 0.146.0, model `gpt-5.6-terra`, `chatgpt` auth, real interactive TUI
under a pseudo-TTY. Same fixture, same single question, nothing else sent.

Three shell commands, in order, read from the session rollout rather than from
the prose:

```
1. sed -n '1,240p' .agents/skills/check/SKILL.md
2. keeldocs check --json
3. sed -n '1,240p' .keeldocs/out/check-8ff08e6d.json
```

```
Not fully. Keeldocs found one stale generated API inventory table in docs/reference/endpoints.md:7.

All 3 detected HTTP endpoints are documented (100% coverage); the document's anchor is current, but its generated
table needs regeneration. Run keeldocs sync to update it.
```

**The skill file is the first action, and `docs/` and `routes/` are never opened
at all** — no exploratory listing, no reading of the documentation it is being
asked about. On the false-pass question this is strictly stronger evidence than
the Claude Code run, which did eventually read `endpoints.md` (after the engine
had already answered). Codex could not have hand-derived this answer; it never
looked at the material.

Mechanism note worth carrying forward: **Codex has no skill-invocation
primitive.** Where Claude Code emits a `Skill` tool call, Codex simply `sed`s
the `SKILL.md` and follows it. Signal 2 of the three-signal test therefore takes
a different form per agent — a skill *tool call* on one, a *read of the skill
file* on the other — and a harness that looked only for the former would score
Codex as never having discovered anything.

### Cursor

Not tested — absent from this host, see below.

## Test B — verbatim response, Claude Code

Run twice, because the as-shipped invocation path is broken (finding 4 below)
and a single run could not separate "the agent failed to discover the skill"
from "the skill told it to run a binary that does not exist."

**Condition 1 — as shipped, no global install.** 11 tool calls, 13 turns.
Sequence: `Skill check` → `keeldocs check --json` (fails, not on PATH) → seven
recovery calls → `npx keeldocs check --json` (engine runs) → reads the spilled
envelope → reads the doc.

```
No — one section has drifted.

**`docs/reference/endpoints.md:7`** — `api.inventory.table` is **stale** (fact hash `630e607b…` → `803e3c5a…`). That's the endpoint table, and it matches the last commit `8ff08e6 refactor: rename the orders routes, drop the v1 surface`: the table still lists `/api/orders` and `/api/v1/users/:id` from `routes/v1.js`, which no longer exist.

Everything else is fine: the `api.inventory` anchor is clean, coverage is 3/3 surfaces (100%), no dead/tampered blocks, no extraction gaps or quarantines.

Fix is `keeldocs sync` (regenerates the block — don't hand-edit inside the `keeldocs:gen` markers). Want me to run it?
```

**Condition 2 — `npm i -g keeldocs@0.2.0-rc.4` present.** 6 tool calls, 8 turns.
The skill's literal command works on the first attempt.

```
No — one block is stale.

**`docs/reference/endpoints.md:7`** — generated endpoint table, `api.inventory.table`, state `stale` (recorded `h1:630e607ba8467056`, current `h1:803e3c5a591ea9ad`). Cause is `8ff08e6` *"rename the orders routes, drop the v1 surface"*:

| doc says | reality (facts cache) |
|---|---|
| `GET /api/orders` → routes/api.js:5 | `GET /api/purchase-orders` → routes/api.js:4 |
| `POST /api/orders` → routes/api.js:6 | `POST /api/purchase-orders` → routes/api.js:5 |
| `GET /api/v1/users/:id` → routes/v1.js:4 | gone |
| `GET /health` → app.js:5 | ✅ unchanged |

Everything else is fine: anchor `api.inventory` clean, coverage 3/3 endpoints documented (100%), no dead or tampered blocks, no unresolvable entries, no extraction gaps.

Fix: `keeldocs sync` regenerates the table. Want me to run it?
```

Both are PASS. Neither is a false pass: in both runs the `Skill` call is the
*first* action, before any file is read, and in condition 1 the only `Read` of
`endpoints.md` happens at call 11 — after the engine had already answered.

The delta between conditions is the measured cost of finding 4: **5 extra tool
calls, 5 extra turns, and $0.586 vs $0.340 per run** — 42% of the run spent
recovering from a command that does not exist. (Agent wall-clock was 47.3s vs
42.8s. These are single samples of *agent* turnaround, not keeldocs latency, and
nothing here should be read as an engine timing figure.)

## Test B — Codex, both conditions PASS

Signed in 2026-08-03 (`chatgpt` auth mode), run as
`codex exec "Is my API documentation still accurate?" -s workspace-write --json`.
Stdin must be closed (`< /dev/null`): with a piped stdin and a prompt argument,
`codex exec` blocks waiting for a `<stdin>` block and never starts.

The Codex adapter installs the `AGENTS.md` fallback block as well as the skills,
and that block *itself* says `run keeldocs check --json`. So a passing Codex run
is ambiguous by construction — the skill and the fallback both point at the same
command. It was therefore run twice.

**Condition A — as shipped (skills + `AGENTS.md`).** Three items: an opening
message naming "the repository's keeldocs verification workflow", then
`sed -n '1,240p' .agents/skills/check/SKILL.md && keeldocs check --json`, then:

```
Not fully. Keeldocs found one stale API-doc section in docs/reference/endpoints.md:7.

Coverage is complete: all 3 HTTP endpoints are documented, and 1 other document is current. Run `keeldocs sync` to generate the targeted documentation update.
```

**Condition B — skills only, `AGENTS.md` removed.** This is the isolation run,
and it is the one that settles the mechanism:

```
CMD: sed -n '1,240p' .agents/skills/check/SKILL.md
CMD: keeldocs check --json
CMD: sed -n '1,260p' .keeldocs/out/check-8ff08e6d.json
```
```
Not fully. Your API endpoint inventory is stale at docs/reference/endpoints.md:7.

Coverage is still complete: 3 of 3 detected endpoints are documented. The document's API anchor itself is current; only the generated endpoint table has drifted. I can sync that section for you with `keeldocs sync`.
```

With the fallback block deleted, Codex still found the skill, read it, ran the
engine and read the spilled envelope. **Skill discovery alone drives it**; the
`AGENTS.md` block is not doing the work. The envelope appeared in both runs from
a detector reset to zero.

One honest qualification: Codex's answers are thinner than Claude Code's. They
name the document, the line and the state, but never quote a fact hash. So
signal 3 of the three-signal test is absent for Codex, and the mechanism rests
on signals 1 and 2 — which are stronger here anyway, because the session record
contains the literal `keeldocs check --json` it executed rather than an
inference about it.

## Codex: discovery separated from invocation, and verified without an account

Recorded because the technique outlives this run: **discovery is testable
without an account**, and it was verified that way before the owner logged in.
When Codex was first installed there was no `OPENAI_API_KEY` and no `~/.codex`
auth, so Test A and Test B were blocked — but the half R7 is actually a bet
about was not.

`codex debug prompt-input` renders the model-visible prompt as JSON and needs no
login. Run in a scratch repo with the skills installed by `install-skills.py
codex`, it shows **all six keeldocs skills present, by name and description,
read from `.agents/skills/*/SKILL.md`** — alongside Codex's own `.system`
skills. The `AGENTS.md` fallback block is loaded too, as repo `<INSTRUCTIONS>`,
so `agents_md_block: true` is also correct.

So the adapter contract was confirmed on the mechanism R7 doubts before a single
credential existed: a second, independent implementation reads the same
directory layout and puts keeldocs' skills in front of the model. The login,
when it came, only had to answer whether Codex would *choose* to invoke one. It
did, in all three of its runs.

This is worth keeping as procedure. Splitting discovery from invocation turns a
blocked row into a half-answered one, and the two failures have different fixes:
only a discovery failure is an adapter change.

*Method note, recorded because it nearly produced a wrong finding.* A `strings`
pass over the Codex binary showed zero occurrences of `.agents/skills` and three
of `~/.codex/skills`, which looked like proof the adapter pointed at a directory
Codex never reads. That inference was wrong: the discovery roots are built at
runtime and are not literals. Running the binary settled in one command what
reading it had gotten backwards, which is the same lesson section 6 of the
roadmap records about residuals.

## Cursor: not installed, and deliberately not installed here

There is no trustworthy package-manager path to Cursor's agent CLI on this host.
The `cursor-agent` package on npm is **not** Cursor's CLI — it is a third-party
"task sequence creator" published by `zalab-inc` — and installing it would be a
supply-chain mistake that tests nothing. The official routes are a
`curl https://cursor.com/install | bash`, which this session will not pipe from
the network on its own initiative, and the Homebrew `cursor` cask, which is the
GUI editor and still requires signing in. Cursor therefore needs the owner
either way, and nothing was installed for it.

**7. Agents differ in how the extractor runtime must be installed, and the
difference silently changes the verdict.** Claude Code inherits the environment
it was launched with, so putting a venv on `PATH` at launch is enough. **Codex
executes every shell command through `/bin/zsh -lc` — a *login* shell, which
re-sources the user's profile and rebuilds `PATH` from scratch.** The venv
prepend is discarded before any provider runs.

The first Codex run therefore came back with `py-imports: rc=1` and this answer:
*"I can't confirm the API docs' accuracy: keeldocs hit a tooling error."* Scored
naively that is a FAIL for Codex. It is nothing of the kind — Codex found the
skill, ran the engine, correctly classified the result as tooling health rather
than drift exactly as the skill instructs, and *refused to claim the docs were
accurate*. That is close to ideal behaviour, and a careless reading of it would
have falsified R7 on the strength of a `PATH` variable.

The fix, and the thing the runbook should say: the pinned runtime must be
importable by the `python3` a **login shell** resolves, not merely by the one
the launching process sees. Here that meant
`python3 -m pip install --user --break-system-packages -r providers/requirements.txt`
into the Homebrew interpreter (`--user`, so nothing in the brew prefix is
touched, which is what Homebrew's own PEP 668 message recommends).

**5. `AGENTS.md` names a skills directory that no adapter creates.** The shipped
fallback block says *"the skills in `skills/` take precedence over this file"*,
but the three adapters install to `.claude/skills`, `.agents/skills` and
`.cursor/skills` respectively. Nothing is ever placed at `skills/` in a user's
repo. It is one word in a file whose entire job is to orient an agent that has
no skill support, shipped by a project whose thesis is that documentation is not
lying to you. Not fixed here — it is a live user-facing artifact and the change
belongs with a decision about what that sentence should say.

**6. The Codex manifest's discovery comment is unverified and partly wrong**
(cosmetic). `adapters/codex/manifest.yaml` annotates the path as `cwd -> repo
root -> ~ -> /etc/codex/skills`; `/etc/codex/skills` appears nowhere in the
0.146.0 binary, and `~/.codex/skills` (via `CODEX_HOME`) plus a project-level
`.codex/skills` are what it actually resolves. The functional field
(`skills_dir`) is correct and was verified above; only the comment is stale.

## Environment defects found before a verdict was possible

Recorded because each one, left in place, produces a confidently wrong E7 result
rather than an obviously broken one.

**1. The extractor runtime is not optional, and the runbook's install line does
not run on a modern macOS.** With no `tree_sitter`, every provider exits 1 and
`keeldocs check` returns `TOOL_ERROR`, not `DRIFT_FOUND`. An agent that
correctly invoked the skill would have been scored FAIL for an environment
fault. `pip install -r providers/requirements.txt` is refused by PEP 668 on
Homebrew Python; a venv was used instead, and the agent must be launched with it
on `PATH`. All eight pinned deps do install and import on Python 3.14.5, which
is two minors ahead of CI's pinned 3.12.

**2. `sql-replay` needs `npm ci`.** `@electric-sql/pglite` is an
`optionalDependency` and the working tree had no `node_modules`. Before it was
installed the harness reported 8 failures; after, 0.

**3. The fixture was contaminated, and invisibly so — fixed in
`prep-fixture.py`.** Running the test suite writes `.keeldocs/` *into*
`fixtures/express-mounts/`, and this repo gitignores `**/.keeldocs/out/`, so
`git status` stays clean and nothing warns you. `prep-fixture.py` then
`copytree`d it into `~/e7-run`, which has no `.gitignore`, so `git add -A`
committed it — including a `check-*.json` envelope — into the commit whose
message is *"the app, before any documentation exists"*. Worse, the script's own
final verification run left `.keeldocs/out/check-<sha>.json` in the tree, naming
the doc, line 7, `state: "stale"` and both hashes. **An agent could `cat` that
file and produce a perfect answer with the engine's receipts having never
invoked the engine** — a false pass strictly more convincing than the
markdown-hand-reading one the runbook warns about, and one the runbook does not
anticipate. Three lines fix it: drop `.keeldocs/` on copy, write a `.gitignore`
carrying this repo's own `**/.keeldocs/out/` rule, and delete `out/` after the
drift assertion. Verified after the fix: the first commit contains only
`.gitignore`, `app.js`, `package.json`, `routes/*`, and no envelope exists in
any commit or on disk.

**4. The skills call a binary the install story never provides.** Every skill
says `keeldocs <cmd> --json`; the README says `npx keeldocs`; `keeldocs` is on
no PATH after `npx keeldocs init`. This is an *invocation* defect, not a
discovery one — the distinction the runbook asks for — and it is the one thing
here that reaches real users. It did not defeat Claude Code, which recovered to
`npx`, but it cost 42% of the run, and it is a coin-flip whether a less
persistent agent recovers at all.

**Fixed 2026-08-03, docs-only** — but the first attempt was placed on a false
premise and is corrected here, because the premise was recorded in this file.

The fix originally went only into `skills/keeldocs-core/SKILL.md` rule 1, on the
reasoning that core "is loaded as shared context by the other five skills." **That
is not a mechanism.** `grep -rn keeldocs-core src bin scripts adapters recipes`
returns nothing: no code loads it, and the claim rested on Claude Code having
happened to read it. E7's own transcripts settle it — Claude Code read
`keeldocs-core/SKILL.md` in every run, and **Codex never opened it at all**; its
three commands were `sed .agents/skills/check/SKILL.md`, `keeldocs check --json`,
and a read of the spilled envelope. A fix living only in core reaches one of the
two agents that passed.

The wording now also lives in `skills/check/SKILL.md` and `skills/sync/SKILL.md`
— the files the agents demonstrably open. It names `npx keeldocs` as the normal
case rather than the exception, and says `command not found` is an invocation
problem and never a licence to answer from one's own reading of the code, which
is the false pass this experiment exists to catch. `AGENTS.md:5` carries the same
bare form and is still unfixed, deliberately: see finding 5.

Skills listing is unchanged at 1539/8000 (the cap counts name and description
only), all three adapters still install, 151/151 units and harness rc=0.

**The measurements above predate that fix, and the Claude Code row was
deliberately not re-run against the new skills.** `~/e7-run` still carries the
skill files Test B used, so Test A and Test B describe the same artifact. The
fix should be re-smoked on the next E7 run; the expectation is that condition 1
collapses toward condition 2's six calls, and that expectation is untested.

Unrelated and cosmetic, noted in passing: `CLAUDE.md` says to run
`node --test tests/`, which Node 25 rejects (it resolves `tests` as a module);
CI's `node --test tests/*.test.js` is the working form. `README.md:5` still
says `0.2.0-rc.1` on npm.

## Verdict

- Agents green: **2 of 3** (≥2 clears the `0.2.0` gate). **The gate is cleared.**
  Claude Code and Codex each passed Test A and Test B; six runs; the skill was
  the first action in every one.
- Does R7's uniformity assumption hold? **Yes, on the two implementations
  tested, and it is now a measurement rather than a bet.** Two independently
  built agents, given nothing but a skill directory and a user question that
  never names the tool, each discovered the skill, invoked the deterministic
  engine, and reported drift from the engine's envelope rather than from their
  own reading of the code. That is the load-bearing assumption of the entire
  agent-native distribution strategy, and it held.
- **What is *not* established.** Cursor is untested, so "uniform across the
  matrix" remains a two-thirds claim; R7's stated matrix is three. The runs are
  single samples per condition, not a reliability rate — E7 is specified to
  re-run weekly for exactly that reason, and one green run is not a stability
  claim. And R7's deliberate breaking-change drill has not been exercised.
- Failure analysis, per the runbook's three-way split: **discovery** passed on
  both agents. **Invocation** was defective in the shipped artifact (finding 4,
  now fixed) and survived only because both agents worked around it.
  **The envelope** behaved exactly as designed on both — `code` drove the
  response, the spill file carried detail out of context, and when the
  environment was broken Codex correctly reported `TOOL_ERROR` as tooling health
  rather than inventing a drift answer.
- The two agents fail *differently*, which is the useful part for adapter
  maintenance: Claude Code emits a `Skill` tool call and recovers from a missing
  binary by trying `npx`; Codex has no skill primitive at all and simply reads
  `SKILL.md`, and it runs commands in a login shell that discards a `PATH` set
  at launch. Neither behaviour is inferable from the standard.
- Failure analysis, per the runbook's three-way split: **discovery** passed
  cleanly. **Invocation** is defective in the shipped artifact (finding 4) and
  survived only because the agent worked around it. **The envelope** behaved
  exactly as designed — `code` drove the response and the spill file carried the
  detail out of context.

## What this changes

**`0.2.0` is no longer gated on evidence.** E7 was the last item, it ran, and it
passed at the stated threshold. The cut is now a decision rather than a
blocker — and ROADMAP §4's standing question (cut on E7's evidence or on your
own judgement) can be answered the easy way, because the evidence exists.

Cursor stays open as R7's third column. It is not on the critical path for
`0.2.0` at 2 of 3, and it needs an official install plus a sign-in.

Two things the pass does not license. E7 is specified to **re-run weekly**, and
nothing here measures reliability — six runs on one afternoon on one host is a
demonstration, not a rate. And the fix for finding 4 landed *after* these runs
and was deliberately not re-smoked, so its expected effect is untested.

Finding 4 was fixed. Finding 5 remains open and is one word. Findings 1, 2, 3
and 7 are now written into `RUNBOOK.md` and `prep-fixture.py` rather than into
anyone's memory, which was the point of ordering this experiment before a launch
rather than after one.
