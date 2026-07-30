# undrift — Living-Documentation Tool, Panel Design

Design produced by a nine-expert panel (each expert an independent agent with its own web verification), a rebuttal round on the contested calls, and chair synthesis. **Design only — no implementation.** Date: 2026-07-29; owner decisions applied 2026-07-30.

> **Name resolved: keeldocs** (verified free on npm, PyPI **and** GitHub, 2026-07-30). The first pick, "undrift", was killed during the lock step: an existing company (Undrift/Tether CRM) actively ships a CLI named `undrift` via its own Homebrew tap — exactly the collision the sweep exists to catch. "veridocs" also fell (GitHub org exists). The body of these documents keeps the working codename "docsmith" — every `docsmith` token reads as `keeldocs` at scaffold time; the rename is mechanical.

## Read in this order

| File | Deliverable (brief §5) |
|---|---|
| [01-panel-transcript.md](01-panel-transcript.md) | 1 — concerns, vetoes, ballot, 12 disagreements argued & resolved, corrections to the brief |
| [02-architecture.md](02-architecture.md) | 2 — components, data flow, determinism boundary, layered graph justification |
| [03-adrs.md](03-adrs.md) | 3 — ADR-001…013 (context → options → decision → consequences) |
| [04-provider-contract.md](04-provider-contract.md) | 4 — provider interface + worked pattern provider (NestJS) and code provider (Express) |
| [05-recipe-schema.md](05-recipe-schema.md) | 5 — recipe schema + ERD recipe worked end-to-end + doc-taxonomy verdicts |
| [06-anchor-spec.md](06-anchor-spec.md) | 6 — anchor grammar, hashing/normalization, re-anchoring, journal |
| [07-scope-roadmap.md](07-scope-roadmap.md) | 7 & 8 — v0.1 scope (wow resolved) + phased roadmap with go/no-go gates |
| [08-risks-experiments.md](08-risks-experiments.md) | 9 & 10 — risk register + validation experiments, priority-ordered |
| [09-open-questions.md](09-open-questions.md) | 11 — open questions, assumption register, verified sources |

## The ten headline decisions

1. **Option B holds, refined:** orthogonal capabilities × providers; the declarative tier is tree-sitter queries + a capture-mapping manifest (not "15 lines of YAML"); dynamic-registration frameworks (Express) are code providers from day one.
2. **Determinism is enforced, not hoped:** enumerated confidence lattice (no floats), versioned precedence, conflicts as first-class facts, byte-identical output cross-OS as a CI golden test; nothing in the `check` path may call an LLM or the network.
3. **Drift = extracted-fact-hash change** (never source bytes), with versioned hash algorithms and silent re-baselining — the structural fix for false-drift noise.
4. **Layered store, nothing derived committed:** JSONL fact files + SQLite index, both gitignored; committed = docs+anchors, config, and an append-only **human-decisions journal** (tombstones/rejections/snoozes/waivers; `merge=union`; read-only in CI) — the synthesis both opposing experts accepted.
5. **Anchors are identity-only** (≤3 lines; volatile state in the index; human edits detected via git blame); symbol IDs use the SCIP *grammar* without the SCIP *toolchain*; re-anchoring is evidence-gated with false auto-rebind <0.5% as a hard gate.
6. **db-schema is a three-claim model:** repo-declared schema is canonical; live is a labeled observation; their disagreement is itself a published, verified fact ("out-of-band drift"). Live in v0.1: Postgres/Supabase only, `--live`, off the critical path; the Supabase RLS access-matrix is the wedge differentiator.
7. **LLM boundary is mechanical:** the engine contains zero model-calling code; the host agent writes prose only through the `slot-write` validator; labels are applied by the tool; a prose-stability gate rejects rewording without fact change.
8. **Distribution: deterministic CLI spine + Agent Skills open standard + thin generated adapters** (Claude Code, Codex, Cursor first-class); no MCP through v0.2.
9. **The wow is the doc lie-detector** — zero-LLM `init` that catches the repo's *existing* docs lying, with receipts, then commits anchored starter artifacts; retention is the agent-side loop (ambient grounding + same-branch post-edit nudge) under a hard noise SLO with accept-rate self-throttling. Coverage is a ratchet, never a gate.
10. **Ruthless v0.1:** TS/JS + language-agnostic providers, 7 capabilities, 4 recipes + ADR capture, 4 commands (`init`/`check`/`sync`/`new`); BRD/PRD and `/docs:ask` cut permanently; auth-model cut until determinism is proven; Python is the v0.2 headline; portfolio (Backstage-projection, standards-embedding) is v0.3.

**Before writing any code:** run experiments E1–E4 (~3 weeks — extraction recall, history-replay noise, re-anchoring accuracy, lie-detector wow test). They can falsify the four assumptions the design stands on; if one fails, redesign rather than adjust the threshold.

**Owner decisions (2026-07-30):** name = **keeldocs** (initial pick "undrift" invalidated by an active same-name CLI, re-picked same day); diagnostic command = `check`; portfolio stays v0.3-deferred; Mongo = ODM-models only; Windows = reduced-trust-documented; cross-repo DB identity = user-declared resource IDs; coverage denominator = concrete surfaces only (endpoints, tables, env vars, services); interview cap = 5 cards/batch. Details in 09-open-questions.md.
