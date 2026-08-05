# Configuration
<!-- keeldocs: id=config.reference recipe=config-reference@1 binds=fact:config-surface/* hash-kind=fact -->

<!-- keeldocs:slot id=config.overview binds=fact:config-surface/* max-words=120 -->
<!-- /keeldocs:slot -->

<!-- keeldocs:gen id=config.reference.table hash=h1:86c7a418be5bdb2c content=h1:ef09b43bbe95081e -->
| variable | read in code | in .env.example | read sites |
|---|---|---|---|
| `APP_PORT` | yes | no | tests/init.test.js:32 |
| `CI` | yes | no | src/check.js:34, src/check.js:34, src/init.js:59 |
| `KEELDOCS_ACTOR` | yes | no | src/slots.js:148, src/sync.js:181 |
| `KEELDOCS_DSN` | yes | no | providers/db-schema/tbls-live/extract_tbls.py:35 |
| `KEELDOCS_FACTS_DB_SCHEMA` | yes | no | providers/http-endpoints/supabase-postgrest/extract_postgrest.py:50 |
| `KEELDOCS_FACTS_WORKSPACE_LAYOUT` | yes | no | providers/module-graph/go-symbols/extract_gosymbols.py:24, providers/module-graph/java-symbols/extract_javasymbols.py:23, providers/module-graph/py-imports/extract_pysymbols.py:43 |
| `KEELDOCS_INCREMENTAL` | yes | no | providers/config-surface/env-readers/extract_env.py:63, providers/http-endpoints/express/prototype/extract_express.py:354, providers/module-graph/ts-imports/extract_symbols.py:275 |
| `KEELDOCS_NO_CACHE` | yes | no | bin/keeldocs.js:28, src/cache.js:76, tests/cache.test.js:176 |
| `KEELDOCS_TBLS_JSON` | yes | no | providers/db-schema/tbls-live/extract_tbls.py:32, src/facts.js:887 |
| `KEELDOCS_TIME` | yes | no | src/facts.js:941, src/facts.js:960 |
| `NAME` | yes | no | providers/config-surface/env-readers/extract_env.py:8, providers/config-surface/env-readers/extract_env.py:8, providers/config-surface/env-readers/extract_env.py:8 |
| `USER` | yes | no | src/slots.js:148, src/sync.js:181 |
<!-- /keeldocs:gen -->

<!-- Values are never read or rendered by keeldocs - names and read-status only (ADR-013). -->
<!-- Human notes below this line are never touched by keeldocs. -->
