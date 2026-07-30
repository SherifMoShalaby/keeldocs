# E1 notes — extraction recall/precision (mini, directional)

## Method actually followed
1. Ground truth labeled FIRST by reading source (grep to locate, then read files), locked in
   `ground_truth_nestjs.json` (45) / `ground_truth_express.json` (88) BEFORE any extractor code
   was written. hackathon-starter scoped to a deterministic pre-chosen subset (app.js lines
   252-323, the main+API+AI sections) to respect the ~40-80/framework cap; scoring is
   line-scoped so out-of-subset extractions (36 OAuth routes) count neither for nor against.
2. Extractors: `extract_nestjs.py` (tree-sitter Query over decorator patterns + composition
   glue), `extract_express.py` (code tier: var tracking, chained Router().use() evaluation,
   import following, default-export resolution, mount-prefix BFS), `extract_express_naive.py`
   (declarative-only baseline: literal first-arg member calls, no mounts), `extract_prisma.py`.
3. Scoring: `score.py`, key = (repo, file, METHOD, normalized path), `:x` == `{x}`.

## Conventions (affect what "path" means)
- NestJS: composed decorator path only (controller path + method path). `setGlobalPrefix('api')`
  (realworld) and URI versioning `version: '1'` (boilerplate, 8/9 controllers) are runtime app
  config, excluded symmetrically from truth and extraction. Full runtime-URL reconstruction
  (global prefix + /v1) was NOT tested.
- Express: full runtime path incl. resolved mount prefixes.

## Failure taxonomy (every discrepancy observed)
1. **dynamic-registration** — hackathon-starter `app.js:228-235`:
   `for (const [fileUrl, filePath] of libFiles) { app.head(fileUrl, h); app.get(fileUrl, h); }`
   ~10 static-lib GET/HEAD endpoints unenumerable statically. Code-tier extractor correctly
   emitted a non-literal-path warning instead of guessing. Outside labeled scope, so it did not
   hit measured recall — but it is the one true dynamic case seen in these 4 repos.
2. **cross-file-mount-unresolved** (naive baseline only) — all 19 naive misses. Chain:
   `main.ts app.use(routes)` -> `routes.ts export default Router().use('/api', api)` ->
   `api = Router().use(tagsController).use(...)` -> controller `router.get('/articles', ...)`.
   Naive emits `/articles` (also 19 wrong-path FPs); code tier resolves `/api/articles`. 
3. **decorator-edge-case** — none missed; note the object form `@Controller({ path: 'auth',
   version: '1' })` appears in 8/9 boilerplate controllers, and multi-decorator runs
   (`@Get('me')` + `@HttpCode` + `@ApiOkResponse`...) are the norm. A string-literal-only
   decorator matcher would have dropped ~23/24 boilerplate endpoints; AST query handled all.
   Also handled: class decorator attaches to `export_statement`, not `class_declaration`.
4. **string-built-path** — none present in labeled scope.
5. **prisma attr-text corruption** — `User.image  String? @default("https://...")`: naive
   `//`-comment stripping truncated the *attribute text* at `https:`. Name/type/optionality
   and all 8 explicit relations still correct. Fix: strip comments string-aware. 1/35 fields.

## Precision hazards correctly rejected (no FPs emitted)
- `app.get('port')` (config getter, 1 arg) — rejected by >=2-args rule.
- `passport.use(...)`, `refresh.use('google', ...)`, `lusca.xframe(...)` — receiver not a
  known app/router node.
- `app.use('/', express.static(...))`, body-parser/middleware `.use` — mount arg not a router.

## Caveats (do not over-read the 100% numbers)
- 2 repos per framework, single labeler (= extractor author). Truth was locked pre-extractor,
  but both artifacts come from the same person reading the same code.
- n=45 / n=88 with zero errors: rule-of-3 95% CI lower bounds are 93.3% / 96.6%. Recall gates
  (>=90, >=95) pass even at the CI lower bound; the >=98 precision gates pass on point estimate
  but these n cannot statistically certify >=98. Directional, as designed.
- Repos are mainstream, well-structured. No dynamic `router[method](...)` loops, no
  computed paths, no `app.route().get().post()` chaining in labeled scope (the latter is
  unimplemented in the extractor and untested).
- Naive-baseline blended recall (78.4%) is corpus-mix dependent (5% vs 100% per repo); the
  design's "~70%" claim is about apps that use router mounting, where the true number is
  far LOWER than 70% (5% here) — the thesis (declarative-only Express is inadequate) holds
  a fortiori.

## Files
- ground_truth_nestjs.json, ground_truth_express.json (hand-labeled)
- extract_nestjs.py, extract_express.py, extract_express_naive.py, extract_prisma.py, score.py
- extracted_*.json (raw extractor output), naive_score.json, results.json
- score_cfg_*.json (scoring configs incl. hackathon line scope)
