// Deterministic renderer (init + sync). Canonical emission per the ERD recipe:
// sorted entities/edges/rows, stable headings from object names only, hashes
// computed AT RENDER over the exact bound facts and body - docs are born clean,
// and sync regenerates the same regions from current facts via the registry below.

import { aggregateHash } from "./drift.js";
import { contentHash, display } from "./hash.js";
import { redact } from "./redact.js";
import { ownershipIndex, resolvePackageBind } from "./ownership.js";

// Redaction happens BEFORE content-hashing (ADR-013): the recorded content=
// hash must match the bytes actually written, so redacted docs stay born clean.
function genBlock(id, binds, ids, factsById, rawBody, sink) {
  const r = redact(rawBody);
  if (sink && r.redactions.length) sink.push(...r.redactions.map((x) => ({ ...x, region: id })));
  const body = r.clean;
  const hash = display(aggregateHash(ids, factsById));
  const content = display(contentHash(body));
  const bindsAttr = binds ? ` binds=${binds}` : "";
  return `<!-- keeldocs:gen id=${id}${bindsAttr} hash=${hash} content=${content} -->\n${body}\n<!-- /keeldocs:gen -->`;
}

// ---------- region body builders (shared by init and sync) ----------

function endpointFacts(factsById, only = null) {
  return [...factsById.values()]
    .filter((f) => f.payload.type === "endpoint" && (!only || only.has(f.id)))
    .sort((a, b) => a.payload.attrs.path.localeCompare(b.payload.attrs.path)
                 || a.payload.attrs.method.localeCompare(b.payload.attrs.method));
}

// `only` is the region's RESOLVED bind set: a package-scoped section renders
// exactly what it bound, so body and hash can never describe different sets.
export function endpointsTableBody(factsById, only = null) {
  const eps = endpointFacts(factsById, only);
  const rows = eps.map((f) => {
    const src = f.provenance?.source?.[0];
    const where = !src ? ""
      : src.file ? src.file + (src.line ? `:${src.line}` : "")
      : src.from ? `${src.kind}: \`${src.from}\`` // derived surface - names its origin fact
      : src.kind ?? "";
    return `| ${f.payload.attrs.method} | \`${f.payload.attrs.path}\` | ${where} |`;
  });
  return ["| method | path | source |", "|---|---|---|", ...rows].join("\n");
}

function tableFacts(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "table")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
}

function enumFacts(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "enum")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
}

export function diagramBody(factsById) {
  const tables = tableFacts(factsById);
  const lines = ["```mermaid", "erDiagram"];
  for (const t of tables) {
    lines.push(`  ${t.payload.attrs.name} {`);
    for (const c of t.payload.attrs.columns) {
      lines.push(`    ${c.type.replace(/\W/g, "")} ${c.name}${c.optional ? " \"nullable\"" : ""}`);
    }
    lines.push("  }");
  }
  const edges = [];
  for (const t of tables) {
    for (const r of t.payload.attrs.relations) {
      edges.push(`  ${t.payload.attrs.name} }o--|| ${r.target} : "${r.field}"`);
    }
  }
  lines.push(...edges.sort());
  lines.push("```");
  return lines.join("\n");
}

export function tableColumnsBody(tableFact) {
  const rows = tableFact.payload.attrs.columns.map((c) =>
    `| ${c.name} | ${c.type}${c.list ? "[]" : ""}${c.optional ? "?" : ""} | ${c.attrs || ""} |`);
  return ["| column | type | attributes |", "|---|---|---|", ...rows].join("\n");
}

function envVarFacts(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "env-var")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
}

export function envTableBody(factsById) {
  const rows = envVarFacts(factsById).map((f) => {
    const a = f.payload.attrs;
    const where = f.provenance?.source?.filter((s) => s.kind === "code").slice(0, 3)
      .map((s) => `${s.file}:${s.line}`).join(", ") || "-";
    return `| \`${a.name}\` | ${a.read_in_code ? "yes" : "no"} | ${a.declared_in_example ? "yes" : "no"} | ${where} |`;
  });
  return ["| variable | read in code | in .env.example | read sites |", "|---|---|---|---|", ...rows].join("\n");
}

