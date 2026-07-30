# Findings: sahat/hackathon-starter

Detector run: `python3 detector.py repos/hackathon-starter` (clone depth=400, 2026-07-30).
Docs scanned: AGENTS.md, CLAUDE.md, PROD_CHECKLIST.md, README.md (1610 lines), SECURITY.md,
test/TESTING.md. Code/config files scanned: 144. Routes scanned: 157.

Claims checked: A_file=71, B_npm_script=7, C_env_var=69, D_internal_link=3, E_route=4.
Findings: 1. Verified true: 1. **Precision: 1/1 = 100%.**

---

## F-HS-1 — [C_env_var] .env.example:75 — `OPENAI_API_KEY` documented but never read

**Doc line (.env.example:75):**
```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Receipts (commands actually run):**
```
$ grep -rn "OPENAI_API_KEY" hackathon-starter/ --include=*.js --include=*.json \
    --include=*.pug --include=*.yml | grep -v package-lock | wc -l
0        # zero references in any code/config file (detector: 0 matches across 144 files)

$ git log -S "OPENAI_API_KEY" --format="%h %ad %s" --date=short
2654bd0 2026-07-01 docs: update docs
31fea30 2026-05-22 feat!: remove OpenAI Moderation API Example (#1655)
e61f10b 2025-11-01 feat: testing with API record and replay (#1501)
24469de 2025-05-07 refactor: Consolidate AI examples (#1356)
1c1c23f 2025-04-19 feat: Add OpenAI Moderation API example (#1344)

$ grep -n '"openai"' package.json
(no output — the `openai` SDK is not a dependency; AI features use @langchain/groq,
 so nothing reads OPENAI_API_KEY implicitly either)
```

**Analysis:** `OPENAI_API_KEY` entered `.env.example` with the OpenAI Moderation API
example (1c1c23f, 2025-04-19). That feature was removed in 31fea30 (2026-05-22,
"feat!: remove OpenAI Moderation API Example"), but the removal left the key behind
in `.env.example`. A user provisioning an OpenAI key per `.env.example` wastes the
effort; nothing consumes it. Corroboration: the repo's own AGENTS.md:150-152 warns
"`OPENAI_API_KEY` is present in `.env.example` but **not referenced by any current
code path**" — the maintainers' own init doc agrees with the detector.

**Verdict: TRUE.** (Nuance: known-to-maintainers drift, still uncorrected in
.env.example. AGENTS.md's warning line is itself accurate — the detector attributes
the finding to .env.example:75, the artifact that lies.)

---

## True negatives (spot-checked)

- 7 npm-script claims (e.g. `npm start`, `npm test` in README/TESTING.md) — all in package.json.
- 68 other documented env vars — all referenced in code (e.g. GROQ_API_KEY, ALPHA_VANTAGE_KEY).
- 4 route claims and 3 internal links resolved against code/worktree — all matched.

## Suppressed candidates (confirmed false positives during tuning)

- 19 README A-class candidates (index.html, left/right/no-sidebar.html, escape-velocity.pug,
  Book.js, book.js, books.pug, public/images, about.pug, ./controllers/book, ../models/Book.js,
  socket.io.js, ...): all from tutorial/recipe sections ("How do I add a new page?", HTML5UP
  walkthrough, CRUD tutorial) describing files the READER creates. Suppressed by
  instructional-context rule (733 doc lines matched; heavy but correct here).
- `partials/header.pug`, `partials/footer.pug`, `partials/flash.pug`: existed all along at
  views/partials/*.pug — early detector bug (doc-relative path resolution); fixed via
  suffix-match resolution, not suppression.
- `chart.js` (AGENTS.md:110): npm dependency name (package.json:54 `"chart.js": "^4.5.1"`),
  not a file. Suppressed by dependency-name rule.
- `/js/lib/chart.umd.min.js` (AGENTS.md:110): runtime URL served via app.js:216 libFiles map
  from node_modules. Suppressed by code-corroboration rule (exact string exists in app.js).
- `test/e2e/my-api.e2e.test.js` (TESTING.md:171/176): `my-` placeholder example filename.
- `process.env` (TESTING.md:87): code idiom matching the `*.env` filename pattern.
- `qwen/qwen3.6-27b` (README.md:1171): model ID whose version dots mimic a file extension.
- `[this](<(https://github.com/...)>)` (README.md:845): malformed markdown link wrapping;
  target is an external URL, not a repo path. (The broken markdown itself is a doc defect,
  but not a file-claim lie; out of scope for A-D classes.)
- `/escape-velocity` route (README.md:889): tutorial route the reader would add.
