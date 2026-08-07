# Vendored examples

This file is not this repository's documentation. It is the kind of README a
vendored dependency ships, and it happens to EXPLAIN keeldocs by showing an
anchor:

```markdown
<!-- keeldocs: id=example.orders binds=fact:http-endpoints/GET /orders hash-kind=fact -->

<!-- keeldocs:gen id=example.orders.table hash=h1:1111111111111111 -->
| method | path |
|---|---|
| GET | /orders |
<!-- /keeldocs:gen -->
```

Nothing above is document structure, so the out-of-scan-root sweep must stay
silent here. A sweep that fired on fenced illustrations would fire on every
README that mentions the tool - including keeldocs' own - and would be switched
off within a day, which is the same as not shipping it.
