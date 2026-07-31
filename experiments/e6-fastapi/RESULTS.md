# E6 — FastAPI extractor on real code (2026-07-31)

Corpus: `fastapi/full-stack-fastapi-template` backend (the canonical
production template). Ground truth: 23 route registrations counted from
decorators across `app/api/routes/*` (items 5, login 5, private 1, users 10,
utils 2), mounted through TWO include levels
(`routes/*.router` → `api_router` → `app`).

| metric | result |
|---|---|
| registration recall | **23/23 (100%)** |
| method+path precision (modulo declared gap) | **23/23 (100%)** |
| non-literal handling | `include_router(api_router, prefix=settings.API_V1_STR)` → **1 honest gap warning, no guessed prefix** |

Notes: the runtime `/api/v1` prefix is absent from emitted paths BECAUSE it
is non-literal — surfaced as an extraction-gap warning per constraint 6
(never fabricate), identical to the Express provider's discipline. The
conditionally-included `private.router` (local-environment guard) is
extracted; static extraction reports registered surface, not runtime
reachability. Matches E1's bar (Express 100/100) on first contact with
real FastAPI code.
