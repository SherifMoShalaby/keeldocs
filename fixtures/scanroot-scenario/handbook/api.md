# API

This document is real, anchored, committed - and it lives in `handbook/`, while
the default scan root is `docs/`. That is the whole fixture: one `git mv` away
from here, a repository keeps every one of its markers and stops being checked.

The generated table below is deliberately WRONG - its recorded hash is
`h1:0000...`, which no fact can ever match - so this file is not merely unread,
it is unread AND lying. Add `handbook` to `[docs] dirs` and the run turns into
`DRIFT_FOUND`, which is what makes the silent verdict a defect rather than a
preference.

## Orders

<!-- keeldocs: id=api.orders binds=fact:http-endpoints/GET /orders,fact:http-endpoints/POST /orders hash-kind=fact -->

<!-- keeldocs:gen id=api.orders.table binds=fact:http-endpoints/GET /orders hash=h1:0000000000000000 -->
| method | path |
|---|---|
| GET | /orders |
<!-- /keeldocs:gen -->
