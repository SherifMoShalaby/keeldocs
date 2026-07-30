# Deliverable 6 — Anchor Specification

Covers: format grammar, the two ID namespaces, hashing and normalization, the re-anchoring pipeline with accuracy limits, orphan states, the decisions journal, and merge behavior. This replaces the brief's §3.3 example, which the panel found structurally wrong in three ways: it conflates identity with content, packs a collision-prone 24-bit hash into the ID, and stores volatile state in committed doc bodies.

## 1. Format

One anchor per section, immediately above or below the heading, invisible when rendered:

```html
<!-- keeldocs: id=erd.orders recipe=erd@1 binds=fact:db-schema/public.orders hash-kind=fact -->
```

Gen regions and slots (see Deliverable 5) use paired markers:

```html
<!-- keeldocs:gen id=erd.orders.columns hash=h1:9c4e17aa20b3f8d1 --> … <!-- /keeldocs:gen -->
<!-- keeldocs:slot id=erd.orders.purpose --> … <!-- /keeldocs:slot -->
```

Grammar rules (schema-strict — also an injection defense, ADR-013): fixed key set (`id`, `recipe`, `binds`, `hash-kind`), fixed key order, ID/enum/hash-shaped values only, per-field length caps (~200 chars), sorted multi-value fields, unknown keys rejected, **no free-text fields ever**. One wildcard form is permitted: a trailing `/*` in `binds` for index/overview sections (`binds=fact:db-schema/*`), meaning drift fires when any fact under the prefix changes. A malformed anchor is quarantined as inert data and degrades to re-anchoring — a human mangling an anchor without the tool installed must never corrupt unrecoverable state (DX veto; Swimm's fragility lesson).

**What is deliberately absent** (moved to the gitignored index; TW's C2): `last_verified_sha`, `confidence`, `human_edited`, timestamps, run counters. With volatile state out, anchors change only when *bindings* change — sync stops touching every section, which removes the diff-noise and merge-conflict class wholesale.

## 2. Identity — two namespaces (never conflated)

**Code symbols** — SCIP-grammar-shaped syntactic IDs emitted from tree-sitter (ADR-007):

```
ds <pkg> <version|.> <module-descriptors><Decl>#<member>(<disamb>).
ds npm @app/api . src/orders/service/OrderService#submit(2).
```

Package comes from workspace-layout (cross-language monorepo collision-freedom); module descriptor is the relative file path for file-as-module languages, the declared namespace for Java/C#; overloads disambiguate by arity then a 4-hex FNV of normalized parameter types. Anchoring to document-scoped locals is forbidden. Duplicate declarations (partials, open classes) bind one ID to a site-set digest; drift = set change. Generated code redirects anchors to its source of truth (`.prisma`, `.proto`); generated trees are excluded by default.

**Non-code facts** — provider-agnostic natural keys:

```
fact:db-schema/public.orders.customer_id   fact:http-endpoints/GET /orders/{id}   fact:config-surface/DATABASE_URL
```

The form is always `fact:<full-capability-id>/<natural-key>` — capability ids are never abbreviated, and db keys are always schema-qualified, so the namespace has exactly one spelling.

Natural keys mean switching `migrations → live-connection`, or upgrading a provider, preserves identity — provider identity lives in provenance, outside anything hashed (the Compilers engineer's "provider contamination" fix).

## 3. Hashing and normalization (drift = fact-hash change, ADR-008)

- Canonical serialization: RFC 8785 JCS (lexicographic key order, no insignificant whitespace, canonical numbers — don't invent canonicalization).
- Arrays: each fact-schema field is declared `ordered` (parameter lists, SQL column order — semantically ordered) or `set` (sorted by natural key). Blanket sorting is a semantic bug.
- Hash: SHA-256; display truncated to 64 bits (16 hex) — collision probability ~10⁻¹⁰ at 50k facts (the brief's 6-hex example birthday-collides at ~4k); full digest in the index.
- Versioning: algorithm version embedded in the value (`h1:…`). Cross-version comparison is **invalid by definition** → silent re-baseline (recompute + rewrite anchors, report zero drift). A normalization upgrade must never render as repo-wide drift.
- Inside the hashed payload: fact attrs + fact-type `schema_version`. Outside it: provider name/version, spans, blob SHAs, engine version (provenance).
- `shape_hash` fallback for prose anchored to a symbol with no structured fact: normalized declaration-AST hash (comments/docstrings excluded unless the anchor opts in). Each anchor declares `hash-kind: fact | shape`.

Resulting behavior table: formatting-only change → same AST → same facts → no drift. Comment change → no drift unless a recipe declared comment consumption. Docstring change → drifts only recipes that consume docstrings (endpoint inventory yes, ERD no) — per-recipe fact selection, not a global toggle.

**The three named normalizations, defined:**
- *Per-dialect schema canonicalization* (ADR-005's "silent noise generator" fix): a versioned mapping table per dialect, golden-file tested — type aliases folded to one canonical grammar (`character varying(255)` and Prisma `String @db.VarChar(255)` → `varchar(255)`; `int4` → `integer`), identifier case folded per the dialect's quoting rules, default expressions parsed and re-emitted canonically (`now()` ≡ `CURRENT_TIMESTAMP` per dialect table), constraint/index identity = `(kind, table, ordered column list, predicate)` rather than the auto-generated name. Drift compares canonical forms only.
- *`shape_hash`* = SHA-256 over the JCS serialization of `{kind, name, parent descriptor, params: [{type}] (names stripped), return_type, modifiers}` extracted from the tree-sitter declaration node; comments/docstrings excluded unless the anchor opts in.
- *S2 "normalized signature"* (re-anchoring) = the same tuple minus `name` — which is exactly what makes it a rename detector.

## 4. Re-anchoring pipeline (runs old-index → new-index on each `check`)

- **S0** exact ID match → bound (the overwhelming majority of commits).
- **S1** file-level: git rename detection (similarity ≥60%; git's default is 50 — verified) rewrites module-descriptor prefixes; retry exact.
- **S2** signature match within package: identical normalized signature (param types + return + parent), name changed.
- **S3** body similarity across package: token 5-gram shingle Jaccard over comment-stripped, identifier-preserved streams.

**Rebind policy.** Auto-rebind (metadata-only, logged, reversible) requires exactly one candidate AND two independent agreeing signals: S1 + body ≥0.95, or S2 + body ≥0.85. S3 alone never auto-rebinds: ≥0.90 with ≥0.15 margin over the runner-up → proposal; 0.75–0.90 → listed candidate; <0.75 → orphan. Accepted proposals are human decisions → journal (so fresh clones never re-propose adjudicated cases).

**Accuracy limits, stated as testable gates** (validated on a corpus of synthetic refactors + mined real renames — Deliverable 9, E3): pure file move ≥99% correct; in-file rename, body unchanged ≥97%; move+rename+≤20%-token edit ≥90% correct top-1; extract-method/split: never auto, ≥80% correct top-1 proposal; **false auto-rebind <0.5% — the go/no-go**, because a silently wrong rebind is strictly worse than an orphan.

## 5. Orphan-state taxonomy (disjoint)

| State | Definition | Behavior |
|---|---|---|
| stale | ID resolves; bound hash mismatch | sync candidate |
| rebound | identity migrated per §4 | not an orphan; logged |
| dead | no resolution; no candidate ≥0.75; deletion confirmed via `git log --diff-filter=D` | propose section removal |
| intentionally-removed | dead + intent evidence (commit ref or explicit answer) | journal tombstone; never re-prompts |
| unresolvable | extractor/parse failure | tooling health, **never drift** (fail closed) |

## 6. The decisions journal (companion committed artifact — D1 synthesis, ADR-006)

`.keeldocs/decisions.jsonl` — append-only, human decisions only: tombstones, rejections, snoozes, waivers, adjudicated rebinds.

```json
{"id":"sha256:…","at":"2026-07-29T10:02:11Z","actor":"sherif","type":"tombstone",
 "target":"ds npm @app/api . src/legacy/mailer/Mailer#send(1).","evidence":"commit 8f21ac9"}
```

Contract: durable IDs only (never volatile hashes); JCS-canonical, one object per line; `merge=union` via `.gitattributes` written by `init` — therefore entries are self-contained, idempotent, order-independent; revocation by new entry (never edit/delete a line); reader semantics = set-union, latest-entry-wins per ID (ordered by the `at` field *in the data*, not by wall clock); snoozes expire at read time (no mutation); **read-only in CI, enforced by the tool** (only interactive commands with explicit human confirmation append); no facts or hashes ever; compaction only via explicit `keeldocs gc` producing a reviewable PR.

Clock rule (consistency with the determinism boundary): expiry-style policy (snooze windows, proposal aging) is evaluated against wall clock locally but against the **HEAD commit timestamp in CI**, and always reported in a separate policy section — so `check --ci` is a pure function of (SHA, committed journal) and re-runs reproduce.

## 7. Merge conflicts and coexistence rules

Anchors: compact, one per section, deterministically ordered keys, sorted arrays — conflicts require two PRs editing the same section's *bindings*, which is a real semantic conflict a human should see. Journal: union-merge by construction. Index/facts/graph: gitignored, no merge surface. Machine writes only inside `gen` regions; a human edit *inside* a gen region (detected via blame) flips the section to takeover mode — sync proposes diffs but stops auto-patching (constraint 7 made mechanical). Where fact and human prose contradict, sync emits a conflict note ("this paragraph assumes X; code now does Y"), never a rewrite.

## 8. Versioning of this spec

The anchor grammar carries an implicit major version via the `keeldocs:` prefix (`keeldocs2:` if ever needed); the spec is published as a versioned document in a separate repo (PM) so third parties can implement it without depending on the tool; frozen at 1.0 with a written migration policy as a v1.0 release gate.

## 9. Engine implementation addenda (v0.1, 2026-07-30)

Three clarifications the first engine implementation forced, now normative:

1. **Tag grammar.** `keeldocs:` (bare colon) opens a section anchor; `keeldocs:gen` / `keeldocs:slot` open regions; `/keeldocs:gen` / `/keeldocs:slot` close them. Unbalanced or unclosed markers quarantine.
2. **Gen-region fields.** `gen` markers carry `id`, optional `binds` (defaults to the longest-dot-prefix anchor's binds), `hash` (the fact-hash the content was rendered from - the committed drift baseline), and optional `content` (hash of the normalized body - CRLF folded, trailing whitespace stripped, outer blank lines dropped). `content` mismatch = **tampered** (hand-edited generated content, ADR-009); `hash` mismatch = **stale**; tamper is checked first. Multi-bind and wildcard sets hash as the aggregate: JCS of sorted `[id, fullHash]` pairs.
3. **Value parsing.** Endpoint natural keys contain spaces ("GET /orders"), so marker values run from `<key>=` until the next token from that marker's fixed key set or end of marker; multiple binds separate with `,`. An attempted unknown `key=` inside a marker quarantines the whole marker (schema-strictness is the injection defense).

Policy clock rule restated for implementers: fact extraction and drift comparison never read the clock; snooze expiry evaluates against wall clock locally and the HEAD commit timestamp under `--ci`, and reports carry no timestamps - CI output is a pure function of (SHA, committed journal).

## 10. Prose slots (v0.1, 2026-07-30)

Slot markers carry `id`, optional `binds`, optional numeric `max-words`, and - once
filled - `hash`, the fact state the prose was written against, set by the TOOL at
`slot-write` time. Unfilled slots are silent in drift. A filled slot whose bound
fact-hash no longer matches is **stale**, and its sync proposal is `reprose`:
deliberately not machine-appliable - the engine never writes prose; the agent
rewrites it through `slot-write`, whose gates are the LLM boundary (ADR-009):

1. unknown-slot (slots are declared by templates, never invented by the model)
2. marker-injection (payload may not contain keeldocs markers)
3. word-cap (`max-words`, default 150)
4. unresolved-citations (every backticked identifier must match an extracted fact -
   hallucinated identifiers are rejected, not softened)
5. zero-citations (prose must cite at least one known entity so it stays falsifiable)
6. numbers-in-prose (digits outside backticks rot silently; counts belong in gen regions)
7. prose-stability (rewording while bound facts are unchanged is diff churn - rejected)

On pass, the tool - never the model - prepends the visible draft label
(`> ⚠ Inferred draft - not human-reviewed.`) and records `hash`. `approve <doc> <slot>`
replaces the label with `> ✎ Reviewed by <actor>, <sha>.` - attestation, not
derivation: approval never renders as machine-"verified". Both `slot-write` and
`approve` are disabled in CI; prose and attestations happen locally, under review.
