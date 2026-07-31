# Configuration
<!-- keeldocs: id=config.reference recipe=config-reference@1 binds=fact:config-surface/* hash-kind=fact -->

<!-- keeldocs:slot id=config.overview binds=fact:config-surface/* max-words=120 -->
<!-- /keeldocs:slot -->

<!-- keeldocs:gen id=config.reference.table hash=h1:fd3a98ab492693b6 content=h1:39dbb0f2e0155c80 -->
| variable | read in code | in .env.example | read sites |
|---|---|---|---|
| `APP_PORT` | yes | no | app.js:8 |
| `DATABASE_URL` | yes | no | prisma/schema.prisma:3 |
<!-- /keeldocs:gen -->

<!-- Values are never read or rendered by keeldocs - names and read-status only (ADR-013). -->
<!-- Human notes below this line are never touched by keeldocs. -->
