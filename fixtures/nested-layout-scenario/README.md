# nested-layout-scenario

A monorepo whose every extraction input sits below the repository root:

- `apps/api/config/routes.rb` — Rails routes
- `apps/web/next.config.ts` and `apps/web/app` — a Next.js App Router project
- `deploy/docker-compose.yml` — the service topology
- `packages/db/migrations` — the migration chain carrying the RLS policies

Its twin is the root-layout-scenario fixture, which holds the same four inputs
byte for byte at the repository root. The pair is the gate. Every other rails,
next, compose and sql-policies fixture in this tree is root-layout, so before
these existed each of those goldens passed without ever exercising a nested
tree — and on this one, four capabilities reported status ok with an empty fact
set, no gap of any kind, and exit 0.
