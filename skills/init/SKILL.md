---
name: keeldocs-init
description: Set up keeldocs in a repository - detect the stack, run the doc lie-detector against existing docs (receipts included), and write anchored starter docs. Use when the user asks to set up keeldocs, initialize living documentation, map the repo, or audit whether existing docs are stale.
disable-model-invocation: true
---
# keeldocs init

1. Run `keeldocs init --json` (DRY-RUN: nothing is written). Zero LLM calls.
2. Show the user the detection card first and let them correct a misdetection.
3. Relay the lie-detector findings verbatim WITH their receipts - each is verifiable in seconds; never soften or reword a receipt.
4. If the user approves, run `keeldocs init --yes --json` to write the starter docs. Existing files are never overwritten (skipped = human-owned). Then suggest committing the generated docs - that arms the drift tripwire for `keeldocs check`.
