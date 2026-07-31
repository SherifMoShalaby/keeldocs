# API endpoints
<!-- keeldocs: id=api.inventory recipe=endpoint-inventory@1 binds=fact:http-endpoints/* hash-kind=fact -->

<!-- keeldocs:slot id=api.inventory.overview binds=fact:http-endpoints/* max-words=120 -->
<!-- /keeldocs:slot -->

<!-- keeldocs:gen id=api.inventory.table hash=h1:d75cabb93a00c423 content=h1:e6b74ff82e173d3f -->
| method | path | source |
|---|---|---|
| GET | `/api/items` | app/routers/items.py:6 |
| GET | `/api/items/{item_id}` | app/routers/items.py:11 |
| DELETE | `/api/items/bulk` | app/routers/items.py:16 |
| POST | `/api/items/bulk` | app/routers/items.py:16 |
| POST | `/api/v1/users` | app/routers/users.py:8 |
| GET | `/health` | app/main.py:14 |
<!-- /keeldocs:gen -->

<!-- Human notes below this line are never touched by keeldocs. -->
