# Deliverable 4 — Provider Interface Contract

Normative contract for capability providers, with one worked declarative (pattern) provider and one worked code provider. Design-level; snippets are illustrative, not implementation.

## 1. Registration manifest (both tiers)

Every provider ships a static manifest the engine reads without executing anything:

```yaml
# providers/http-endpoints/nestjs/provider.yaml
id: nestjs
capability: http-endpoints
semver: 1.2.0
tier: declarative            # declarative | code
detect:                       # manifest-index predicates only — no source reads
  any:
    - dependency: "@nestjs/core"
inputs:                       # REQUIRED — declared I/O globs; the engine hands the
  - "src/**/*.ts"             # provider ONLY files matching these (cache correctness
  - "libs/**/*.ts"            # depends on this; undeclared reads are contract breaches)
requires: []                  # e.g. [network:db] — grants ONE socket, explicit user opt-in
timeout_class: D              # D=10s/shard, C=60s/shard, N=120s (network class)
emits: [endpoint]             # fact types produced (versioned schemas)
```

## 2. Lifecycle — two pure phases

**`detect(ManifestIndex) → {applicable: bool, scope: [shard_ids], evidence: [file refs], confidence: tier}`**
Input is the parsed dependency-manifest set + file-tree listing only. ≤100ms per provider. This implements the brief's manifests-first detection order and keeps detection free on repos where the provider doesn't apply.

**`extract(shard: {root, files: [{path, blob_sha}]}, config) → FactBatch`**
Purity rule: output is a function of (declared inputs, config, provider@version). Anything else — wall clock, network, ambient env, undeclared files — silently corrupts the incremental cache and is a contract violation. Blob SHAs come from the git index, so change detection runs at `git status` speed.

## 3. Fact schema (shared by both tiers — no second-class outputs)

```json
{"id": "fact:http-endpoints/GET /orders/{id}",
 "kind": "node", "type": "endpoint", "schema_version": 2,
 "attrs": {"method": "GET", "path": "/orders/{id}",
           "handler": "ds npm app . src/orders/orders.controller/OrdersController#findOne().",
           "path_confidence": "exact"},
 "provenance": {"provider": "nestjs@1.2.0", "method": "query",
   "source": [{"file": "src/orders/orders.controller.ts", "span": [412, 486], "blob": "sha256:…"}],
   "confidence": "PATTERN", "engine": "docsmith@0.x"}}
```

Rules: fact IDs are deterministic natural keys, never UUIDs (byte-identical output, diffable files). `schema_version` sits *inside* the hashed payload; provider identity sits in provenance *outside* it (provider swaps/upgrades must not manufacture drift — ADR-008). Attribute fields are declared `ordered` or `set` in the fact-type schema; set fields sort by natural key. Cross-shard references are emitted as half-edges with symbolic targets (raw import specifier, unresolved service name) and joined by the engine's linker at merge time. Facts an extractor *couldn't* compute are emitted as `type: extraction-gap` facts — gaps are first-class so coverage counts them and a crash can never masquerade as deletion.

## 4. Failure envelope (enumerated; exceptions never escape)

`ok | not_applicable | partial{facts, gaps[]} | failed{timeout | parse | crash | denied}`

On timeout/crash the engine retains the shard's previous facts marked `stale_cache: true` — silent absence is the nastiest false-drift source. `failed` renders as tooling health in `check`, never as drift (Compilers veto: parse error ⇒ `unresolvable`, fail closed).

## 5. Sandbox and trust tiers (normative, ADR-002/013)

Code providers run as short-lived subprocesses: JSON facts on stdout, JSON errors on stderr; the *engine* writes all artifacts. Policy is declared in the manifest and shown at grant time: network deny-all (sole exception class `network:db`, one socket to the runtime-resolved host — never an address from provider code); read-only FS scoped to declared globs minus the security exclusion set (`.env*` values, key material, cloud credential dirs); writes only to per-run scratch; no undeclared child processes (`exec: ["git"]` must be declared); 5MB output cap; enforcement tiered by OS (Landlock/seccomp, Seatbelt, best-effort elsewhere) with the deterministic suite CI-run under a network-denied sandbox as a permanent regression test of the offline claim.

