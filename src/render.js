// Deterministic renderer (init + sync). Canonical emission per the ERD recipe:
// sorted entities/edges/rows, stable headings from object names only, hashes
// computed AT RENDER over the exact bound facts and body - docs are born clean,
// and sync regenerates the same regions from current facts via the registry below.

import { aggregateHash } from "./drift.js";
import { contentHash, display } from "./hash.js";

function genBlock(id, binds, ids, factsById, body) {
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

export function enumsBody(factsById) {
  return enumFacts(factsById).map((e) => `- \`${e.payload.attrs.name}\`: ${e.payload.attrs.values.join(", ")}`).join("\n");
}

// Registry: region id -> how to regenerate its body from CURRENT facts.
// Returns null for hand-authored region ids the engine cannot regenerate.
export function renderRegionBody(regionId, boundIds, factsById) {
  if (regionId === "api.inventory.table") return endpointsTableBody(factsById);
  if (regionId === "db.root.diagram") return diagramBody(factsById);
  if (regionId === "db.enums") return enumsBody(factsById);
  const m = regionId.match(/^db\..+\.columns$/);
  if (m) {
    const tableId = boundIds.find((id) => id.startsWith("fact:db-schema/") && !id.includes("/enum."));
    const fact = tableId ? factsById.get(tableId) : null;
    return fact ? tableColumnsBody(fact) : null;
  }
  return null;
}

// ---------- whole-document renderers (init) ----------

export function renderEndpointsDoc(factsById) {
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
    genBlock("api.inventory.table", null, eps.map((f) => f.id), factsById, body),
    "",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/reference/endpoints.md", content };
}

export function renderDataModelDoc(factsById) {
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
    genBlock("db.root.diagram", null, allDbIds, factsById, diagramBody(factsById)),
    "",
  ];
  for (const t of tables) {
    const name = t.payload.attrs.name;
    const idSlug = `db.${name.toLowerCase()}`;
    parts.push(
      `## ${name}`,
      `<!-- keeldocs: id=${idSlug} recipe=erd@1 binds=${t.id} hash-kind=fact -->`,
      "",
      genBlock(`${idSlug}.columns`, null, [t.id], factsById, tableColumnsBody(t)),
      "",
    );
  }
  if (enums.length) {
    parts.push(
      "## Enums",
      genBlock("db.enums", enums.map((e) => e.id).sort().join(","), enums.map((e) => e.id), factsById, enumsBody(factsById)),
      "",
    );
  }
  parts.push("<!-- Human notes below this line are never touched by keeldocs. -->", "");
  return { path: "docs/architecture/data-model.md", content: parts.join("\n") };
}

export function renderAll(factsById) {
  return [renderEndpointsDoc(factsById), renderDataModelDoc(factsById)].filter(Boolean);
}
