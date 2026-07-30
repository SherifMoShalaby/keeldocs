# E2+E3 case-by-case judgments (2026-07-30)

Window: 13 monthly snapshots 2025-08-01 .. 2026-07-30, repos honojs/hono and
colinhacks/zod (branch main). Extractor: tree-sitter (tree_sitter 0.26.0 +
tree-sitter-typescript 0.23.2), token-normalized signatures (comments dropped,
whitespace collapsed, `,`/`;` dropped, param names stripped to types,
bodies excluded from hash). All verdicts below from reading real git diffs
(`git diff -M60% shaA shaB -- file`) between the snapshot SHAs.

## E2b: false-drift sample — 26 hash-changed cases (13/repo, spread over months)

Verdict key: REAL = actual signature/API change; FALSE = semantically same
signature (formatting or extractor artifact).

### hono (13 sampled of 73 hash-changed)
- D0 `utils/encode.ts::decodeBase64` (08→09): ret `Uint8Array` → `Uint8Array<ArrayBuffer>`. REAL (type-level).
- D1 `adapter/service-worker/handler.ts::handle` (09→10): gained generics `<E,S,BasePath>`, param `Hono<E,S,BasePath>`. REAL.
- D2 `types.ts::MiddlewareHandler` (10→11): new type param `R extends HandlerResponse<any>`, return `Promise<R|void>`. REAL.
- D3 `aws-lambda/handler.ts::EventProcessor` (11→12): class gained `getDomainName`, `getHeaderValue` members. REAL.
- D4 `validator/validator.ts::validator` (12→01): type-level output mapping rewritten with new `InferInput<...>` (verified via full-sig delta; the nearby trailing-comma-only change to `ValidationFunction` correctly did NOT flip its hash). REAL.
- D5 `adapter/bun/server.ts::getBunServer` (01→02): `(c): BunServer|undefined` → `<T>(c): T|undefined`. REAL.
- D6 `middleware/trailing-slash::trimTrailingSlash` (02→03): `()` → `(options?: TrimTrailingSlashOptions)`. REAL.
- D7 `client/types.ts::ApplyGlobalResponse` (03→04): conditional-type body rewritten. REAL.
- D8 `middleware/cache::cache` (04→05): options object gained `onCacheNotAvailable`. REAL.
- D9 `jsx/utils.ts::styleObjectForEach` (05→06): param `Record<string, string|number>` → `Record<string, unknown>`. REAL.
- D10 `jsx/base.ts::JSXNode` (06→07): field `localContexts` removed, `suspendedContext` added. REAL.
- D11 `utils/types.ts::JSONParsed` (07-01→07-30): array branch of conditional type rewritten (`extends infer A ...`). REAL.
- D12 `aws-lambda/handler.ts::EventProcessor` (08→09): `createResult` gained 3rd param `Pick<HandleOptions,'isContentTypeBinary'>`. REAL.

hono false-drift: 0/13.

### zod (13 sampled of 110 hash-changed)
- D0 `classic/schemas.ts::keyof` (08→09): ret `ZodLiteral<...>` → `ZodEnum<util.KeysEnum<...>>`. REAL.
- D1 `classic/schemas.ts::ZodType` (09→10): `default(def: core.output<this>)` → `default(def: util.NoUndefined<core.output<this>>)`. REAL.
- D2 `core/schemas.ts::$ZodPromiseInternals` (10→11): output `core.output<T>` → `Promise<core.output<T>>`. REAL.
- D3 `classic/schemas.ts::_ZodString` (11→12): interface gained `slugify(): this`. REAL.
- D4 `classic/schemas.ts::ZodFile` (12→01): gained `"~standard": ZodStandardSchemaWithJSON<this>`. REAL.
- D5 `core/api.ts::$ZodTypeDiscriminableInternals` (04→05): gained generic `<Disc extends string = string>` + parent type args. REAL.
- D6 `classic/schemas.ts::preprocess` (05→06): ret `ZodPipe<ZodTransform<A,B>,U>` → `ZodPreprocess<U>`. REAL.
- D7 `core/schemas.ts::ParsePayload` (08→09): gained `aborted?: boolean`. REAL.
- D8 `mini/schemas.ts::codec` (09→10): decode/encode results wrapped in `util.MaybeAsync<...>`. REAL.
- D9 `core/errors.ts::treeifyError` (10→11): the two PUBLIC overloads are byte-identical before/after; only the non-callable IMPLEMENTATION signature changed (`<T>(error: $ZodError, _mapper?: any)` → `<T,U>(error: $ZodError<T>, mapper = ...)`). Public API semantically unchanged. FALSE (extractor artifact: implementation signature of an overloaded function included in hash).
- D10 `core/schemas.ts::$ZodStringFormatTypes` (11→12): union gained `$ZodMAC`. REAL.
- D11 `classic/schemas.ts::ZodTransform` (12→01): gained `"~standard"` member. REAL.
- D12 `mini/schemas.ts::discriminatedUnion` (04→05): constraint `$ZodTypeDiscriminable` → `$ZodTypeDiscriminable<Disc>`. REAL. (Same window added large deprecation doc-comments to other symbols without flipping their hashes — comment stripping worked.)

