# pnpm-mixed-scenario

A pnpm workspace that declares three members across two patterns: `apps/web` is
a JS package, `services/api` is a Python package and `services/worker` is a Go
module. Neither of the last two carries a manifest pnpm would accept, so neither
is a workspace member as far as pnpm is concerned - and keeldocs still refuses
to invent one for them.

The fixture exists because keeldocs used to drop them *silently*: the layout
reported one package, the system-map renderer saw a single-package repo and
wrote no Packages section, and no report, coverage figure or generated document
mentioned that two declared members had gone missing. The two dropped members
are now named extraction gaps, and this is the only committed golden that can
tell whether they still are.

The harness builds two more cases on a copy of this tree, both of which used to
be equally silent: a tab character in the workspace manifest (unparseable), and
a valid manifest that declares no members at all.
