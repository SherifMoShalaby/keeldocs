# R7 — the deliberate breaking-agent-API drill

**First run 2026-08-08 → FAILED on one class in four, fixed, now passes.**
Runner: `drill.py` in this directory. Standing gate: the `R7 break drill` check
in `scripts/harness.py`, which runs the same four classes on every harness
invocation and never writes to the tree.

## Why this exists

R7's de-risk line in `docs/design/08-risks-experiments.md` ends with "one
deliberate breaking-change drill ≤1 week fix", and the matching v1.0 gate in
`ROADMAP.md` §3 read "Survived one breaking agent-API change, adapters-only fix
≤1 week — **Not yet exercised**". Both were passive. They waited for Anthropic
or OpenAI or Cursor to break something, and until that happened the gate could
neither pass nor fail, which means it was measuring nothing about the design it
was supposed to protect.

The claim under test is narrow enough to be testable. R7's mitigation column
says "adapters ≤300 LOC, path-maps only". That is a claim that a change on the
agent's side is absorbed by editing **data** in `adapters/<agent>/manifest.yaml`
and never **code** in `src/skillscmd.js`. The drill breaks the surface on
purpose and measures whether that holds.

## How it measures

A break class is one thing an agent can change unilaterally. For each, the drill
copies the shipped package tree twice, runs the real installer from the copy,
and requires two things in order. First the **unfixed** tree must fail the new
contract — a break the current code already satisfies proves nothing, and is
reported `VACUOUS`, which the harness treats as a failure rather than a pass.
Then the **fixed** tree must conform, after an edit to one manifest. Both
package trees are hashed file by file afterwards and the changed set is
computed, so "adapters-only" is a measurement of the two trees rather than a
property of how the drill was written: had a class needed a change in
`src/skillscmd.js`, the changed set would have carried that file and the class
would have failed.

A control runs first. Every shipped manifest is checked against today's
contract, and if any fails the drill reports `CONTROL_FAILED` and exits 2
without running a single class. This is not ceremony. The adoption instrument
next door spent four days reporting a conclusion drawn from a control that could
never have passed for anybody, and that lesson is cheap to apply here.

The four classes: the agent moves its skills directory; the agent starts
rejecting a frontmatter key it used to accept; the agent lowers the ceiling on
the whole skills listing; the agent drops native skill discovery and falls back
to `AGENTS.md`.

## First run — one class in four was not absorbable

```
R7 breaking-agent-API drill - FAILED (listing 1539 chars, commit 68f27b9)
  control claude-code  OK
  control codex        OK
  control cursor       OK
  ABSORBED    skills-dir-moved (claude-code)
  ABSORBED    frontmatter-key-rejected (claude-code)
  UNABSORBED  listing-cap-lowered (codex)
      broke: envelope declares cap 8000, agent's cap is 1200
      broke: listing 1539 exceeds the agent's 1200 cap and the install
             reported INSTALLED instead of refusing
      STILL BROKEN after the manifest fix: envelope declares cap 8000,
             agent's cap is 1200
  ABSORBED    native-discovery-dropped (claude-code)
```

`src/skillscmd.js` held `const LISTING_CAP = 8000`, and `scripts/harness.py`
held the literal `8000` again in its skill lint. So the one number that is
wholly the agent's to choose lived in two places that could disagree with each
other, and in neither place the agent's own manifest. Had Codex halved its
listing cap, the adapter layer could not have expressed it: `keeldocs skills
install` would have written every skill, reported `INSTALLED`, and printed
`listing 1539/8000` — a receipt naming a budget that agent no longer had. The
agent would have loaded as much of the listing as fit and silently dropped the
rest, and nothing on either side would have said so. That is the same shape as
the defects `0.4.0` through `0.5.0` were spent on: a green report over something
that was never checked.

The header of `src/skillscmd.js` had already written down the rule this broke —
*if the manifest and an installer could disagree, the manifest would be
documentation rather than configuration* — and the cap was exactly that
disagreement, sitting under the comment that forbids it. **R7's "path-maps only"
mitigation was partly false, and it had been false since the installer shipped.**

