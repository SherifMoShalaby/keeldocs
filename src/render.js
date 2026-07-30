// Deterministic starter-doc renderer (init). Canonical emission per the ERD
// recipe: sorted entities/edges/rows, stable headings from object names only,
// hashes computed AT RENDER over the exact bound facts and body - docs are
// born clean: `check` immediately after `init` must report zero drift.

import { aggregateHash } from "./drift.js";
import { contentHash, display } from "./hash.js";

function genBlock(id, binds, ids, factsById, body) {
  const hash = display(aggregateHash(ids, factsById));
  const content = display(contentHash(body));
  const bindsAttr = binds ? ` binds=${binds}` : "";
  return `<!-- keeldocs:gen id=${id}${bindsAttr} hash=${hash} content=${content} -->\n${body}\n<!-- /keeldocs:gen -->`;
}

export function renderEndpointsDoc(factsById) {
  const eps = [...factsById.values()]
    .filter((f) => f.payload.type === "endpoint")
    .sort((a, b) => a.payload.attrs.path.localeCompare(b.payload.attrs.path)
                 || a.payload.attrs.method.localeCompare(b.payload.attrs.method));
  if (eps.length === 0) return null;
  const rows = eps.map((f) => {
    const src = f.provenance.source?.[0];
    return `| ${f.payload.attrs.method} | \`${f.payload.attrs.path}\` | ${src ? src.file + (src.line ? `:${src.line}` : "") : ""} |`;
  });
  const body = ["| method | path | source |", "|---|---|---|", ...rows].join("\n");
  const content = [
    "# API endpoints",
    "<!-- keeldocs: id=api.inventory recipe=endpoint-inventory@1 binds=fact:http-endpoints/* hash-kind=fact -->",
    "",
    genBlock("api.inventory.table", null, eps.map((f) => f.id), factsById, body),
    "",
    "<!-- Human notes below this line are never touched by keeldocs. -->",
    "",
  ].join("\n");
  return { path: "docs/reference/endpoints.md", content };
}

export function renderDataModelDoc(factsById) {
  const tables = [...factsById.values()].filter((f) => f.payload.type === "table")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
  const enums = [...factsById.values()].filter((f) => f.payload.type === "enum")
    .sort((a, b) => a.payload.attrs.name.localeCompare(b.payload.attrs.name));
  if (tables.length === 0) return null;

  // Mermaid erDiagram - canonical: sorted entities, sorted edges, fixed indent.
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
  const allDbIds = [...tables, ...enums].map((f) => f.id).sort();

  const parts = [
    "# Data model",
    "<!-- keeldocs: id=db.root recipe=erd@1 binds=fact:db-schema/* hash-kind=fact -->",
    "",
    "## Diagram",
    genBlock("db.root.diagram", null, allDbIds, factsById, lines.join("\n")),
    "",
  ];
  for (const t of tables) {
    const name = t.payload.attrs.name;
    const idSlug = `db.${name.toLowerCase()}`;
    const rows = t.payload.attrs.columns.map((c) =>
      `| ${c.name} | ${c.type}${c.list ? "[]" : ""}${c.optional ? "?" : ""} | ${c.attrs || ""} |`);
    const body = ["| column | type | attributes |", "|---|---|---|", ...rows].join("\n");
    parts.push(
      `## ${name}`,
      `<!-- keeldocs: id=${idSlug} recipe=erd@1 binds=${t.id} hash-kind=fact -->`,
      "",
      genBlock(`${idSlug}.columns`, null, [t.id], factsById, body),
      "",
    );
  }
  if (enums.length) {
    const body = enums.map((e) => `- \`${e.payload.attrs.name}\`: ${e.payload.attrs.values.join(", ")}`).join("\n");
    parts.push(
      "## Enums",
      genBlock("db.enums", enums.map((e) => e.id).sort().join(","), enums.map((e) => e.id), factsById, body),
      "",
    );
  }
  parts.push("<!-- Human notes below this line are never touched by keeldocs. -->", "");
  return { path: "docs/architecture/data-model.md", content: parts.join("\n") };
}

export function renderAll(factsById) {
  return [renderEndpointsDoc(factsById), renderDataModelDoc(factsById)].filter(Boolean);
}
