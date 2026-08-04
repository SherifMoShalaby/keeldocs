# Configuration
<!-- keeldocs: id=config.reference recipe=config-reference@1 binds=fact:config-surface/* hash-kind=fact -->

<!-- keeldocs:slot id=config.overview binds=fact:config-surface/* max-words=120 -->
<!-- /keeldocs:slot -->

<!-- keeldocs:gen id=config.reference.table hash=h1:06d6aee65ffb6a1c content=h1:a1004a51bab3f75b -->
| variable | read in code | in .env.example | read sites |
|---|---|---|---|
| `API_BASE_URL` | yes | no | fixtures/flutter-scenario/lib/main.dart:3 |
| `APP_DEBUG` | yes | no | fixtures/python-scenario/app/main.py:10 |
| `APP_PORT` | yes | no | fixtures/init-scenario/app.js:8, tests/init.test.js:32 |
| `APP_REGION` | yes | no | fixtures/flutter-scenario/lib/main.dart:4 |
| `CI` | yes | no | src/check.js:34, src/check.js:34, src/init.js:59 |
| `D9_ADDED` | yes | no | scripts/harness.py:2115 |
| `D9_PROBE` | yes | no | scripts/harness.py:2109 |
| `DATABASE_URL` | yes | no | fixtures/conflict-scenario/prisma/schema.prisma:3, fixtures/drift-scenario/prisma/schema.prisma:3, fixtures/init-scenario/prisma/schema.prisma:3 |
| `ITEMS_FLAG` | yes | no | scripts/harness.py:944 |
| `KEELDOCS_ACTOR` | yes | no | src/slots.js:149, src/sync.js:183 |
| `KEELDOCS_DSN` | yes | no | providers/db-schema/tbls-live/extract_tbls.py:35 |
| `KEELDOCS_FACTS_DB_SCHEMA` | yes | no | providers/http-endpoints/supabase-postgrest/extract_postgrest.py:50 |
| `KEELDOCS_FACTS_WORKSPACE_LAYOUT` | yes | no | providers/module-graph/go-symbols/extract_gosymbols.py:24, providers/module-graph/java-symbols/extract_javasymbols.py:23, providers/module-graph/py-imports/extract_pysymbols.py:43 |
| `KEELDOCS_INCREMENTAL` | yes | no | providers/config-surface/env-readers/extract_env.py:63, providers/http-endpoints/express/prototype/extract_express.py:354, providers/module-graph/ts-imports/extract_symbols.py:275 |
| `KEELDOCS_NO_CACHE` | yes | no | bin/keeldocs.js:19, src/cache.js:76, tests/cache.test.js:176 |
| `KEELDOCS_TBLS_JSON` | yes | no | providers/db-schema/tbls-live/extract_tbls.py:32, src/facts.js:884 |
| `KEELDOCS_TIME` | yes | no | src/facts.js:938, src/facts.js:957 |
| `LIVE_DB_URL` | yes | no | fixtures/live-scenario/prisma/schema.prisma:3 |
| `NAME` | yes | no | providers/config-surface/env-readers/extract_env.py:8, providers/config-surface/env-readers/extract_env.py:8, providers/config-surface/env-readers/extract_env.py:8 |
| `STORE_DSN` | yes | no | fixtures/go-scenario/store/store.go:8 |
| `SYN_KEY_` | yes | no | experiments/e8-scale/gen.py:35 |
| `SYN_TIMEOUT` | yes | no | experiments/e8-scale/gen.py:23 |
| `USER` | yes | no | src/slots.js:149, src/sync.js:183 |
| `USERS_PAGE_SIZE` | yes | no | fixtures/python-scenario/app/routers/users.py:5 |
<!-- /keeldocs:gen -->

<!-- Values are never read or rendered by keeldocs - names and read-status only (ADR-013). -->
<!-- Human notes below this line are never touched by keeldocs. -->
