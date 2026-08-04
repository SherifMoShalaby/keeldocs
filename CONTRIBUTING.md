# Contributing to keeldocs

Apache-2.0. **DCO sign-off required (`git commit -s`), no CLA.** Governance: BDFL + CODEOWNERS until v1.0 (see docs/design/07-scope-roadmap.md §4) — the concrete path from contributor to maintainer is "Becoming a maintainer" below, and it is a checkable bar rather than a judgement call.

Found a security issue? **Do not open a PR that quietly fixes it** — a fix in public history is the disclosure. `.github/SECURITY.md` has the private channel.

## The fast path: a declarative (T0) pattern provider

The easy 80% of stack coverage is contributed as data, not code — target ≤2 hours:

1. `providers/<capability>/<your-framework>/provider.yaml` — id, detect predicates (dependency names from manifests — never source parsing in detect), declared input globs, timeout class. See `providers/http-endpoints/nestjs/provider.yaml`.
2. `endpoints.scm` (or equivalent) — a tree-sitter query. Constraints that make T0 safe-by-construction: queries are matched, never evaluated; any regex must be RE2-class (no backtracking); outputs are typed and length-capped.
3. `mapping.yaml` — captures → fact-schema fields. Fact IDs are natural keys (`fact:<capability>/<key>`), never UUIDs.
4. A fixture: `fixtures/<your-framework>-basic/` — a 10–30 file minimal app — plus its golden fact file. **Ground truth before extractor**: enumerate the true facts by hand first.
5. `python3 scripts/harness.py` must pass, including the determinism double-run (same bytes twice).

Code-tier (T1/T2) providers are maintainer-reviewed like core code and sandboxed (subprocess, no network, declared globs only — see docs/design/04-provider-contract.md §5). Community-installable code providers (T2) do not exist until the signing/pinning machinery ships (v0.2+).

## Determinism rules (CI enforces; PRs violating them are rejected)

No floats in confidence or scoring — the lattice is enumerated. No timestamps, wall clock, locale, map-iteration order, or filesystem enumeration order anywhere in extraction/resolution. Canonical JSON (RFC 8785 JCS): sorted keys, `ordered` vs `set` array fields declared in the fact schema. Provider identity goes in provenance, never inside hashed payloads. Extraction failure is `unresolvable`, never drift, never silence — emit `extraction-gap` facts.

## What we will not merge

BRD/PRD generation, hosted anything, auto-merge of generated content, telemetry, per-framework mega-providers, LLM calls inside the engine, row-value sampling into artifacts. Full kill list: docs/design/07-scope-roadmap.md §5.

## Provider certification

Tier C (community: harness-passing, registry-listed, opt-in) → Tier B (verified: ≥2 attested real repos, reviewed) → Tier A (core, FP-budgeted, capped ~10). Time-to-first-merged-provider is a tracked project metric — if review takes more than 7 days, ping the thread.

## Becoming a maintainer

R12 in the risk register names maintainer burnout and bus factor 1 as the most common way an open-source project dies, and the v1.0 gate is written as a hard one: at least two non-founder maintainers with merge rights, **no v1.0 at bus factor 1**. Today `git shortlog -sne --all` shows one human and some bots. A gate that nobody outside the project can see how to satisfy is a wish, not a gate — so the bar is written here, in countable form, and you can check your own progress against it without asking anyone.

**The bar for a scope maintainer.** All five, all checkable from public data:

1. **Six merged PRs**, at least four of them providers or fixtures. A provider PR means the `provider.yaml`, the query, the mapping, its fixture *and* its hand-derived golden — ground truth before extractor, as above. Count yours: `is:pr is:merged author:@me repo:SherifMoShalaby/keeldocs`.
2. **Sustained over at least 120 days** between the first of those merges and the sixth. Six PRs in one weekend is a good weekend. This gate is about the project surviving your busy quarter, which is the only failure R12 actually describes.
3. **Three substantive reviews on PRs that are not yours.** One that found a real problem counts; "LGTM" does not. This is the part that is the actual job — keeping provider review under four hours each is the number R12 tracks, and it is the thing a second maintainer exists to halve.
4. **No unowned breakage.** None of your merged PRs left `main` red, or a determinism golden broken, without you being the one who fixed it. Breaking something is not disqualifying — this repository's history is largely a record of its own mistakes. Leaving it broken is.
5. **One security-relevant read**: you have read `.github/SECURITY.md` and docs/design/04-provider-contract.md §5, and can say what a T0 provider is prevented from doing and by which mechanism.

**What happens when you meet it.** Say so, in a public issue titled `maintainer request: <scope>`, linking the evidence for each of the five. Meeting the bar does not silently grant the commit bit — it obliges a **public, written answer within 14 days**. A refusal has to name which of the five is unmet, or the specific incident it rests on. "Not yet" with no reason attached is not an answer, and you should hold this project to that: the entire thesis here is that a claim carries a receipt. Absent an objection that names one of the five, merge rights on the named scope are granted within those 14 days.

**What a scope maintainer gets.** Merge rights on one named scope through a GitHub team, not across the repository. `providers/` + `fixtures/` is the scope that exists today; `docs/` + `recipes/` and `adapters/` + `skills/` are the other two if someone puts sustained work there. The paths listed in `.github/CODEOWNERS` stay with the founder until the three-person core team forms at v1.0 (design doc 07 §4) — they are the hash and anchor identity core, the security boundary, the anchor spec and the publish path, and they are precisely the places where a mistake is silent rather than loud.

**What no maintainer may ever do: publish.** Releases happen only from a `v*` tag through `.github/workflows/release.yml`, authenticated by npm Trusted Publishing over OIDC. **No npm publish token exists for this package, and none is to be created** — not for convenience, not for a hotfix, not while the founder is unreachable. Its non-existence is a stated security property (`.github/SECURITY.md`) and is the form R9 asked for; a hotfix that would require one is a hotfix that waits.

**Staying one, and stepping down.** Six months with no merged PR, no review and no reply moves you to emeritus: the credit stays, the commit bit goes, and one message brings it back with no re-qualification. This rule exists because the v1.0 gate *counts* maintainers, and two dormant names would satisfy the count while leaving the bus factor at one — a gate that passes vacuously is not a gate, which is a rule this project already applies to its own test fixtures and should not exempt itself from when the subject is people.
