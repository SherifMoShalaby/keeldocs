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

Grammar rules (schema-strict — also an injection defense, ADR-013): fixed key set (`id`, `recipe`, `binds`, `hash-kind`), fixed key order, ID/enum/hash-shaped values only, per-field length caps (~200 chars), sorted multi-value fields, unknown keys rejected, **no free-text fields ever**. Two set-valued forms are permitted in `binds`, both trailing-`*` so a reader can see at a glance that the value names a SET. A **prefix wildcard** means PREFIX match - `binds=fact:db-schema/*` (whole capability, for index/overview sections) and `binds=fact:db-schema/policy.*` (an id-prefix family) are the same mechanism; drift fires when any fact under the prefix changes. A **package scope** narrows the same idea to one workspace member - `binds=pkg:@acme/web#http-endpoints/*` - so that editing one package leaves the other packages' documents byte-identical. A malformed anchor is quarantined as inert data and degrades to re-anchoring — a human mangling an anchor without the tool installed must never corrupt unrecoverable state (DX veto; Swimm's fragility lesson).

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

## 11. Compatibility policy (v0.3, 2026-08-05) — what has to be true before 1.0 freezes

This section exists because the grammar in §1 is closed and §8 promises to freeze
it. A closed grammar has one well-known cost: a document written by a newer
engine is refused by an older one. That cost is acceptable here — the values in
these markers are hashes, and a reader that quietly ignores what it does not
understand is a drift detector that has stopped detecting — but it is only
acceptable if refusal is loud, named, and bounded. Three things were true of the
shipped parser when this policy was written, and each had to be fixed before a
freeze could honestly promise anything.

**Refusal now fails closed and reaches the user.** A marker the parser could not
read was recorded in the spilled report and appeared in neither the envelope, the
summary, nor the exit code, so an engine that had stopped checking a section
still printed `CLEAN` and exited zero. Refused markers are now named in the
envelope by document, line and reason; `check` exits 1 with code `UNREADABLE`,
and that code outranks `DRIFT_FOUND`, because a drift count computed over a tree
the engine cannot fully read is a number it should decline to headline. The
marker's text is still preserved byte for byte and nothing is derived from it —
refusal remains inert, per §1's rule that a human mangling an anchor without the
tool installed must never corrupt unrecoverable state.

**A marker must be lexable without knowing the key set.** The guard that catches
an unknown key matched names of the form `[A-Za-z][A-Za-z0-9-]*` only, so a name
containing `_`, `.` or `:`, or beginning with a digit, was not recognised as an
attempted key and was absorbed into the preceding value instead. `binds` then
carried it, and the text reached the `--json` envelope an agent parses. §1's "no
free-text fields ever" and ADR-013's claim that schema-strictness is an injection
defense were both false at exactly the point where they were load-bearing. The
guard's name class is now wider than any name a key could have, so an attempted
key is refused whatever it is spelled — while values that legitimately contain
`=`, such as a route with a query string, still parse.

**A binding that names a scope which does not exist is dead, not empty.** A
wildcard matching nothing is ordinarily fine: `fact:db-schema/*` in a repository
with no database documents the empty set, which is vacuous but true. A package
scope is not that. `binds=pkg:@acme/gone#http-endpoints/*` names a workspace
member that does not exist, and because the empty set hashes to a constant — the
same value in every repository, one that no change to anyone's code can ever move
— such a section matched its recorded hash on every run and reported clean in
perpetuity. A package scope whose package is absent from workspace-layout is now
a missing binding, which is `dead`, which already carries re-anchoring candidates.

### Grammar generations

The key sets in §1, §9 and §10 are **grammar generation 1**. Growing any of them
produces generation 2, and so on. A marker declares the generation it requires
with one key, `needs`, whose value is one to three digits and which must be the
marker's first key when present. A marker with no `needs` requires generation 1,
so every document any 0.x keeldocs has written is already a conforming
generation-1 document and no rewrite is owed to it. A generation-1 engine parses
`needs` and never emits it.

The generation gate is evaluated before the vocabulary check and before every
value validator, so that a marker from the future is refused as
`needs-newer-reader:<N>` rather than as `unknown-key`. That distinction is the
whole mechanism: without it, a user whose teammate has a newer keeldocs is told
their anchor is malformed, which is both wrong and unactionable.

New keys are registered in this document under their final names before any
engine emits them. There is no experimental band and no vendor prefix, because in
every format that shipped one the successful experiments acquired a permanent
second name and kept it — and these markers live in users' git history, where a
rename cannot be redeployed. A generation bump is a coordinated upgrade for
everyone who runs the tool against a repository, and the expense of that
coordination is deliberate: it is what keeps the key set small.

### Two claims in §1 are withdrawn rather than frozen

The parser has never enforced either, and publishing them would bind implementers
to behaviour the reference implementation does not have. **Key order is not
enforced** except for `needs`; `hash-kind=fact binds=…` parses exactly as
`binds=… hash-kind=fact` does. And **multi-value fields are not required to be
sorted**: resolution sorts and deduplicates before hashing, so order is
unobservable. Both are stated here rather than quietly dropped, because a
specification that describes a stricter parser than the one that ships is the
same defect as documentation that describes code it does not match.
