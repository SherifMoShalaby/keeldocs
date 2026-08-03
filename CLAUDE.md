# Working on keeldocs

Instructions for a coding agent working **on this repository**. (`AGENTS.md` is
a different thing: the fallback block shipped to *users* whose repos keeldocs
manages.)

keeldocs is deterministic living documentation: providers extract typed facts,
doc sections are anchored to those facts, drift is a fact-hash change. The claim
the whole project rests on is **"your documentation is not lying to you."**
Every rule below exists to protect that claim.

## Where the truth lives

`ROADMAP.md` is the single tracking document. **§4 is the only open list** —
everything in it needs a physical machine (real agent binaries, stable hardware,
a registry login, people). §5 is refusals with written evidence thresholds, not
backlog. §6 is closed and is a record, not a queue.

Current: `keeldocs@0.2.0-rc.4` on npm, 151 unit tests, 39 extractor goldens,
80 harness checks, 3-OS CI green (Windows non-blocking).

## Never

- **Never put an LLM call, a network call, or a clock read in the `check` path.**
  It is a pure function of the tree. `--ci` uses HEAD commit time, not `now()`.
- **Never quote a p50 or p95 figure anywhere public.** R10's latency budgets have
  **no verdict**: the container they were measured in drifts up to 2.3× between
  sessions on identical code paths. Correct-at-1M-lines and RAM are established;
  speed is not. Say what is measured; say nothing about what is not.
- **Never let Tareeqna's schema, DSNs, or contents enter this public repo.** Only
  aggregate counts.
- **Never commit a token or put one in a git remote.** Never echo a secret into
  command text.
- **Never hand-edit between `<!-- keeldocs:gen -->` markers** — regenerate.
- **Never reopen the D-series.** It closed 2026-08-02 after eleven items, of
  which two were needed. Profiling always finds a next-largest bottleneck; a
  list built that way has no end. If you profile and find something, that is
  information, not a roadmap item.

## Verify, then claim

The project's own thesis makes an unverified claim worse here than elsewhere.

- Run `node --test tests/` and `python3 scripts/harness.py` before saying
  anything passes. Both, not one.
- Check the artifact, not the log that says the artifact was made. Pull the
  published tarball; decode the attestation; run the binary cold.
- A residual is not a measurement. Two D-items were opened on a number derived
  by subtracting a total from a total and naming the most plausible suspect;
  both were wrong.
- If a gate would pass vacuously, it is not a gate — grow the fixture or fail.

## Release

Tag `v*` → `.github/workflows/release.yml` publishes via npm Trusted Publishing
with an OIDC provenance attestation. **No publish token exists; do not create
one.** The workflow pins npm 11 (npm 12 needs Node ≥22.22) and asserts the
11.5.1 floor. Prereleases publish under their own dist-tag and never move
`latest` — until a stable `0.2.0` ships, move it by hand:
`npm dist-tag add keeldocs@<version> latest`.

Cutting `0.2.0` waits on E7 only. See `experiments/e7-agent-matrix/RUNBOOK.md`.

## Style

Commits say what changed and **why**, and name the failure mode. If something
was wrong, say what was wrong and what it would have cost — the git history is
the project's memory of its own mistakes and is worth more than a tidy log.

Prose over bullet lists in the design docs. No emoji.
