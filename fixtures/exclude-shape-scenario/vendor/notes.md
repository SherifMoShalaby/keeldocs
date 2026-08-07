# Vendor notes

Anchored, outside every `[docs] dirs` scan root, and wrong: the anchor binds a
fact this fixture does not produce and the generated region records a hash
nothing can match. Wherever the engine really reads it the verdict is a finding,
so "checked" is distinguishable from "skipped" rather than from "clean".

## Orders

<!-- keeldocs: id=api.orders binds=fact:http-endpoints/GET /orders hash-kind=fact -->

<!-- keeldocs:gen id=api.orders.table binds=fact:http-endpoints/GET /orders hash=h1:0000000000000000 -->
| method | path |
|---|---|
| GET | /orders |
<!-- /keeldocs:gen -->
