# Deliverable 5 — Recipe Schema, with the ERD recipe worked end to end

The panel recommends **ERD** as the fully worked recipe: it is deterministic end-to-end, it is the credibility anchor ("deterministic diagrams are always accurate"), and it exercises every mechanism — facts, anchors, gen regions, prose slots, layering, verification.

## 1. Recipe package layout

```
recipes/erd/
  recipe.yaml        # metadata, required capabilities, fact selection, binding + slot rules
  template.md        # agent-agnostic markdown with region declarations
  verify.yaml        # deterministic post-render checks
  fixtures/          # golden inputs/outputs — the determinism regression suite
```

Deliberate correction to the brief's §3.4 layout: the proposed recipe-owned `extract.*` is **dropped**. Extraction belongs to capability providers; recipes only *select* resolved facts (the `consumes:` block below). A recipe that extracts is a shadow provider — it would bypass the sandbox, the cache, and resolution.

## 2. `recipe.yaml` schema (normative fields)

```yaml
schema_version: 1
id: erd
title: "Data model"
requires:                       # capabilities that must resolve; absence = honest skip
  - capability: db-schema
    min_confidence: PARSED      # lattice floor: below this the recipe refuses to render
output:
  path: "docs/architecture/data-model.md"     # monorepo: per-package via ${pkg}
  layering:                     # the 500-table answer — never one diagram
    l0: domain-overview         # domains as nodes, aggregated FK edges
    l1: per-domain-erd          # cap 25 entities per diagram, attributes on
    l2: per-table-pages         # indexes, checks, enums, triggers, RLS, comments
  diagram:
    syntax: mermaid-erDiagram   # stable syntax; NOT mermaid C4 (experimental — verified)
    fallback: graphviz-svg      # past Mermaid limits (maxTextSize 50k, maxEdges 500)
    emission: canonical         # sorted entities, sorted edges, fixed indent → semantic diffs
binding:
  section_unit: table           # atomic regeneration unit = one table section
  anchor_symbols: ["fact:db-schema/{schema}.{table}"]
  max_symbols_per_section: 8    # a section bound to 40 symbols is permanently stale
  hash_kind: fact               # binds fact-hash, not shape-hash
consumes:                       # per-recipe fact selection (drift scope control, ADR-008)
  fields: [columns, types, pk, fk, unique, nullability, enums, comments]
  not:    [row_counts, sequence_values]        # env state = pure drift noise
slots:
  - {id: "erd.overview",            kind: llm-prose, max_words: 120,
     charter: "what this data model supports, for a new engineer",
     facts: ["fact:db-schema/*"], regenerate_on: fact_hash}
  - {id: "erd.{table}.purpose",     kind: llm-prose, max_words: 60,
     facts: ["fact:db-schema/{schema}.{table}"], regenerate_on: fact_hash}
  - {id: "erd.{table}.notes",       kind: human}   # reserved; never touched by the tool
interview: []                    # ERD needs none; ADR/onboarding recipes declare queues here
```

## 3. `template.md` (excerpt showing all three region kinds)

