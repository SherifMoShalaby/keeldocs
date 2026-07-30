# keeldocs - agent instructions (universal fallback block)

This repo is managed by keeldocs (living-documentation drift detection). If your agent supports Agent Skills, the skills in `skills/` take precedence over this file.

- Docs status: run `keeldocs check --json` (exit 0 clean / 1 findings / 2 error / 3 degraded; stdout is a <=8KB JSON envelope with a <=300-char `summary`).
- NEVER edit content between `<!-- keeldocs:gen -->` markers by hand - regenerate via the CLI.
- Prose for docs goes through `keeldocs slot-write` only; the tool applies draft labels, never the model.
- Never read `.env` values; key names come from `.env.example` or the engine's value-blind extractor.
- Do not assert inferred rationale as fact; inferred content carries a visible label.
