---
name: keeldocs-init
description: Set up keeldocs in a repository - detect the stack, run the doc lie-detector against existing docs (receipts included), and write anchored starter docs. Use when the user asks to set up keeldocs, initialize living documentation, map the repo, or audit whether existing docs are stale.
disable-model-invocation: true
---
# keeldocs init

1. Run `keeldocs init --json`. Nothing is written and there are zero LLM calls; the envelope comes back `DRY_RUN` (exit 0).
2. Show the user the detection card first and let them correct a misdetection.
3. Relay the lie-detector findings verbatim WITH their receipts - each is verifiable in seconds; never soften or reword a receipt.
4. If the user approves, run `keeldocs init --yes --json` to write the starter docs. That returns `INITIALIZED` (exit 0). Existing files are never overwritten (skipped = human-owned). Then suggest committing the generated docs - that arms the drift tripwire for `keeldocs check`.

`init` emits exactly four codes: `DRY_RUN` and `INITIALIZED` above, plus `CONFIG` (exit 2 - keeldocs.toml could not be read, or `--live` was refused in CI) and `TOOL_ERROR` (exit 2 - the extractors could not run). Neither failure says anything about whether the documentation is accurate: nothing was measured. See the core skill.

Doc lies are the value here, not a failure - `init` returns exit 0 with findings, because finding them is what it was asked to do.