## The fix, and the second run

`listing_cap:` became a manifest key. `src/skillscmd.js` reads it and refuses a
manifest that states an unusable one rather than defaulting a typo back to 8000.
The engine default of 8000 stays for a manifest that states nothing, because
Codex is the only one of the three that publishes a number: applying its cap to
Claude Code and Cursor is an assumption, and dropping the enforcement for them
instead would be a different unmeasured claim, not a smaller one. Both manifests
say so in a comment. `scripts/harness.py` now reads the smallest cap any adapter
states instead of restating a literal.

The drill also gained a correction of its own on that run. Its first validator
required the `AGENTS.md` fallback block even for a run that had correctly
refused, so a clean refusal was scored as a failure. Conformance over the cap is
now: refuse, name the agent's real number, and write **nothing** — because a
refusal in the envelope alongside a complete install on disk is two answers to
one question. The installer was restructured to decide the cap before it writes
anything, which it previously did not: it wrote all six skills and the
`AGENTS.md` block and *then* returned `TOOL_ERROR`.

Second run, and every run since:

```
R7 breaking-agent-API drill - ABSORBED (listing 1539 chars)
  control claude-code  OK      control codex  OK      control cursor  OK
  ABSORBED  skills-dir-moved (claude-code)          fix: adapters/claude-code/manifest.yaml
  ABSORBED  frontmatter-key-rejected (claude-code)  fix: adapters/claude-code/manifest.yaml
  ABSORBED  listing-cap-lowered (codex)             fix: adapters/codex/manifest.yaml
  ABSORBED  native-discovery-dropped (claude-code)  fix: adapters/claude-code/manifest.yaml
```

## What this does NOT prove

Every line here is about a **model** of an agent, not an agent. The distinction
carries the whole weight of how far this result may be quoted.

It does not prove keeldocs has survived a breaking agent-API change. Nothing has
broken. A contract file is a description of an agent written by the same person
who wrote the adapter, and the ways real agents differ are exactly the ways such
a file does not think to differ: E7 found that Codex has no skill-invocation
primitive and simply reads `SKILL.md`, and that it runs commands in a login
shell which discards a `PATH` set at launch, so the environment fix that works
for one agent does not work for the other. Neither of those is expressible in
these four fields, and neither was predicted by the standard.

It does not measure the ≤1 week window. The drill's fix time is minutes by
construction — the fix is written into the class definition before the run
starts. What the window actually covers is noticing the break, diagnosing it,
and shipping, none of which happens here.

It does not prove the classes are exhaustive, and two known ones sit outside it:
a change to the frontmatter **format** (something other than `---` delimited
flat keys) and a rename of `SKILL.md` itself would both require editing
`src/skillscmd.js`, and are not absorbable today. They are named rather than
tested because absorbing them would mean building a parser abstraction against a
break nobody has announced. Assume an unfound class exists.

It does not prove auto-invoke survives a reinstall. Whether an agent still
discovers and invokes the skill after the adapter fix is E7's question, it needs
the real binaries signed into real accounts, and it stays in ROADMAP §4.

The honest reading of a green run is this and no more: **of four ways an agent
can break this surface, all four are now absorbed by editing one manifest, and
one of them was not before the drill was written.**

## Running it

```
python3 experiments/r7-break-drill/drill.py            # human-readable
python3 experiments/r7-break-drill/drill.py --json     # one JSON object
python3 experiments/r7-break-drill/drill.py --record   # also append ledger.jsonl
```

Exit 0 when every class is absorbed, 1 when any class is `UNABSORBED` or
`VACUOUS`, 2 when the control failed and the run measured nothing. `--record` is
never passed by the harness: a gate that writes to the tree it is checking would
put `check` into drift against itself on every CI run. `ledger.jsonl` carries one
line per recorded run with the commit and whether the tree was dirty at the
time, so a green line can be traced to the code that produced it.
