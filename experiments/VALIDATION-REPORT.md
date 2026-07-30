# keeldocs — Validation Report (E1–E4 mini-runs + name lock)

Date: 2026-07-30. Scope honesty up front: these are **directional mini-runs** executed by autonomous agents against real OSS repos — small n, single labeler per experiment, mainstream well-maintained repos. They are sized to *falsify cheaply*, not to certify. Nothing was falsified; two design amendments and one naming near-miss came out. Full-corpus versions become CI infrastructure during the build (per Deliverable 9/10).

## 0. Name lock — "undrift" died on contact; shipped name is **keeldocs**

The sweep did exactly what R14 exists for. "undrift" was free on npm and PyPI — but the GitHub check found an **existing org actively shipping a CLI named `undrift`** (Undrift/Tether marketing CRM; own Homebrew tap `undrift/homebrew-tap` with formulas for `undrift` and a sibling `drift`, updated 2026-07-29). A live same-name CLI from an operating company is disqualifying regardless of registry availability. "veridocs" also fell (GitHub org exists, empty).

**keeldocs** (the keel is what keeps a ship from drifting) is verified free on **npm, PyPI, and GitHub** as of 2026-07-30. Still-free fallbacks: anchordocs, docanchor, moordocs, steadydocs. A general web search found no software product named keeldocs; formal trademark search (USPTO/EUIPO, class 9/42) remains a pre-announce task.

**Action needed from you (accounts required — kit is ready):** `keeldocs-namelock/` contains publish-ready placeholder packages for npm and PyPI plus `PUBLISH.md` (npm publish, twine upload, GitHub org creation). Registries move — the undrift near-miss is the proof — so publish promptly.

## 1. E1 — Extraction recall/precision (the two-tier provider thesis)

Repos: brocoders/nestjs-boilerplate, lujakob/nestjs-realworld-example-app (NestJS); gothinkster/node-express-realworld-example-app, sahat/hackathon-starter (Express); realworld's schema.prisma (Prisma). Ground truth hand-labeled *before* extractor runs.

| Extractor | n (truth) | Recall | Precision | Gate | Verdict |
|---|---|---|---|---|---|
| NestJS declarative (tree-sitter query) | 45 | 100% | 100% | ≥90% / ≥98% | **PASS** (precision underpowered at n=45; rule-of-3 CI floor 93.3%) |
| Express code-tier (mount-graph resolution) | 88 | 100% | 100% | ≥95% / ≥98% | **PASS** (precision underpowered; CI floor 96.6%) |
| Express naive declarative (control) | 88 | 78.4% | 78.4% | design predicted ~70% | **Prediction confirmed directionally** — and worse than predicted where it matters: 5% recall on the router-structured app vs 100% on the flat one |
| Prisma schema parse | 35 fields, 8 relations | — | — | ~100% | 35/35 fields, 8/8 relations correct (incl. self-relation); 1 attribute-text fidelity bug in the prototype (comment-stripping truncated a URL default) |