export function enumsBody(factsById) {
  return enumFacts(factsById).map((e) => `- \`${e.payload.attrs.name}\`: ${e.payload.attrs.values.join(", ")}`).join("\n");
}

function functionFactsOf(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "function")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name)
                 || a.payload.attrs.signature.localeCompare(b.payload.attrs.signature));
}

export function functionsBody(factsById) {
  const rows = functionFactsOf(factsById).map((f) => {
    const a = f.payload.attrs;
    const props = [a.volatility, a.language, ...(a.security_definer ? ["security definer"] : []),
                   ...(a.kind === "procedure" ? ["procedure"] : [])].filter(Boolean).join(", ");
    const args = a.arguments ? `\`${a.arguments}\`` : "-";
    return `| \`${a.name}\` | ${args} | \`${a.returns}\` | ${props} |`;
  });
  return ["| routine | arguments | returns | properties |", "|---|---|---|---|", ...rows].join("\n");
}

function policyFactsOf(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "policy")
    .sort((a, b) => (a.payload.attrs.schema + "." + a.payload.attrs.table).localeCompare(b.payload.attrs.schema + "." + b.payload.attrs.table)
                 || a.payload.attrs.name.localeCompare(b.payload.attrs.name));
}

function rlsFactsOf(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "rls")
    .sort((a, b) => (a.payload.attrs.schema + "." + a.payload.attrs.table).localeCompare(b.payload.attrs.schema + "." + b.payload.attrs.table));
}

export function policiesBody(factsById) {
  const pols = policyFactsOf(factsById);
  const rls = rlsFactsOf(factsById);
  const rows = pols.map((f) => {
    const a = f.payload.attrs;
    return `| \`${a.schema}.${a.table}\` | \`${a.name}\` | ${a.command} | ${a.permissive ? "permissive" : "restrictive"} | ${a.roles.join(", ") || "-"} | ${a.using ? `\`${a.using}\`` : "-"} | ${a.with_check ? `\`${a.with_check}\`` : "-"} |`;
  });
  const lines = ["| table | policy | command | mode | roles | using | with check |",
                 "|---|---|---|---|---|---|---|", ...rows];
  if (rls.length) {
    lines.push("", ...rls.map((f) => {
      const a = f.payload.attrs;
      return `- RLS ${a.enabled ? "enabled" : "**disabled**"} on \`${a.schema}.${a.table}\``;
    }));
  }
  return lines.join("\n");
}

function serviceFactsOf(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "service")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
}

function packageFactsOf(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "package")
    .sort((a, b) => a.payload.attrs.path.localeCompare(b.payload.attrs.path));
}

// Mermaid node ids must be identifier-safe; labels keep the real name.
const mermaidId = (n) => n.replace(/[^A-Za-z0-9_]/g, "_");

export function servicesDiagramBody(factsById) {
  const svcs = serviceFactsOf(factsById);
  const lines = ["```mermaid", "flowchart LR"];
  for (const s of svcs) {
    const a = s.payload.attrs;
    // owned = rectangle (your architecture); external = cylinder (a dependency)
    lines.push(a.kind === "owned" ? `  ${mermaidId(a.name)}["${a.name}"]`
                                  : `  ${mermaidId(a.name)}[("${a.name}")]`);
  }
  const edges = [];
  for (const s of svcs) {
    for (const d of s.payload.attrs.depends_on) {
      edges.push(`  ${mermaidId(s.payload.attrs.name)} --> ${mermaidId(d)}`);
    }
  }
  lines.push(...edges.sort());
  lines.push("```");
  return lines.join("\n");
}

