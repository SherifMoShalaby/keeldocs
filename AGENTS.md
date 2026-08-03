# keeldocs - agent instructions (universal fallback block)

This repo is managed by keeldocs (living-documentation drift detection). If your agent supports Agent Skills, the installed keeldocs skills take precedence over this file - your agent's own skills directory (`.claude/skills/`, `.agents/skills/`, `.cursor/skills/` and equivalents), not this repository's `skills/` source tree.

- Docs status: run `keeldocs check --json`, or `npx keeldocs check --json` if `keeldocs` is not on `PATH` - the documented `npx keeldocs init` install leaves no binary behind, so that is the normal case. A `command not found` is an invocation problem and never a reason to answer from your own reading of the code. (exit 0 clean / 1 findings / 2 error / 3 degraded; stdout is a <=8KB JSON envelope with a <=300-char `summary`).
- NEVER edit content between `<!-- keeldocs:gen -->` markers by hand - regenerate via the CLI.
- Prose for docs goes through `keeldocs slot-write` only; the tool applies draft labels, never the model.
- Never read `.env` values; key names come from `.env.example` or the engine's value-blind extractor.
- Do not assert inferred rationale as fact; inferred content carries a visible label.