zod false-drift: 1/13. Combined: 1/26 = 3.8%.

## E2c: orphan classification (month-0 symbols unresolved at month-12 by S0/S1)

### hono — 3 orphans (all 3 examined)
1. `aws-lambda/handler.ts::isContentTypeBinary` — renamed IN PLACE to
   `defaultIsContentTypeBinary` in Aug-2025 (body similarity 1.00), rename
   co-occurred with adding `: boolean` return annotation. Class: in-place
   rename, missed (S2 territory; not a file-rename miss). The same-name hit in
   `lambda-edge/handler.ts` pre-existed at m0 → distinct symbol, not the target.
2. `adapter/bun/server.ts::BunServer` — type deleted Feb-2026 when
   `getBunServer` became generic `<T>`; name absent everywhere at m12.
   Class: genuinely deleted.
3. `utils/jwt/jwt.ts::verifyFromJwks` — renamed IN PLACE to `verifyWithJwks`
   (body sim 0.96) + options object gained `verification?: VerifyOptions`.
   Class: in-place rename, missed.

### zod — 21 orphans (5 diff-read individually; all 21 checked programmatically:
target file lacked the name at m0, source lost it, exactly-one same-name symbol
appeared elsewhere)
- 10× `core/function.ts::$ZodFunction*` etc. — file dissolved into pre-existing
  `core/schemas.ts` (no git file-rename possible). Class: cross-file move.
- 5× `locales/{en,eo,tr,bg,is}.ts::parsedType` — per-locale helper consolidated
  into `core/util.ts::parsedType` (Jan-2026). Class: cross-file consolidation.
- 4× `classic/iso.ts::ZodISO{DateTime,Date,Time,Duration}` — moved into
  `classic/schemas.ts` (Jun-2026). Class: cross-file move.
- 2× `core/to-json-schema.ts::{toJSONSchema,JSONSchemaGenerator}` — moved to
  `core/json-schema-{processors,generator}.ts`. Class: cross-file move.
Genuine deletions among zod orphans: 0. File-rename misses (-M60% should have
caught): 0 in both repos (S1 fired 0 times all year).
Re-anchor probe at the move month: 21/21 moves had EXACTLY ONE same-name
candidate repo-wide; only 5/21 kept an identical hash (16/21 changed signature
within the same monthly window as the move).

## E3: rename candidates and two-signal auto-rebind

Strict S2 mining (symbol disappeared; new symbol with IDENTICAL normalized
signature, different name, in same or git-renamed file) over 24 repo-month
pairs: 0 candidates (hono had only 4 symbol removals all year, zod 23).
Therefore: top-1 accuracy N/A, auto-rebinds 0, wrong auto-rebinds 0/0.
UNDERPOWERED — no opportunities for a false rebind arose.

Ground truth from body-similarity diagnostic (same file, body sim ≥0.6, any
signature): exactly 2 true renames existed in the window — the two hono cases
above. Both changed name AND signature in the same commit, so identical-
signature S2 recall on real renames: 0/2. In both, body similarity (1.00, 0.96)
plus same-file would have identified the correct target; with sig-equality
relaxed, each had exactly one candidate and would have auto-rebound CORRECTLY
under one-candidate + body-similarity signals (2/2 right, 0 wrong; n=2,
underpowered).