export function servicesTableBody(factsById) {
  const rows = serviceFactsOf(factsById).map((f) => {
    const a = f.payload.attrs;
    return `| \`${a.name}\` | ${a.kind} | ${a.image ? `\`${a.image}\`` : "-"} | ${a.build ? `\`${a.build}\`` : "-"} | ${a.ports.length ? a.ports.join(", ") : "-"} | ${a.depends_on.length ? a.depends_on.join(", ") : "-"} |`;
  });
  return ["| service | kind | image | build | ports | depends on |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function packagesTableBody(factsById) {
  const rows = packageFactsOf(factsById).map((f) => {
    const a = f.payload.attrs;
    return `| \`${a.name}\` | \`${a.path}\` | ${a.manager} |`;
  });
  return ["| package | path | manager |", "|---|---|---|", ...rows].join("\n");
}

// Registry: region id -> how to regenerate its body from CURRENT facts.
// Returns null for hand-authored region ids the engine cannot regenerate.
export function renderRegionBody(regionId, boundIds, factsById) {
  if (regionId === "api.inventory.table") return endpointsTableBody(factsById);
  if (regionId === "db.root.diagram") return diagramBody(factsById);
  if (regionId === "db.enums") return enumsBody(factsById);
  if (regionId === "config.reference.table") return envTableBody(factsById);
  if (regionId === "sys.map.diagram") return servicesDiagramBody(factsById);
  if (regionId === "sys.map.services") return servicesTableBody(factsById);
  if (regionId === "sys.map.packages") return packagesTableBody(factsById);
  if (regionId === "db.policies") return policiesBody(factsById);
  if (regionId === "db.functions") return functionsBody(factsById);
  if (regionId === "ui.screens.table") return screensTableBody(factsById);
  if (regionId === "flow.diagram") return dataFlowDiagramBody(factsById);
  if (regionId === "flow.channels") return channelsTableBody(factsById);
  // module-guide regions (R3) were unrenderable at sync time until now: a
  // stale guide could be REPORTED but never repaired, which is exactly the
  // half-loop the design forbids
  if (/^mod\..+\.surface$/.test(regionId)) return endpointsTableBody(factsById, new Set(boundIds));
  if (/^mod\..+\.deps$/.test(regionId)) return moduleDepsBody(factsById, new Set(boundIds));
  const m = regionId.match(/^db\..+\.columns$/);
  if (m) {
    const tableId = boundIds.find((id) => id.startsWith("fact:db-schema/") && !id.includes("/enum."));
    const fact = tableId ? factsById.get(tableId) : null;
    return fact ? tableColumnsBody(fact) : null;
  }
  return null;
}

// ---------- whole-document renderers (init) ----------

