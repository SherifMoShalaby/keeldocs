// keeldocs new <type> - generate one doc from a recipe on demand.
// erd / endpoint-inventory: deterministic render from current facts (never
// overwrites - an existing file is human-owned). adr: interview-driven capture,
// human-authored by definition; the tool numbers, slugs, and links it.
// system-map / config-reference: honestly NOT_AVAILABLE until their providers
// land (v0.1 stubs) - a wrong doc is worse than no doc.

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { extractAll } from "./facts.js";
import { renderEndpointsDoc, renderDataModelDoc } from "./render.js";

const TYPES = ["erd", "endpoint-inventory", "adr", "system-map", "config-reference"];

function emit(json, exit, envelope) {
  process.stdout.write(json ? JSON.stringify(envelope) + "\n"
    : `keeldocs new - ${envelope.code}\n${envelope.summary}\n`);
  return exit;
}

export function runNew({ root, json, args }) {
  const type = args.filter((a) => !a.startsWith("--"))[1];
  if (!TYPES.includes(type)) {
    return emit(json, 2, { v: 1, ok: false, code: "USAGE",
      summary: `usage: keeldocs new <${TYPES.join("|")}> [--title "..."]`, data: {}, next: [] });
  }

  try {
    if (type === "system-map" || type === "config-reference") {
      const need = type === "system-map" ? "services-topology" : "config-surface";
      return emit(json, 2, { v: 1, ok: false, code: "NOT_AVAILABLE",
        summary: `${type} needs the ${need} capability, whose provider is a v0.1 stub - shipping a guessed ${type} would violate the never-fabricate rule. Tracked in docs/design/07-scope-roadmap.md.`,
        data: { requires: need }, next: [] });
    }

    if (type === "adr") {
      const tIdx = args.indexOf("--title");
      const title = tIdx !== -1 ? args[tIdx + 1] : null;
      if (!title) {
        return emit(json, 2, { v: 1, ok: false, code: "USAGE",
          summary: 'adr needs --title "Decision in imperative form" - the rationale is YOURS to state; keeldocs will never invent it from code',
          data: {}, next: ['keeldocs new adr --title "Use X for Y"'] });
      }
      const dir = join(root, "docs", "decisions");
      mkdirSync(dir, { recursive: true });
      const nums = readdirSync(dir).map((f) => parseInt(f.slice(0, 4), 10)).filter((n) => !isNaN(n));
      const next = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const rel = `docs/decisions/${next}-${slug}.md`;
      const body = [
        `# ${next}. ${title}`,
        `<!-- keeldocs: id=decisions.${next} recipe=adr@1 -->`,
        "",
        "Status: proposed",
        "",
        "## Context",
        "",
        "(What forces are at play? Written by a human - keeldocs never infers rationale.)",
        "",
        "## Decision",
        "",
        "(What was decided, in active voice.)",
        "",
        "## Consequences",
        "",
        "(What becomes easier, what becomes harder, what is now owed.)",
        "",
      ].join("\n");
      writeFileSync(join(root, rel), body);
      return emit(json, 0, { v: 1, ok: true, code: "CREATED",
        summary: `${rel} created - fill Context/Decision/Consequences in your own words, then commit`,
        data: { path: rel, number: next }, next: [] });
    }

    // erd / endpoint-inventory: deterministic render from current facts
    const { factsById, toolError } = extractAll(root);
    if (toolError) {
      return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR", summary: `tooling error: ${toolError}`, data: {}, next: [] });
    }
    const rendered = type === "erd" ? renderDataModelDoc(factsById) : renderEndpointsDoc(factsById);
    if (!rendered) {
      return emit(json, 2, { v: 1, ok: false, code: "NOT_AVAILABLE",
        summary: `no ${type === "erd" ? "db-schema" : "http-endpoints"} facts extracted from this repo - nothing true to render`,
        data: {}, next: [] });
    }
    if (existsSync(join(root, rendered.path))) {
      return emit(json, 0, { v: 1, ok: true, code: "EXISTS",
        summary: `${rendered.path} already exists and is human-owned - keeldocs never overwrites; use keeldocs sync to refresh its generated regions`,
        data: { path: rendered.path }, next: ["keeldocs check", "keeldocs sync"] });
    }
    mkdirSync(dirname(join(root, rendered.path)), { recursive: true });
    writeFileSync(join(root, rendered.path), rendered.content);
    return emit(json, 0, { v: 1, ok: true, code: "CREATED",
      summary: `${rendered.path} created (born clean - anchored, hashed, drift-armed)`,
      data: { path: rendered.path }, next: ["keeldocs check"] });
  } catch (err) {
    return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR", summary: String(err.message).slice(0, 300), data: {}, next: [] });
  }
}
