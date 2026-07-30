// Doc lie-detector (init's wow, ADR-012/D5). Ported from the validated E4
// prototype (100% finding precision on real repos, n=2 - see experiments/e4).
// Five deterministic check classes over README + docs; every finding carries
// a RECEIPT from a command actually run. Precision beats recall everywhere:
// the E4 lesson is that suppression IS the product - untuned raw precision
// was ~6%; the taxonomy below is what made it 100%.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { candidatesFor } from "./drift.js";

const CODE_EXT = /\.(m?js|ts|tsx|py|rb|go|java|prisma|ya?ml|toml|json)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".keeldocs", "golden", "docs", "coverage"]);

function codeFiles(root, out = [], dir = root) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) codeFiles(root, out, p);
    else if (CODE_EXT.test(name)) out.push(p);
  }
  return out;
}

// ---- suppression taxonomy (E4) ----
const PLACEHOLDER = /(path\/to|your[-_]|my[-_]|<[^>]+>|\{\{|\.\.\.|\bfoo\b|\bexample\.com\b|\*|x{3,})/i;
const CONVENTIONAL = /^(\.env(\..+)?|dist|build|node_modules|coverage|\.git|tmp|out)(\/.*)?$/;
const IMPERATIVE = /\b(create|touch|mkdir|add|save|write|generate|output|will (be )?(create|generate)|new file)\b/i;
const TREE_CHARS = /[│├└┬─]{1,}|^\s*[|`]--/;
const SCRIPT_BUILTINS = new Set(["install", "ci", "i", "add", "remove", "init", "create", "publish",
  "audit", "link", "exec", "dlx", "upgrade", "why", "version", "login", "config"]);
const ENV_STOPLIST = new Set(["NODE_ENV", "CI", "PATH", "HOME", "PWD", "TZ", "LANG", "DEBUG",
  "NODE_OPTIONS", "NPM_TOKEN", "GITHUB_TOKEN"]);

function gitDeletionReceipt(root, relPath) {
  const r = spawnSync("git", ["log", "--diff-filter=D", "--format=%h %cs", "--follow", "--", relPath],
    { cwd: root, encoding: "utf8" });
  const first = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
  if (first) {
    const [sha, date] = first.split(" ");
    return `deleted in ${sha} (${date})`;
  }
  return "not found in the repo; no deletion record in reachable history";
}

export function detectLies({ root, docPaths, factsById, pkg }) {
  const findings = [];
  let suppressed = 0;

  // Pre-scan code for env reads and computed access.
  const files = codeFiles(root);
  const envReads = new Set();
  let computedEnvAccess = false;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envReads.add(m[1]);
    for (const m of text.matchAll(/\benv\(["']([A-Z][A-Z0-9_]*)["']\)/g)) envReads.add(m[1]);
    if (/process\.env\[/.test(text)) computedEnvAccess = true;
  }
  const scripts = pkg?.scripts ?? {};
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const endpointPaths = new Set([...factsById.keys()]
    .filter((id) => id.startsWith("fact:http-endpoints/"))
    .map((id) => id.slice("fact:http-endpoints/".length)));
  const hasEndpoints = endpointPaths.size > 0;

  const add = (cls, claim, doc, line, receipt, extra = {}) =>
    findings.push({ class: cls, claim, doc, line, receipt, ...extra });

  for (const doc of docPaths) {
    const text = readFileSync(join(root, doc), "utf8");
    const lines = text.split("\n");
    lines.forEach((lineText, i) => {
      const line = i + 1;
      if (TREE_CHARS.test(lineText)) { return; } // ASCII tree diagrams
      const imperative = IMPERATIVE.test(lineText);

      // A. file-path claims (backticked paths or relative link targets)
      for (const m of lineText.matchAll(/`([^`\s]{2,120})`/g)) {
        const tok = m[1];
        const pathLike = tok.includes("/") || /^[\w.-]+\.(js|ts|mjs|json|md|ya?ml|sh|py|sql|prisma|env|toml)$/.test(tok);
        if (!pathLike || /^https?:/.test(tok) || tok.includes("=") || tok.startsWith("-")) continue;
        if (PLACEHOLDER.test(tok) || CONVENTIONAL.test(tok) || imperative) { suppressed++; continue; }
        if (!tok.includes("/") && tok in deps) { suppressed++; continue; } // dep names like chart.js
        const rel = tok.replace(/^\.\//, "");
        if (!existsSync(join(root, rel))) {
          add("file-claim", tok, doc, line, gitDeletionReceipt(root, rel));
        }
      }

      // B. npm script claims
      for (const m of lineText.matchAll(/\b(?:npm run|yarn|pnpm run|pnpm|npm)\s+([a-z][a-z0-9:_-]{1,40})\b/g)) {
        const name = m[1];
        if (SCRIPT_BUILTINS.has(name) || name === "run") continue;
        if (!(name in scripts)) {
          add("script-claim", `npm run ${name}`, doc, line,
            `no "${name}" in package.json scripts (${Object.keys(scripts).sort().join(", ") || "none"})`);
        }
      }

      // C. env-var claims (documented but read nowhere)
      if (!computedEnvAccess) {
        for (const m of lineText.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
          const name = m[1];
          if (ENV_STOPLIST.has(name) || envReads.has(name)) continue;
          if (imperative && !lineText.includes(name + "=")) { /* still a claim */ }
          if (!/`|env|variable|export|=/.test(lineText)) { suppressed++; continue; } // prose acronym, not an env claim
          add("env-claim", name, doc, line,
            `read nowhere in code (scanned ${files.length} files for process.env.${name} / env("${name}"))`);
        }
      }

      // D. internal markdown links
      for (const m of lineText.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+?)(?:#[^)]*)?\)/g)) {
        const rel = m[1].replace(/^\.\//, "");
        if (PLACEHOLDER.test(rel)) { suppressed++; continue; }
        if (!existsSync(join(root, rel))) {
          add("link-claim", m[1], doc, line, gitDeletionReceipt(root, rel));
        }
      }

      // E. route claims vs extracted facts (the check E4 couldn't do - we have real facts)
      if (hasEndpoints) {
        for (const m of lineText.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\/:{}.\-]*)/g)) {
          // sentence punctuation is not part of a path (E4 precision discipline)
          const path = m[2].replace(/[.,;:!?)]+$/, "");
          const key = `${m[1]} ${path.replace(/\{(\w+)\}/g, ":$1")}`;
          if (endpointPaths.has(key)) continue;
          const factId = `fact:http-endpoints/${key}`;
          add("route-claim", `${m[1]} ${path}`, doc, line,
            "no matching route registration in extracted endpoints",
            { candidates: candidatesFor(factId, factsById) });
        }
        for (const m of lineText.matchAll(/curl[^\n]*?https?:\/\/[^\/\s]+(\/[\w\/:{}.\-]*)/g)) {
          const p = m[1].replace(/[.,;:!?)]+$/, "").replace(/\{(\w+)\}/g, ":$1");
          if ([...endpointPaths].some((e) => e.endsWith(" " + p))) continue;
          add("route-claim", `curl ...${m[1]}`, doc, line,
            "no route registration matches this path",
            { candidates: candidatesFor(`fact:http-endpoints/GET ${p}`, factsById) });
        }
      }
    });
  }

  findings.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line || a.claim.localeCompare(b.claim));
  return { findings, suppressed, scannedCodeFiles: files.length,
           notes: computedEnvAccess ? ["env-claim checks skipped: computed process.env[...] access present"] : [] };
}
