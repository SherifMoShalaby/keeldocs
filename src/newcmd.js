// keeldocs new <type> - generate one doc from a recipe on demand.
// erd / endpoint-inventory / config-reference / system-map: deterministic
// render from current facts (never overwrites - an existing file is
// human-owned). adr: interview-driven capture, human-authored by definition;
// the tool numbers, slugs, and links it. Any recipe whose facts don't exist
// in this repo answers NOT_AVAILABLE - a wrong doc is worse than no doc.

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { extractAll } from "./facts.js";
import { renderEndpointsDoc, renderModuleGuideDoc, renderDataModelDoc, renderConfigDoc, renderSystemMapDoc } from "./render.js";
import { loadConfig } from "./config.js";
import { redact } from "./redact.js";

const TYPES = ["erd", "endpoint-inventory", "adr", "system-map", "config-reference", "module-guide"];

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
      const adrRed = redact(body);
      writeFileSync(join(root, rel), adrRed.clean);
      return emit(json, 0, { v: 1, ok: true, code: "CREATED",
        summary: `${rel} created - fill Context/Decision/Consequences in your own words, then commit`,
        data: { path: rel, number: next }, next: [] });
    }

    // erd / endpoint-inventory / config-reference / system-map:
    // deterministic render from current facts
    const cfg = loadConfig(root);
    if (!cfg.ok) {
      return emit(json, 2, { v: 1, ok: false, code: "CONFIG", summary: cfg.error.slice(0, 300), data: {}, next: [] });
    }
    const { factsById, toolError } = extractAll(root,
    { disable: cfg.config.providers.disable, trustKeys: cfg.config.trust.keys, resolvePins: cfg.config.resolve.pin });
    if (toolError) {
      return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR", summary: `tooling error: ${toolError}`, data: {}, next: [] });
    }
    const sink = [];
    const pIdx = args.indexOf("--package");
    const rendered = type === "erd" ? renderDataModelDoc(factsById, sink)
      : type === "config-reference" ? renderConfigDoc(factsById, sink)
      : type === "system-map" ? renderSystemMapDoc(factsById, sink)
      : type === "module-guide" ? renderModuleGuideDoc(factsById, sink, pIdx !== -1 ? args[pIdx + 1] : null)
      : renderEndpointsDoc(factsById, sink);
    if (!rendered) {
      const why = type === "erd" ? "no db-schema facts extracted from this repo"
        : type === "config-reference" ? "no config-surface facts extracted from this repo"
        : type === "system-map" ? "no owned services (compose) and no multi-package workspace found - a one-node map would be noise"
        : type === "module-guide" ? "no unambiguous package - pass --package <name> (workspace repos have several)"
        : "no http-endpoints facts extracted from this repo";
      return emit(json, 2, { v: 1, ok: false, code: "NOT_AVAILABLE",
        summary: `${why} - nothing true to render`, data: {}, next: [] });
    }
    if (existsSync(join(root, rendered.path))) {
      return emit(json, 0, { v: 1, ok: true, code: "EXISTS",
        summary: `${rendered.path} already exists and is human-owned - keeldocs never overwrites; use keeldocs sync to refresh its generated regions`,
        data: { path: rendered.path }, next: ["keeldocs check", "keeldocs sync"] });
    }
    mkdirSync(dirname(join(root, rendered.path)), { recursive: true });
    writeFileSync(join(root, rendered.path), rendered.content);
    const redNote = sink.length ? ` - SECURITY: ${sink.length} secret(s) redacted, review before commit` : "";
    return emit(json, 0, { v: 1, ok: true, code: "CREATED",
      summary: `${rendered.path} created (born clean - anchored, hashed, drift-armed)${redNote}`,
      data: { path: rendered.path, ...(sink.length ? { redactions: sink } : {}) }, next: ["keeldocs check"] });
  } catch (err) {
    return emit(json, 2, { v: 1, ok: false, code: "TOOL_ERROR", summary: String(err.message).slice(0, 300), data: {}, next: [] });
  }
}
