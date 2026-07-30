---
name: keeldocs-init
description: Set up keeldocs in a repository - detect the stack, build the deterministic repo map (system map, ERD, endpoint inventory, config reference), run the doc lie-detector against existing docs, and commit anchored starter docs. Use when the user asks to set up keeldocs, initialize living documentation, map the repo, or audit whether existing docs are stale.
disable-model-invocation: true
---
# keeldocs init

Run `keeldocs init --json`. Zero LLM calls; under 5 minutes. Present the detection card first and let the user correct it before extraction continues. Then relay the lie-detector findings verbatim with their receipts - each is verifiable in seconds. Offer to commit the starter docs (that arms the drift tripwire; without committed anchors, `check` has nothing to protect).
