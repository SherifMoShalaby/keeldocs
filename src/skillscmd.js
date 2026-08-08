// `keeldocs skills install` - put the Agent Skills where a given agent looks.
//
// This exists because E7 proved the distribution bet works and then the review
// found there was no shipped way to take it: the README told users to copy
// node_modules/keeldocs/skills, which does not exist after `npx`, lands nested
// if the target directory already exists, and ships frontmatter that Codex and
// Cursor reject. experiments/ is not in package.json files[], so the installer
// that already did this correctly never reached a single npm user.
//
// Everything is READ FROM adapters/<agent>/manifest.yaml - install path, which
// frontmatter keys that agent chokes on, whether it also wants the AGENTS.md
// fallback block. Same contract as experiments/e7-agent-matrix/install-skills.py,
// deliberately: if the manifest and an installer could disagree, the manifest
// would be documentation rather than configuration.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
// The ceiling on the whole skills listing an agent loads. 8000 is Codex's
// published number (ADR-010) and applies when a manifest states nothing, which
// is not the same as knowing the agent's cap: no cap has ever been measured for
// Claude Code or Cursor, and dropping the enforcement for them on that basis
// would be its own over-claim. An agent that publishes a different number says
// so with `listing_cap:` in its own manifest.
//
// It lived here as a constant until 2026-08-08, when the R7 breaking-change
// drill (experiments/r7-break-drill/) found it was the one thing about an agent
// that the adapter layer could not express - so "an agent lowered its cap" was
// the one break class in four that required editing this file. That is the
// disagreement the header of this file already warns about: a manifest that
// cannot carry a value is documentation, not configuration.
const DEFAULT_LISTING_CAP = 8000;

/** Flat `key: value` YAML with # comments and [a, b] lists. Nothing else is
 *  allowed in these manifests, so nothing else is parsed. */
function loadManifest(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line || !line.includes(":")) continue;
    const i = line.indexOf(":");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      out[k] = v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
    } else if (v === "true" || v === "false") out[k] = v === "true";
    else out[k] = v;
  }
  return out;
}

/** The agent's listing cap, or `null` if its manifest states an unusable one.
 *  A cap that cannot be read is refused rather than silently defaulted: falling
 *  back to 8000 on a typo would report a budget no agent published. */
export function listingCap(m) {
  if (!("listing_cap" in m)) return DEFAULT_LISTING_CAP;
  const raw = m.listing_cap;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function splitFrontmatter(text, where) {
  if (!text.startsWith("---")) throw new Error(`${where}: SKILL.md without frontmatter - refusing to guess`);
  const parts = text.split("---");
  return { fm: parts[1].replace(/^\n|\n$/g, "").split("\n"), body: parts.slice(2).join("---") };
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dest, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

export function listAgents() {
  return readdirSync(join(PKG_ROOT, "adapters")).filter((a) =>
    existsSync(join(PKG_ROOT, "adapters", a, "manifest.yaml"))).sort();
}

export function installSkills({ agent, root, dryRun = false }) {
  const agents = listAgents();
  if (!agents.includes(agent)) {
    return { ok: false, code: "USAGE", summary: `no adapter for '${agent}'; have: ${agents.join(", ")}`, data: {} };
  }
  const m = loadManifest(join(PKG_ROOT, "adapters", agent, "manifest.yaml"));
  const drop = new Set(m.strip_fields || []);
  const cap = listingCap(m);
  if (cap === null) {
    return { ok: false, code: "TOOL_ERROR", data: { agent, listing_cap: m.listing_cap },
      summary: `adapters/${agent}/manifest.yaml: listing_cap must be a positive integer` };
  }
  const srcRoot = join(PKG_ROOT, "skills");
  const destRoot = join(root, m.skills_dir);

  // Two passes on purpose. The cap is decided before anything is written, so a
  // listing the agent will truncate leaves nothing on disk - the single pass
  // this replaced wrote every skill and THEN returned TOOL_ERROR, which is a
  // refusal in the envelope and an install on the filesystem saying different
  // things about the same run.
  const planned = [];
  let listing = 0;
  for (const name of readdirSync(srcRoot).sort()) {
    const src = join(srcRoot, name, "SKILL.md");
    if (!existsSync(src)) continue;
    const { fm, body } = splitFrontmatter(readFileSync(src, "utf8"), name);
    const kept = fm.filter((l) => !drop.has(l.split(":")[0].trim()));
    for (const l of kept) {
      const k = l.split(":")[0].trim();
      if (k === "name" || k === "description") listing += l.length;
    }
    planned.push({ name, kept, body });
  }

  if (listing > cap) {
    return { ok: false, code: "TOOL_ERROR", data: { listing, cap },
      summary: `skills listing ${listing} chars exceeds the ${cap} cap for ${agent}` };
  }

  const written = [];
  for (const { name, kept, body } of planned) {
    // The skill's own directory, never a nested copy of skills/ - `cp -r` into an
    // existing target produced .claude/skills/skills/check/SKILL.md, which an
    // agent never sees and which fails silently.
    const destDir = join(destRoot, name);
    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(join(destDir, "SKILL.md"), `---\n${kept.join("\n")}\n---${body}`, "utf8");
      for (const extra of readdirSync(join(srcRoot, name))) {
        if (extra === "SKILL.md") continue;
        const s = join(srcRoot, name, extra);
        statSync(s).isDirectory() ? copyTree(s, join(destDir, extra)) : copyFileSync(s, join(destDir, extra));
      }
    }
    written.push(`${m.skills_dir}/${name}/SKILL.md`);
  }

  let agentsMd = null;
  if (m.agents_md_block) {
    const block = readFileSync(join(PKG_ROOT, "AGENTS.md"), "utf8").trim();
    const dest = join(root, "AGENTS.md");
    const existing = existsSync(dest) ? readFileSync(dest, "utf8") : "";
    if (existing.includes("keeldocs - agent instructions")) agentsMd = "already present, left alone";
    else {
      if (!dryRun) writeFileSync(dest, (existing.trim() ? existing + "\n\n" : "") + block + "\n", "utf8");
      agentsMd = dryRun ? "would be appended" : "appended";
    }
  }

  return { ok: true, code: dryRun ? "DRY_RUN" : "INSTALLED",
    summary: `${written.length} skill(s) ${dryRun ? "would be written" : "written"} to ${m.skills_dir}`
      + (agentsMd ? `; AGENTS.md ${agentsMd}` : "") + `; listing ${listing}/${cap}`,
    data: { agent, skills_dir: m.skills_dir, written, listing, cap,
      stripped: [...drop], agents_md: agentsMd } };
}