```markdown
# Data model
<!-- docsmith: id=erd.root recipe=erd@1 binds=fact:db-schema/* hash-kind=fact -->

<!-- docsmith:slot id=erd.overview -->
> ⚠ Inferred draft — not human-reviewed.
(prose written only via `slot-write`; label applied by the tool)
<!-- /docsmith:slot -->

## Domain map
<!-- docsmith:gen id=erd.l0 hash=h1:3fa9c2d41b7e6a05 -->
```mermaid
erDiagram
  BILLING ||--o{ ORDERS : "12 FKs"
  ...canonically emitted...
```
<!-- /docsmith:gen -->

## orders
<!-- docsmith: id=erd.orders recipe=erd@1 binds=fact:db-schema/public.orders hash-kind=fact -->
<!-- docsmith:gen id=erd.orders.columns hash=h1:9c4e17aa20b3f8d1 -->
| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| customer_id | uuid | FK → customers.id, NOT NULL |
<!-- /docsmith:gen -->

<!-- docsmith:slot id=erd.orders.purpose --> … <!-- /docsmith:slot -->

Human prose below this line is never touched by the tool.
```

Anchor rules in force (ADR-006, TW): identity-only, ≤3 lines, one per section, fixed key order, no volatile fields (`last_verified_sha`, `confidence`, `human_edited` all live in the gitignored index; human edits are detected via git blame). Heading stability: headings derive from stable object names only — "orders", never "12 Endpoints"; section order by stable sort key; renames keep a one-release alias line so deep links don't 404.

## 4. Pipeline

`db-schema` resolved facts (ADR-005: declared sources canonical; per-dialect normalization spec applied) → recipe fact selection (`consumes`) → domain assignment (explicit config wins; else deterministic FK-connected-components + name-prefix heuristic — no stochastic community detection — emitted as a *draft* config the human commits) → canonical rendering into gen regions, row-keyed tables (patches are row-level inserts/updates/deletes) → prose slots filled by the host agent through `slot-write` (validated, labeled, prose-stability-gated) → redaction barrier → write.

Cardinality is derived, not guessed: FK + nullability + uniqueness; N:M via pure-join-table detection (PK ⊆ FKs). Multi-schema databases qualify names (`schema.table`) and split L1 diagrams per schema. If a live comparison ran (`check --live`), a **Schema drift** section renders the disagreement facts (`pending-migration` / `out-of-band-drift` / `belief-mismatch`) — tier-1, because the disagreement itself is deterministically true.

## 5. `verify.yaml` — deterministic post-render checks

```yaml
checks:
  - gen_hashes_match          # recompute each gen region's fact-hash; tamper detection
  - all_fk_targets_exist      # every FK edge in the diagram resolves to a rendered entity
  - diagram_within_limits     # entity count ≤25 per L1; else layering violation
  - anchors_resolve           # every bound fact ID exists in resolved facts
  - no_env_state              # row counts / sequence values must not appear
  - prose_slots_labeled       # every llm-prose region carries draft/approved provenance
  - prose_stability           # prose changed ⇒ bound fact-hash changed (anti-thrash gate)
  - redaction_clean           # gitleaks ruleset + entropy scan pass, version recorded
```

## 6. The v0.1 recipe set and taxonomy verdicts (TW, adopted)

| Recipe | Verdict | Diátaxis | Notes |
|---|---|---|---|
| **system-map** | deterministic-mostly | reference | C4-container *semantics*, stable Mermaid flowchart syntax; unresolved edges dashed + labeled; package/service/external nodes distinguished |
| **erd** | deterministic | reference | this document |
| **endpoint-inventory** | deterministic | reference | inventory/map, not an OpenAPI competitor (non-goal preserved) |
| **config-reference** | deterministic | reference | names/types/read-sites only — the value field does not exist in the schema; fastest-rotting doc type, highest drift value |
| **adr** (via `new adr`) | interview-driven capture | explanation | template + capture flow; git/PR mining yields *candidates* only, confirm/deny, never asserted |
| module guide | hybrid | reference | v0.2 — deterministic skeleton + one labeled prose slot |
| onboarding guide | hybrid | tutorial | v0.2 — machine *verifies* human tutorials (commands exist, versions match); never authors sequencing |
| C4 context | interview-driven | explanation | deferred; external actors are intent |
| C4 component | **cut** | — | component boundaries are human abstractions; clusters masquerading as components is inference presented as structure |
| runbook (generation) | **cut** | — | remediation knowledge isn't in code; a capture template may ship later |
| data-flow | hybrid | reference | v0.3 with async-messaging capability |
| BRD / PRD | **cut permanently** | — | category error: intent precedes code (TW veto, unanimous ballot) |

The docs tree (shallow, stable slugs): `docs/README.md` (index + freshness), `docs/architecture/{system-map,data-model}.md`, `docs/reference/{endpoints,configuration}.md`, `docs/decisions/NNNN-slug.md`, `docs/guides/` — **the trust firewall: human-owned; the machine verifies facts there but never writes prose there.**