export function renderEndpointsDoc(factsById, sink) {
  const eps = endpointFacts(factsById);
  if (eps.length === 0) return null;
  const body = endpointsTableBody(factsById);
  const content = [
    "# API endpoints",
    "<!-- keeldocs: id=api.inventory recipe=endpoint-inventory@1 binds=fact:http-endpoints/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=api.inventory.overview binds=fact:http-endpoints/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    genBlock("api.inventory.table", null, eps.map((f) => f.id), factsById, body, sink),
    "",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/reference/endpoints.md", content };
}

// Module guide (doc 11 R3): deterministic skeleton + ONE labeled prose slot.
// Reference-tier semantics: the dependency section binds module-graph facts,
// so import changes make the guide honestly stale (sync regenerates it).
// Data-flow recipe (brief 3.4): the repo's async surface as a deterministic
// diagram + table. Body content comes ONLY from hashed payload attrs (name,
// kind, transport, role) so what the diagram shows is exactly what drift
// watches; call sites ride the table's Sites column from provenance, the same
// convention the endpoint inventory uses.
function channelFacts(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "channel")
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function dataFlowDiagramBody(factsById) {
  const chans = channelFacts(factsById);
  const byTransport = new Map();
  for (const c of chans) {
    const t = c.payload.attrs.transport;
    if (!byTransport.has(t)) byTransport.set(t, []);
    byTransport.get(t).push(c);
  }
  const lines = ["```mermaid", "flowchart LR", '  svc[["this service"]]'];
  for (const [transport, list] of [...byTransport.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  subgraph ${mermaidId(transport)}["${transport}"]`);
    for (const c of list) {
      const a2 = c.payload.attrs;
      lines.push(`    ${mermaidId(a2.kind + "_" + a2.name)}(["${a2.name}${a2.pattern ? " (pattern)" : ""}"])`);
    }
    lines.push("  end");
  }
  for (const c of chans) {
    const a2 = c.payload.attrs;
    const id = mermaidId(a2.kind + "_" + a2.name);
    if (a2.role === "produces" || a2.role === "both") lines.push(`  svc -->|publishes| ${id}`);
    if (a2.role === "consumes" || a2.role === "both") lines.push(`  ${id} -->|delivers| svc`);
  }
  lines.push("```");
  return lines.join("\n");
}

export function channelsTableBody(factsById) {
  const rows = channelFacts(factsById).map((f) => {
    const a2 = f.payload.attrs;
    const sites = (f.provenance?.source ?? []).map((s) => s.file).slice(0, 3).join(", ") || "-";
    return `| \`${a2.name}\`${a2.pattern ? " ⟨pattern⟩" : ""} | ${a2.kind} | ${a2.transport} | ${a2.role} | ${sites} |`;
  });
  return ["| channel | kind | transport | role | sites |", "|---|---|---|---|---|", ...rows].join("\n");
}

// Screens/route inventory: the client-side analogue of the endpoint
// inventory, added when routes joined the coverage denominator - counting a
// surface the tool gives you no way to document would be an unreachable
// metric, which is worse than not counting it.
function routeFacts(factsById) {
  return [...factsById.values()].filter((f) => f.payload.type === "route")
    .sort((a, b) => a.payload.attrs.path.localeCompare(b.payload.attrs.path));
}

export function screensTableBody(factsById) {
  const rows = routeFacts(factsById).map((f) => {
    const src = f.provenance?.source?.[0]?.file ?? "";
    return `| \`${f.payload.attrs.path}\` | ${src} |`;
  });
  return ["| route | source |", "|---|---|", ...rows].join("\n");
}

export function renderScreensDoc(factsById, sink) {
  const routes = routeFacts(factsById);
  if (routes.length === 0) return null;
  const content = [
    "# Screens and routes",
    "<!-- keeldocs: id=ui.screens recipe=screen-inventory@1 binds=fact:client-routes/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=ui.screens.overview binds=fact:client-routes/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    genBlock("ui.screens.table", "fact:client-routes/*", routes.map((f) => f.id),
      factsById, screensTableBody(factsById), sink),
    "",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/reference/screens.md", content };
}

export function renderDataFlowDoc(factsById, sink) {
  if (channelFacts(factsById).length === 0) return null;
  const content = [
    "# Data flow",
    "<!-- keeldocs: id=flow.root recipe=data-flow@1 binds=fact:async-messaging/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=flow.overview binds=fact:async-messaging/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    "## Diagram",
    genBlock("flow.diagram", "fact:async-messaging/*", channelFacts(factsById).map((f) => f.id),
      factsById, dataFlowDiagramBody(factsById), sink),
    "",
    "## Channels",
    genBlock("flow.channels", "fact:async-messaging/*", channelFacts(factsById).map((f) => f.id),
      factsById, channelsTableBody(factsById), sink),
    "",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/architecture/data-flow.md", content };
}

export function moduleDepsBody(factsById, only = null) {
  const mods = [...factsById.values()]
    .filter((f) => f.payload.type === "module" && (!only || only.has(f.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const fan = new Map();
  for (const m of mods) {
    for (const imp of m.payload.attrs.imports) fan.set(imp, (fan.get(imp) ?? 0) + 1);
  }
  const top = [...fan.entries()].filter(([p]) => mods.some((m) => m.payload.attrs.path === p))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return [`${mods.length} module(s).` + (top.length ? " Highest fan-in:" : ""),
    ...top.map(([p, n]) => `- \`${p}\` (imported by ${n})`)].join("\n");
}

export function renderModuleGuideDoc(factsById, sink, pkgName) {
  const pkgs = [...factsById.values()].filter((f) => f.payload.type === "package");
  const pkg = pkgName ? pkgs.find((p) => p.payload.attrs.name === pkgName) : (pkgs.length === 1 ? pkgs[0] : null);
  if (!pkg) return null;
  const name = pkg.payload.attrs.name;
  const path = pkg.payload.attrs.path;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const parts = [
    `# Module guide: ${name}`,
    `<!-- keeldocs: id=mod.${slug} recipe=module-guide@1 binds=${pkg.id} hash-kind=fact -->`,
    "",
    `<!-- keeldocs:slot id=mod.${slug}.overview binds=${pkg.id} max-words=120 -->`,
    "<!-- /keeldocs:slot -->",
  ];
  // Regions carry their OWN binds: without them they would inherit the anchor's
  // single package fact and go stale at birth. They are PACKAGE-SCOPED - this
  // guide describes this package, and `fact:http-endpoints/*` would have made
  // every guide in a monorepo show every other package's surface and stale on
  // it. Ownership is derived from provenance (src/ownership.js), so the bind
  // stays one short token however many endpoints the package has.
  const owned = new Set(resolvePackageBind({ pkg: name, capability: "http-endpoints" },
    factsById, ownershipIndex(factsById)));
  const ownedMods = new Set(resolvePackageBind({ pkg: name, capability: "module-graph" },
    factsById, ownershipIndex(factsById)));
  const eps = endpointFacts(factsById, owned);
  const mods = [...ownedMods].sort();
  if (eps.length) {
    parts.push("", "## Public surface",
      genBlock(`mod.${slug}.surface`, `pkg:${name}#http-endpoints/*`, eps.map((f) => f.id),
        factsById, endpointsTableBody(factsById, owned), sink));
  }
  if (mods.length) {
    parts.push("", "## Module dependencies",
      genBlock(`mod.${slug}.deps`, `pkg:${name}#module-graph/*`, mods,
        factsById, moduleDepsBody(factsById, ownedMods), sink));
  }
  parts.push("", "<!-- Human notes below this line are never touched by keeldocs. -->", "");
  return { path: `docs/reference/modules/${slug}.md`, content: parts.join("\n") };
}

export function renderDataModelDoc(factsById, sink) {
  const tables = tableFacts(factsById);
  const enums = enumFacts(factsById);
  if (tables.length === 0) return null;
  // The diagram inherits db.root's `fact:db-schema/*`, so its recorded id set
  // is derived from THAT PREFIX rather than from the facts the body happens to
  // draw. Two invariants meet here and only this spelling satisfies both:
  // a generated region must record exactly what its binds resolve to (an
  // enumerated narrower list is born stale the moment a new fact type joins
  // the capability - how the R4 routine facts first surfaced), and the diagram
  // must go stale when a table is ADDED (an enumerated list cannot contain an
  // id that does not exist yet, so a new table would never reach the ERD).
  // Cost: a routine change redraws an unchanged diagram. Over-flagging is the
  // side to err on, and sync repairs it in one pass.
  const diagramIds = [...factsById.keys()].filter((id) => id.startsWith("fact:db-schema/")).sort();

  const parts = [
    "# Data model",
    "<!-- keeldocs: id=db.root recipe=erd@1 binds=fact:db-schema/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=db.overview binds=fact:db-schema/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    "## Diagram",
    genBlock("db.root.diagram", null, diagramIds, factsById, diagramBody(factsById), sink),
    "",
  ];
  for (const t of tables) {
    const name = t.payload.attrs.name;
    const idSlug = `db.${name.toLowerCase()}`;
    parts.push(
      `## ${name}`,
      `<!-- keeldocs: id=${idSlug} recipe=erd@1 binds=${t.id} hash-kind=fact -->`,
      "",
      genBlock(`${idSlug}.columns`, null, [t.id], factsById, tableColumnsBody(t), sink),
      "",
    );
  }
  if (enums.length) {
    parts.push(
      "## Enums",
      genBlock("db.enums", enums.map((e) => e.id).sort().join(","), enums.map((e) => e.id), factsById, enumsBody(factsById), sink),
      "",
    );
  }
  const fns = functionFactsOf(factsById);
  if (fns.length) {
    // id-prefix wildcard, like db.policies: table churn can never stale this
    // region, and however many routines exist the binds attr stays bounded
    parts.push(
      "## Database functions",
      genBlock("db.functions", "fact:db-schema/fn.*", fns.map((f) => f.id).sort(), factsById, functionsBody(factsById), sink),
      "",
    );
  }
  const pols = policyFactsOf(factsById);
  if (pols.length) {
    // id-prefix wildcards: bounded binds attr however many policies exist,
    // and table-fact churn can never stale this region (noise isolation)
    const accessIds = [...pols, ...rlsFactsOf(factsById)].map((f) => f.id).sort();
    parts.push(
      "## Access control (RLS)",
      genBlock("db.policies", "fact:db-policies/*", accessIds, factsById, policiesBody(factsById), sink),
      "",
    );
  }
  parts.push("<!-- Human notes below this line are never touched by keeldocs. -->", "");
  return { path: "docs/architecture/data-model.md", content: parts.join("\n") };
}

export function renderConfigDoc(factsById, sink) {
  const vars = envVarFacts(factsById);
  if (vars.length === 0) return null;
  const content = [
    "# Configuration",
    "<!-- keeldocs: id=config.reference recipe=config-reference@1 binds=fact:config-surface/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=config.overview binds=fact:config-surface/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    genBlock("config.reference.table", null, vars.map((f) => f.id), factsById, envTableBody(factsById), sink),
    "",
    "<!-- Values are never read or rendered by keeldocs - names and read-status only (ADR-013). -->",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/reference/configuration.md", content };
}

export function renderSystemMapDoc(factsById, sink) {
  const svcs = serviceFactsOf(factsById);
  const pkgs = packageFactsOf(factsById);
  const owned = svcs.filter((f) => f.payload.attrs.kind === "owned");
  // Render only when there is real topology to state: an owned service or a
  // multi-package workspace. A single-package repo with no compose file gets
  // nothing - a one-node "map" would be noise wearing a diagram's clothes.
  if (owned.length === 0 && pkgs.length <= 1) return null;
  const svcIds = svcs.map((f) => f.id).sort();
  const pkgIds = pkgs.map((f) => f.id).sort();
  const parts = [
    "# System map",
    "<!-- keeldocs: id=sys.map recipe=system-map@1 binds=fact:services-topology/*,fact:workspace-layout/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=sys.overview binds=fact:services-topology/*,fact:workspace-layout/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
  ];
  if (svcs.length) {
    parts.push(
      "## Services",
      genBlock("sys.map.diagram", "fact:services-topology/*", svcIds, factsById, servicesDiagramBody(factsById), sink),
      "",
      genBlock("sys.map.services", "fact:services-topology/*", svcIds, factsById, servicesTableBody(factsById), sink),
      "",
    );
  }
  if (pkgs.length > 1) {
    parts.push(
      "## Packages",
      genBlock("sys.map.packages", "fact:workspace-layout/*", pkgIds, factsById, packagesTableBody(factsById), sink),
      "",
    );
  }
  parts.push("<!-- Human notes below this line are never touched by keeldocs. -->", "");
  return { path: "docs/architecture/system-map.md", content: parts.join("\n") };
}

export function renderAll(factsById, sink) {
  return [renderEndpointsDoc(factsById, sink), renderDataModelDoc(factsById, sink),
    renderDataFlowDoc(factsById, sink), renderScreensDoc(factsById, sink),
          renderConfigDoc(factsById, sink), renderSystemMapDoc(factsById, sink)].filter(Boolean);
}
