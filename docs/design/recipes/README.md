# Recipe specifications

These files are the specification for the eight document recipes. They are not
read at runtime. The implementation is `src/render.js` (plus `src/newcmd.js` for
`adr`, which is interview capture rather than a render), and the recipe identity
a document carries lives in its anchor: `recipe=erd@1`.

Until 2026-08-05 this directory sat at the repository root and shipped inside the
npm tarball, where it read as a runtime input to anyone who found it. Nothing had
ever loaded it. `recipes/erd/template.md` was the cost of that: every anchor id in
it — `erd.root`, `erd.overview`, `erd.l0` — named a section the renderer does not
emit and never had. A user who used the template as a template, which is the one
thing a file called `template.md` invites, would have had all three sections
quarantined by `check` as unresolvable, in the tool whose entire claim is that
documentation which disagrees with the code gets caught. Three further recipes
the renderer stamps into user documents — `data-flow`, `module-guide`,
`screen-inventory` — had no specification here at all.

The directory now lives under `docs/design/`, is excluded from the published
package, and is held to the renderer by a harness gate: every `recipe=<id>@N` in
`src/` must have a directory here whose `recipe.yaml` declares the `output.path`
and `root_anchor` the renderer actually produces, and every anchor id in a
`template.md` must exist verbatim in `src/render.js`. The gate fails on a new
renderer recipe with no spec, and on a spec that drifts from the renderer.

The full normative schema, with ERD worked end to end, is
[`../05-recipe-schema.md`](../05-recipe-schema.md).
