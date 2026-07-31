// Provider registry LOADER - provider.yaml is the machine-read source (v0.2,
// audit item 1). The hardcoded REGISTRY array and its "keep them in lockstep"
// comment are gone; what ships in providers/ is what runs.
//
// Zero-dep discipline: this parses a strict YAML SUBSET that covers exactly
// the provider.yaml schema - top-level `key: value` lines, plain/quoted
// scalars, flow lists [a, "b"], flow maps { k: v, k2: [x] }, comments.
// Anything outside the subset is a loader error naming the file (ADR-013:
// a manifest that silently half-parses would lie about what is installed).
// Runner-owned keys (query config, verb maps) pass through untouched; the
// python runtime re-reads the SAME file with a full YAML parser.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ENGINE_ROOT = join(new URL(".", import.meta.url).pathname, "..");
const QUERY_RUNTIME = "providers/_runtime/tsq.py";

const KNOWN_KEYS = new Set([
  "id", "capability", "semver", "tier", "confidence", "entry", "runtime",
  "query", "language", "detect", "argMode", "needs", "inputs", "requires",
  "timeout_class", "emits", "status", "verbs", "files", "skip-files", "live",
]);
const DETECT_KEYS = new Set(["always", "deps", "files"]);

// ---------- strict YAML-subset parser ----------

function stripComment(line) {
  // trailing " #" comment, never inside quotes (subset: quotes contain no #)
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(s) {
  const t = s.trim();
  if (/^"([^"]*)"$/.test(t) || /^'([^']*)'$/.test(t)) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?[0-9]+$/.test(t)) return parseInt(t, 10);
  return t;
}

// Split a flow body on top-level commas (respecting nested [] {} and quotes).
function splitFlow(body, where) {
  const parts = [];
  let depth = 0, inS = false, inD = false, cur = "";
  for (const c of body) {
    if (inS) { cur += c; if (c === "'") inS = false; continue; }
    if (inD) { cur += c; if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; cur += c; continue; }
    if (c === '"') { inD = true; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (depth < 0) throw new Error(`${where}: unbalanced flow brackets`);
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseValue(raw, where) {
  const t = raw.trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new Error(`${where}: flow list must close on the same line`);
    return splitFlow(t.slice(1, -1), where).map((p) => parseValue(p, where));
  }
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw new Error(`${where}: flow map must close on the same line`);
    const out = {};
    for (const part of splitFlow(t.slice(1, -1), where)) {
      const i = flowKeyColon(part, where);
      out[parseScalar(part.slice(0, i))] = parseValue(part.slice(i + 1), where);
    }
    return out;
  }
  return parseScalar(t);
}

function flowKeyColon(part, where) {
  let inS = false, inD = false;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ":" && !inS && !inD) return i;
  }
  throw new Error(`${where}: flow map entry missing ':' (${part.slice(0, 40)})`);
}

export function parseProviderYaml(text, file) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const where = `${file}:${i + 1}`;
    const line = stripComment(lines[i]).replace(/\s+$/, "");
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) throw new Error(`${where}: block nesting is outside the provider.yaml subset (use flow [..] / {..})`);
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!m) throw new Error(`${where}: expected \`key: value\``);
    const [, key, rawVal] = m;
    if (!KNOWN_KEYS.has(key)) throw new Error(`${where}: unknown key \`${key}\``);
    if (key in out) throw new Error(`${where}: duplicate key \`${key}\``);
    if (rawVal === undefined || rawVal.trim() === "") throw new Error(`${where}: \`${key}\` has no value`);
    out[key] = parseValue(rawVal, where);
  }
  return out;
}

// ---------- scan + validate + order ----------

