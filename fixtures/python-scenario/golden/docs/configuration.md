# Configuration
<!-- keeldocs: id=config.reference recipe=config-reference@1 binds=fact:config-surface/* hash-kind=fact -->

<!-- keeldocs:slot id=config.overview binds=fact:config-surface/* max-words=120 -->
<!-- /keeldocs:slot -->

<!-- keeldocs:gen id=config.reference.table hash=h1:85728a270c491507 content=h1:0bc8c2d95887e505 -->
| variable | read in code | in .env.example | read sites |
|---|---|---|---|
| `APP_DEBUG` | yes | no | app/main.py:10 |
| `DATABASE_URL` | yes | no | app/main.py:11 |
| `USERS_PAGE_SIZE` | yes | no | app/routers/users.py:5 |
<!-- /keeldocs:gen -->

<!-- Values are never read or rendered by keeldocs - names and read-status only (ADR-013). -->
<!-- Human notes below this line are never touched by keeldocs. -->
