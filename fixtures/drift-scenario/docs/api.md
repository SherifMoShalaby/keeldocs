# API

## Orders
<!-- keeldocs: id=api.orders recipe=endpoint-inventory@1 binds=fact:http-endpoints/GET /orders,fact:http-endpoints/POST /orders hash-kind=fact -->

<!-- keeldocs:gen id=api.orders.table hash=h1:3e6d2521d46d7851 content=h1:5b3bfd02cc57a39a -->
| method | path |
|---|---|
| GET | /orders |
| POST | /orders |
<!-- /keeldocs:gen -->

## Health
<!-- keeldocs:gen id=api.health binds=fact:http-endpoints/GET /health hash=h1:0000000000000000 -->
| method | path |
|---|---|
| GET | /health |
<!-- /keeldocs:gen -->

## Create item (stale reference - endpoint never existed with this shape)
<!-- keeldocs: id=api.create-item binds=fact:http-endpoints/POST /orders/{id} hash-kind=fact -->

## Legacy delete (intentionally removed; journal tombstone suppresses re-prompt)
<!-- keeldocs: id=api.legacy binds=fact:http-endpoints/DELETE /orders hash-kind=fact -->