function validate(y, dir, file) {
  const need = (k, type) => {
    if (!(k in y)) throw new Error(`${file}: missing required key \`${k}\``);
    if (type === "string" && typeof y[k] !== "string") throw new Error(`${file}: \`${k}\` must be a string`);
  };
  need("id", "string"); need("capability", "string"); need("semver", "string"); need("tier", "string");
  if (!/^[a-z0-9-]+$/.test(y.capability)) throw new Error(`${file}: capability must be kebab-case`);
  if (typeof y.detect !== "object" || Array.isArray(y.detect)) throw new Error(`${file}: \`detect\` must be a flow map`);
  for (const k of Object.keys(y.detect)) {
    if (!DETECT_KEYS.has(k)) throw new Error(`${file}: detect.\`${k}\` unknown (known: ${[...DETECT_KEYS].join(", ")})`);
  }
  if (y.runtime !== undefined && y.runtime !== "query") throw new Error(`${file}: runtime must be \`query\` when present`);
  if (y.runtime === "query") {
    need("query", "string"); need("language", "string");
    if (!existsSync(join(dir, y.query))) throw new Error(`${file}: query file \`${y.query}\` not found`);
  } else {
    need("entry", "string");
    if (!existsSync(join(dir, y.entry))) throw new Error(`${file}: entry \`${y.entry}\` not found`);
  }
  if (y.needs !== undefined && !(Array.isArray(y.needs) && y.needs.every((n) => typeof n === "string"))) {
    throw new Error(`${file}: \`needs\` must be a list of capability names`);
  }
}

export function loadProviders(root = ENGINE_ROOT) {
  const provDir = join(root, "providers");
  const entries = [];
  for (const cap of readdirSync(provDir).sort()) {
    const capDir = join(provDir, cap);
    if (cap.startsWith("_") || !statSync(capDir).isDirectory()) continue;
    for (const id of readdirSync(capDir).sort()) {
      const dir = join(capDir, id);
      const yml = join(dir, "provider.yaml");
      if (!statSync(dir).isDirectory() || !existsSync(yml)) continue;
      const relFile = `providers/${cap}/${id}/provider.yaml`;
      const y = parseProviderYaml(readFileSync(yml, "utf8"), relFile);
      if (y.status === "stub") continue; // declared, not shipped - honestly absent
      validate(y, dir, relFile);
      if (y.capability !== cap) throw new Error(`${relFile}: capability \`${y.capability}\` != directory \`${cap}\``);
      // ${facts:<cap>} tokens in `inputs` are DECLARED CROSS-CAPABILITY READS
      // (provider contract §9): the engine hands the provider the upstream
      // capability's resolved fact file, and the read IS a dependency edge.
      const factInputs = (Array.isArray(y.inputs) ? y.inputs : [])
        .map((i) => (typeof i === "string" ? i.match(/^\$\{facts:([a-z0-9-]+)\}$/) : null))
        .filter(Boolean).map((m) => m[1]);
      entries.push({
        id: y.id, semver: y.semver, capability: y.capability, tier: y.tier,
        ...(y.confidence ? { confidence: y.confidence } : {}),
        detect: y.detect,
        argMode: y.argMode ?? (y.runtime === "query" ? "providerDir" : "root"),
        ...(y.runtime === "query"
          ? { runtime: "query", entry: QUERY_RUNTIME, dir }
          : { entry: `providers/${cap}/${id}/${y.entry.replace(/^\.\//, "")}`, dir }),
        factInputs,
        ...(y.live === true ? { live: true } : {}),
        timeoutClass: y.timeout_class ?? "D",
        needs: [...new Set([...(y.needs ?? []), ...factInputs])],
      });
    }
  }
  const dupes = entries.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new Error(`duplicate provider id(s): ${[...new Set(dupes)].join(", ")}`);

  // Execution order: topological over the CAPABILITY `needs` graph (a provider
  // needing workspace-layout runs after every workspace-layout provider), with
  // lexicographic (capability, id) tie-breaking - fully deterministic.
  const caps = [...new Set(entries.map((e) => e.capability))].sort();
  const needsOf = (cap) => [...new Set(entries.filter((e) => e.capability === cap).flatMap((e) => e.needs))];
  for (const cap of caps) {
    for (const n of needsOf(cap)) {
      if (!caps.includes(n)) throw new Error(`capability \`${cap}\` needs \`${n}\`, which no shipped provider satisfies`);
    }
  }
  const order = [];
  const placed = new Set();
  let guard = caps.length + 1;
  while (placed.size < caps.length && guard-- > 0) {
    for (const cap of caps) {
      if (placed.has(cap)) continue;
      if (needsOf(cap).every((n) => placed.has(n))) { order.push(cap); placed.add(cap); }
    }
  }
  if (placed.size < caps.length) {
    throw new Error(`capability \`needs\` cycle among: ${caps.filter((c) => !placed.has(c)).join(", ")}`);
  }
  const rank = new Map(order.map((c, i) => [c, i]));
  entries.sort((a, b) => rank.get(a.capability) - rank.get(b.capability)
    || a.capability.localeCompare(b.capability) || a.id.localeCompare(b.id));
  return entries;
}