Consent is a separate act from verification (v0.3): `keeldocs provider show <dir>` renders the permission manifest read-only, and `provider add` prints it and stops at `CONSENT_REQUIRED` unless `--yes` is passed. The manifest resolves the declared globs against the actual repository — file count and sample, whole-directory grants, cross-capability fact reads, runtime and entry, emitted fact types, network intent, the secrets that match but will be WITHHELD, and the enforcement tier this host will really apply (per-glob / network-only / none). It never claims a boundary the platform does not provide.

Trust tiers: **T0 declarative** — safe by construction *only because* patterns are matched, never evaluated: tree-sitter queries + RE2-class regex + typed, length-capped outputs; community-contributable via repo PR from v0.1. **T1 first-party code** — signed with the release, reviewed as core code. **T2 third-party code** — v0.2+ only: hash-pinned, signature-verified, installed via explicit `provider trust <name>` rendering the permission manifest. Resolution never auto-fetches a provider; a missing provider is an honest coverage gap.

## 6. Versioning and the re-baseline rule

Semver with a hard rule: MAJOR whenever identical input can yield different output (fact schema, ID scheme, normalization). Every artifact stamps `provider_set_hash = sha256(sorted "id@semver" list + precedence_table_version + engine_major)`. Drift comparison across different hashes is invalid by definition → automatic silent re-baseline, never a drift report. This is the permanent fix for "upgraded the tool, got 500 stale flags."

## 7. Worked example A — declarative pattern provider: `http-endpoints/nestjs`

Three files. The `.scm` is the contribution surface (the "15 lines of YAML" story, made honest — ADR-001/D11):

```scheme
;; providers/http-endpoints/nestjs/endpoints.scm
;; Matches @Get('path') / @Post() … methods inside @Controller('prefix') classes
(class_declaration
  (decorator (call_expression
    function: (identifier) @_ctrl (#eq? @_ctrl "Controller")
    arguments: (arguments (string (string_fragment) @prefix)?)))
  body: (class_body
    (method_definition
      (decorator (call_expression
        function: (identifier) @verb (#any-of? @verb "Get" "Post" "Put" "Patch" "Delete")
        arguments: (arguments (string (string_fragment) @route)?)))
      name: (property_identifier) @handler) @method))
```

```yaml
# providers/http-endpoints/nestjs/mapping.yaml
fact_type: endpoint
fact_id: "fact:http-endpoints/{attrs.method} {attrs.path}"
captures:
  attrs.method: {from: "@verb", transform: uppercase}
  attrs.path:   {join: ["@prefix", "@route"], with: "/", normalize: url-path, empty: "/"}
  attrs.handler:{from: "@handler", as: symbol-id}   # engine synthesizes the ds… symbol ID
  provenance.source: {from: "@method", as: span}
notes:
  # class-level @RequestMapping-style joins are expressible because @prefix and @route
  # are captured in one query; cross-FILE composition is NOT — that is the code-tier line.
```

Plus a fixture: `fixtures/nestjs-basic/` (10–30 files) with a golden fact-file snapshot; `docsmith test-provider` runs detect→extract→diff with no agent installed. Contribution cost target: ≤2 hours, one YAML + one query + one fixture. Engine caveat handled centrally (verified): tree-sitter *predicates are implemented by bindings, not the C library* — docsmith ships one pinned query runtime and a conformance list of supported predicates, or community `.scm` files behave differently across environments.

## 8. Worked example B — code provider: `http-endpoints/express`

Why code tier (Compilers, adopted): Express endpoints are *assembled*, not declared — `app.use('/api', ordersRouter)` prefix composition requires cross-statement, cross-file dataflow; `app[method](...)` and table-driven registration are invisible to single-tree queries; declarative recall was estimated ~70%, disqualifying for a flagship artifact.