Readout: **the two-tier thesis holds exactly as designed.** Declarative-only Express collapses precisely on cross-file mount chains (`app.use(routes)` → `Router().use('/api', api)` → chained mounts); the code-tier resolver recovers 100% there. NestJS needs only the query tier — but note the object-form `@Controller({path, version})` edge would have sunk a naive string-only matcher (23/24 endpoints in one repo). One true dynamic-registration loop (hackathon-starter's static-lib `for` loop) was correctly flagged-not-guessed. Precision hazards (`app.get('port')` config getter, `passport.use`, `express.static` mounts) were all correctly rejected.

## 2. E2 — Fact-hash stability over 12 months of real history

Repos: honojs/hono, colinhacks/zod; 13 monthly snapshots (2025-08 → 2026-07); facts = exported top-level declarations with normalized signatures via tree-sitter; hash = SHA-256 of canonical JSON.

| Repo | Symbols m0→m12 | Churn/mo avg | False drift (judged) | Anchor survival | Gates (≥95% / <10%) |
|---|---|---|---|---|---|
| hono | 579→642 | 1.00% | 0/13 | **99.5%** | **PASS / PASS** |
| zod | 1375→1565 | 0.63% | 1/26 combined = **3.8%** | **98.5%** | **PASS / PASS** |

Orphan autopsy (all 24 classified): **21/24 were cross-file moves/consolidations, 2 in-place renames, 1 genuine deletion — and git rename detection (S1) never fired once all year** (moves into *pre-existing* files are invisible to it). The one false drift: an overloaded function whose non-callable implementation signature churned while its public overloads were byte-identical.

## 3. E3 — Re-anchoring accuracy → **UNDERPOWERED, with a design-relevant finding**

Strict S2 (identical normalized signature, name changed) produced **zero candidates** in 24 repo-month pairs — so the <0.5% false auto-rebind gate is untestable at this n (0 rebinds, 0 wrong). More importantly: on the only 2 real renames found, strict S2 scored **0/2** — both renames co-changed the signature in the same commit. A relaxed probe (unique candidate + body similarity) scored 2/2 with 0 wrong. And every one of zod's 21 cross-file moves had exactly one same-name candidate repo-wide — name, not signature, was the strong re-anchor key.

**ADR-007 amended accordingly** (already applied to the design docs): S2 relaxes to near-identical signature with body-sim + unique-candidate corroboration; a new S1b move-matcher (same name + unique candidate + corroboration, proposal-grade) covers consolidations git can't see; overload implementation signatures are excluded from the fact hash. The two-signal auto-rebind rule and the 0.5% gate stand; the full E3 corpus (synthetic + mined, per-commit granularity) runs during the build.

## 4. E4 — Doc lie-detector precision (the wow's engine)

Repos: sahat/hackathon-starter, thedevs-network/kutt, gothinkster/node-express-realworld-example-app. 221 doc claims checked across five deterministic check classes (file paths, npm scripts, env vars, internal links, route examples).

**Precision: 2/2 findings true = 100% → PASS (weakly powered, n=2).** The receipts are exactly the demo material the design wants:
- **kutt** README documents env var `OIDC_POMPT` — a typo; grep across 202 files finds zero reads. The real code reads `OIDC_PROMPT` (`server/env.js:67`), meaning a user following the README configures a variable that is silently ignored.
- **hackathon-starter** `.env.example` ships `OPENAI_API_KEY=sk-…` — read nowhere; `git log -S` shows the code was added 2025-04-19 and removed 2026-05-22, leaving the env entry orphaned for 14 months. The repo's own AGENTS.md independently warns about it — the detector rediscovered a known lie from first principles.
- The realworld app's README produced **zero findings and is simply accurate** — correctly reporting nothing is the noise-SLO behavior working.

Two operational lessons, both design-confirming: (1) **suppression is where precision comes from** — untuned, raw precision would have been ~6% (30 FP candidates: tutorial "create this file" instructions, tree diagrams, placeholders, docker-secrets dynamic env construction); the production detector needs the suppression taxonomy as a first-class, tested component. (2) **Well-maintained OSS repos are lie-poor** — the wow must be demonstrated on users' *own* brownfield repos, which is what `e4-protocol.md` (included) specifies for the 10-user test: ≥60% commit the starter docs, ≥8/10 verify a finding in under a minute, p50 time-to-wow <5 min.

## 5. Verdict against the four load-bearing assumptions

| Assumption | Result |
|---|---|
| Extractability (two-tier providers) | **Survives** — gates passed; tier split confirmed at its exact predicted failure line |
| Low-noise drift (fact-hash) | **Survives** — 3.8% false drift, ~1%/mo churn, survival ≥98.5% on both repos |
| Safe rebinding | **Underpowered, amended** — the strict-S2 design was wrong in a fixable way; amendment applied; full corpus at build time is now the highest-priority remaining experiment |
| Zero-LLM wow | **Engine validated** (100% finding precision, compelling receipts); the *wow itself* still needs the 10-user brownfield test — OSS repos can't provide it |

**Recommendation: proceed to build v0.1.** Nothing was falsified; the one design error found (strict S2) was caught for the price of ~40 minutes of agent time, which is the validate-first bet paying out. Carry E1/E2 harnesses into CI as the permanent regression suite, run full E3 during the anchor-engine build, and schedule the E4 user test for the first beta.

## Artifacts

`keeldocs-validation/e1/` (extractors, ground truth, results, failure notes) · `e23/` (snapshot pipeline, per-month facts, judgments) · `e4/` (detector, per-repo findings with receipts, user-test protocol) · `keeldocs-namelock/` (publish-ready npm + PyPI placeholders, PUBLISH.md). All repo clones deleted after measurement; every number above traces to a script and raw JSON in these folders.
