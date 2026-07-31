// Deterministic renderer (init + sync). Canonical emission per the ERD recipe:
// sorted entities/edges/rows, stable headings from object names only, hashes
// computed AT RENDER over the exact bound facts and body - docs are born clean,
// and sync regenerates the same regions from current facts via the registry below.

import { aggregateHash } from "./drift.js";
import { contentHash, display } from "./hash.js";
import { redact } from "./redact.js";

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

function endpointFacts(factsById) {
  return [...factsById.values()]
    .filter((f) => f.payload.type === "endpoint")
    .sort((a, b) => a.payload.attrs.path.localeCompare(b.payload.attrs.path)
                 || a.payload.attrs.method.localeCompare(b.payload.attrs.method));
}

export function endpointsTableBody(factsById) {
  const eps = endpointFacts(factsById);
  const rows = eps.map((f) => {
    const src = f.provenance?.source?.[0];
    return `| ${f.payload.attrs.method} | \`${f.payload.attrs.path}\` | ${src ? src.file + (src.line ? `:${src.line}` : "") : ""} |`;
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

export function renderDataModelDoc(factsById, sink) {
  const tables = tableFacts(factsById);
  const enums = enumFacts(factsById);
  if (tables.length === 0) return null;
  const allDbIds = [...tables, ...enums].map((f) => f.id).sort();

  const parts = [
    "# Data model",
    "<!-- keeldocs: id=db.root recipe=erd@1 binds=fact:db-schema/* hash-kind=fact -->",
    "",
    "<!-- keeldocs:slot id=db.overview binds=fact:db-schema/* max-words=120 -->",
    "<!-- /keeldocs:slot -->",
    "",
    "## Diagram",
    genBlock("db.root.diagram", null, allDbIds, factsById, diagramBody(factsById), sink),
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
          renderConfigDoc(factsById, sink), renderSystemMapDoc(factsById, sink)].filter(Boolean);
}
