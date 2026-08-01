// Package-scoped fact identity (doc 11 R3's deferred SPEC decision).
//
// The module guide is rendered per package, but its sections could only bind
// `fact:http-endpoints/*` - the whole capability - because an endpoint id
// carries no package and a `binds` value caps at 200 characters, so the ids
// cannot simply be enumerated. In a monorepo that made every package's guide
// show every package's endpoints and go stale on any of them. Correct output
// for a single-package repo, wrong for the case the recipe exists to serve.
//
// The decision, recorded here because it is a spec choice rather than a patch:
//
//   * fact IDs do NOT change. Package-qualifying every natural key would break
//     every anchor ever written, and would be wrong on its own terms - an
//     endpoint assembled from two packages does not have one owner.
//   * package ownership is DERIVED from provenance, not hashed into the fact.
//     Provenance already carries source files, and it sits outside the hash
//     (ADR-008), so moving a file between packages must not manufacture drift
//     in the fact itself. What it changes is which region binds the fact -
//     and that region's content genuinely did change.
//   * a fact may belong to MORE THAN ONE package. If its sources span two, it
//     appears in both guides, which is the true statement.
//   * a fact with no file provenance - a replayed table, a derived PostgREST
//     endpoint, a live catalog read - belongs to NO package. A database table
//     is not owned by a JavaScript workspace, and pretending otherwise to make
//     a section look fuller would be a fabrication.
//
// The bind spelling is `pkg:<name>#<capability>/*`. `#` is the delimiter
// because package names legitimately contain `/` (npm scopes: `@acme/web`)
// and capability names never contain `#`.

// Longest-prefix owner, the same rule module-graph already uses to assign a
// package to a module path. "." (single-package root) matches everything.
function ownersOfPath(path, packages) {
  const hits = [];
  for (const p of packages) {
    if (p.path === "." || path === p.path || path.startsWith(p.path + "/")) hits.push(p);
  }
  if (!hits.length) return [];
  const longest = Math.max(...hits.map((p) => p.path.length));
  return hits.filter((p) => p.path.length === longest).map((p) => p.name);
}

// fact id -> Set of owning package names. Built once per resolution pass.
export function ownershipIndex(factsById) {
  const packages = [...factsById.values()]
    .filter((f) => f.payload.type === "package")
    .map((f) => ({ name: f.payload.attrs.name, path: f.payload.attrs.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const index = new Map();
  if (!packages.length) return index;
  for (const [id, f] of factsById) {
    if (f.payload.type === "package") continue;
    const owners = new Set();
    // module-graph facts already carry a resolved package in their payload;
    // trust that over re-deriving it from the path (it is the provider's own
    // declared cross-capability read of workspace-layout, contract 9)
    const declared = f.payload.attrs?.package;
    if (typeof declared === "string" && declared !== ".") owners.add(declared);
    for (const s of f.provenance?.source ?? []) {
      if (typeof s?.file !== "string") continue; // derived/catalog source: no package
      for (const name of ownersOfPath(s.file, packages)) owners.add(name);
    }
    if (owners.size) index.set(id, owners);
  }
  return index;
}

const capOf = (id) => id.startsWith("ds ") ? "module-graph"
  : id.startsWith("fact:") ? id.slice(5, id.indexOf("/")) : null;

// Resolve one `pkg:<name>#<capability>` bind against the fact set.
export function resolvePackageBind(bind, factsById, index) {
  const ids = [];
  for (const [id, owners] of index) {
    if (!owners.has(bind.pkg)) continue;
    if (capOf(id) !== bind.capability) continue;
    ids.push(id);
  }
  return ids.sort();
}
