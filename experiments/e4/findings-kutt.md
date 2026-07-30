# Findings: thedevs-network/kutt

Detector run: `python3 detector.py repos/kutt` (clone depth=400, 2026-07-30).
Docs scanned: `README.md` (261 lines). Code/config files scanned: 202. Routes scanned: 18.

Claims checked: A_file=5, B_npm_script=3, C_env_var=47, D_internal_link=8, E_route=0.
Findings: 1. Verified true: 1. **Precision: 1/1 = 100%.**

---

## F-KUTT-1 — [C_env_var] README.md:140 — documented env var `OIDC_POMPT` is never read

**Doc line (README.md:140):**
```
| `OIDC_POMPT` | OIDC prompt | - | `login` |
```
(row in the README's table of supported environment variables)

**Receipts (commands actually run):**
```
$ grep -rn "OIDC_POMPT" kutt/ --include=*.js --include=*.json --include=*.hbs | wc -l
0        # zero references anywhere in code/config (detector scanned all 202 code files: 0 matches)

$ grep -n "OIDC_PROMPT" kutt/server/env.js kutt/server/passport.js
kutt/server/env.js:67:  OIDC_PROMPT: str({ default: "" }),
kutt/server/passport.js:104:            ...(env.OIDC_PROMPT ? { prompt: env.OIDC_PROMPT } : {})

$ grep -n "OIDC_PROMPT" kutt/.example.env
97:OIDC_PROMPT=
```

**Analysis:** The README env-var table documents `OIDC_POMPT` — a typo. The code
(envalid schema `server/env.js:67`, consumed in `server/passport.js:104`) and the
repo's own `.example.env:97` both use `OIDC_PROMPT`. A user who copies the variable
name from the README sets a variable the app silently ignores.

**Verdict: TRUE.** Verifiable in <1 min: open README.md:140 next to server/env.js:67.

---

## True negatives (spot-checked)

- `npm run migrate`, `npm run dev`, `npm start` (README.md:65-66) — all present in
  package.json scripts: ['dev', 'docs:build', 'migrate', 'migrate:make', 'start']. No lie.
- 8 relative markdown links (e.g. `./custom`, docker-compose files) — all targets exist.
- 46 other documented env vars — all referenced in code.

## Suppressed candidates (confirmed false positives during tuning)

- `custom1.css`, `custom2.css` (README.md:160-161 tree diagram, :175 prose) — examples of
  files *the user* may add to the empty `custom/` folder ("You can put as many style files
  as you want"); `custom/` contains only `.gitkeep`. Suppressed by tree-diagram +
  instructional-context rules.
- `JWT_SECRET_FILE` (README.md:98) — read dynamically: `server/env.js:80`
  `const file_key = key + "_FILE";` (docker-secrets convention applies to every var).
  Suppressed by dynamic `_FILE`-suffix rule.
