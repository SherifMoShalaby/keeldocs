# root-layout-scenario

The root-layout twin of the nested-layout-scenario fixture: the same four
extraction inputs, byte for byte, at the repository root.

It is a CONTROL, not a feature demo. A nested-tree gate that passed because the
nested fixture had quietly stopped containing routes, pages, services or
policies would still pass; this one fails, because it pins what the four
extractors produce from this exact content — 18 endpoints, 3 routes, 2 owned
services, 2 policies and 1 rls fact.
