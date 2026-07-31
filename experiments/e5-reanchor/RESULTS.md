# E5 — Re-anchoring corpus rerun at power (2026-07-31)

Replays real repo history through the SHIPPED code: ts-imports extraction at
sampled commits, engine-identical `ds` identities, real `git -M60` rename
maps, and `rankSymbolCandidates` from `src/reanchor.js` (run via rank.mjs).
Method: biweekly samples over 12 months; orphan = id present at commit A,
missing at A's successor.

| corpus | sampled commits | survival | orphan events | with candidates | auto fired |
|---|---|---|---|---|---|
| hono | 26 | **99.97%** | 4 | 0 | 0 |
| zod  | 22 | **99.92%** | 26 | 25 (**96.2%**) | 0 |

Findings:

1. **Survival beats the E2 gate** (≥98.5%) with the current extractor —
   overload-amendment and package-segment changes did not regress identity
   stability.
2. **Real orphans are consolidation-dominated**, reconfirming E3's 21/24 at
   n=30: zod's events are file merges (`function.ts` → `schemas.ts`, eight
   symbols, S2-exact/near + S1b) and splits (`to-json-schema.ts` →
   generator/processors). Git registers no rename edge when the target file
   pre-exists, so **S1 cannot fire and the auto gate stays closed — by
   design**. Every one of these correctly surfaced as a ranked PROPOSAL.
3. **The <0.5% false auto-rebind gate: 0 auto-rebinds fired on 30 corpus
   orphan events → 0 false auto-rebinds.** The clean-file-move case that
   auto covers (S1+S2-exact, unique) did not occur in either corpus window;
   it is exercised and verified by the harness's `git mv` scenario instead.
4. One instructive weak-evidence case: `v4/classic/compat.ts/NEVER.` topped
   by `v3/types.ts/NEVER.` on S2-exact alone — a plausible-but-cross-version
   match. Proposal-grade means a human sees exactly this and declines;
   the gate's refusal to auto on one signal is the point.

Verdict: ADR-007's gate moves from honored-by-construction to **measured on
this corpus**; the conservative shape of the pipeline (auto only on
rename+shape, consolidation stays human-choice) matches how real code moves.
