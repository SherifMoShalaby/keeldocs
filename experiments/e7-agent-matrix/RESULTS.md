# E7 — cross-agent skill smoke matrix: results

**Not yet run.** Procedure: `RUNBOOK.md`. Fill this in as you go rather than
afterwards from memory — Test A's value is in the agent's *first* response, and
that is the thing that is hardest to reconstruct honestly an hour later.

- Date run:
- keeldocs version: `0.2.0-rc.4` (npm)
- Fixture: `prep-fixture.py` → baseline CLEAN → seeded `DRIFT_FOUND` (1 stale doc, `/api/orders` renamed, `/api/v1` deleted)

## Matrix

| Agent | Version | Test A: auto-invoke | Test B: headless | Notes |
|---|---|---|---|---|
| Claude Code | | | | |
| Codex | | | | |
| Cursor | | | | |

Test A is PASS only if the agent invoked the skill **unprompted**. An agent that
answered correctly by reading the markdown itself is a FAIL: it got the right
answer by the wrong mechanism, and the mechanism is what E7 measures.

## Test A — verbatim first response, per agent

### Claude Code

```
(paste)
```

### Codex

```
(paste)
```

### Cursor

```
(paste)
```

## Verdict

- Agents green: _ / 3 (≥2 clears the `0.2.0` gate)
- Does R7's uniformity assumption hold?
- If any agent failed: what specifically — discovery, invocation, or the
  envelope? Those have different fixes, and only the first is an adapter change.

## What this changes

(If green: `0.2.0` can cut, and ROADMAP §3 / §7 and R7 in doc 08 get updated.
If red: the distribution bet is weaker than the design assumed, and that belongs
in the risk register *before* any launch material is written, not after.)
