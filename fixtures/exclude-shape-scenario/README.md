# exclude-shape-scenario

One excludable fact, one excludable provider and one excludable anchored
document, all under a single top-level directory, so that `exclude-paths =
["vendor"]` and `exclude-paths = ["vendor/**"]` can be compared over the same
tree.

The point of the fixture is that `vendor/` really contains something to lose:
`vendor/lib.js` reads `VENDOR_SECRET_KEY`, `vendor/docker-compose.yml` is the
only compose file in the tree, and `vendor/notes.md` is anchored to a fact
nothing here produces and records a generated-region hash nothing can match. A
gate that passed over a `vendor/` with nothing in it would prove nothing at all.

This README carries no anchors on purpose: it is always scanned, so the run is
never zero documents, and it must never be the document a sweep reports.