```yaml
# providers/http-endpoints/express/provider.yaml
id: express
capability: http-endpoints
semver: 2.0.1
tier: code
entry: ./extract              # subprocess; stdin: shard manifest JSON; stdout: FactBatch
detect: {any: [{dependency: "express"}]}
inputs: ["src/**/*.{ts,js,mjs}", "routes/**/*.{ts,js}"]
requires: []                  # no network, no exec
timeout_class: C
emits: [endpoint, extraction-gap]
```

Behavioral contract (design-level): builds per-file tree-sitter ASTs of the declared inputs; identifies router objects and `.use(prefix, router)` mounts; resolves mount chains through the module-graph capability's import edges (a declared read of that capability's fact file — cross-capability reads are declared inputs too); composes path prefixes; emits `endpoint` facts with `path_confidence: exact`. Degradation is honest, per the brief's constraint 6: string-built paths (concatenation, template literals with variables) emit facts with placeholder segments and `path_confidence: partial`; dynamic registration it cannot ground emits `extraction-gap` facts with the reason — never a guessed endpoint, never silence. Recall gate before v0.1 ships: ≥95% on the labeled Express corpus; precision ≥98% (Deliverable 9, E1).

## 9. Cross-capability reads

A provider may declare another capability's resolved fact file as an input (`inputs: ["${facts:module-graph}"]`). The engine schedules capabilities as a DAG (workspace-layout → module-graph → http-endpoints → …), and the cache key incorporates the upstream fact-file digest, so incrementality composes.

**Implemented (v0.2):** a `${facts:<capability>}` token in `inputs` is parsed by the registry loader, implies a `needs` edge (a declared read IS a dependency), and is delivered at run time as an environment variable `KEELDOCS_FACTS_<CAPABILITY>` pointing at the upstream capability's resolved fact file (canonical JSONL, one fact per line), written incrementally as each capability's provider group completes in topo order. Standalone extractor runs (no engine, no env) must degrade honestly - ts-imports/py-imports emit `package: null` and the engine normalizer fills the segment. `timeout_class` is honored (A 10s / B 30s / C 120s / D 60s).

**`inputs` is enforced (v0.3).** On Linux with the `rofs` sandbox tier, the engine builds each provider a VIEW containing exactly its glob matches (minus the security exclusion set) and mounts it over the repository path. A provider therefore CANNOT read a file it did not declare — the file does not exist inside its namespace. Three practical rules follow for anyone writing a manifest. Declare every path the extractor OPENS, not just the ones that define its purpose; the harness's manifest lint fails a shipped provider that declares nothing, but it cannot know what your code reads. Use `**/name` rather than `name` when a manifest may appear at any depth (`**/x` matches both root and nested). And a trailing slash (`.git/`) grants a whole directory, delivered as a bind mount rather than a hardlink farm — use it only when you genuinely need the tree.

**Derived surfaces (R4).** A cross-capability read can carry a provider's ENTIRE input, not just a missing segment. `http-endpoints/supabase-postgrest` reads `${facts:db-schema}` and emits the PostgREST API — every exposed table at `/rest/v1/<relation>`, every exposed function at `/rest/v1/rpc/<name>` — because for a Supabase app that API is written nowhere in the repo: it is a total function of the catalog and `supabase/config.toml [api]`. Two contract consequences follow. First, `confidence` belongs to the DERIVATION, not to the upstream — the catalog arrives INTROSPECTED, but applying a platform routing convention to it is not introspection, so the provider claims the honest lower tier (PARSED). Second, a derived fact has no file and no line, so its provenance names the fact it derives from (`{kind: "postgrest-catalog", from: "fact:db-schema/public.orders"}`) instead of inventing a source location: a source column that says where a fact really came from is honest, a fabricated file path is not.
