// keeldocs.toml - the entire v0.1 config surface, loaded by every command.
// Schema-strict (ADR-013 discipline): unknown sections, unknown keys, wrong
// value shapes, and unknown provider ids are CONFIG errors (exit 2), never
// silently ignored - a typo'd key that quietly no-ops lies about what is
// configured. Zero-dep by design: this is a deliberate strict SUBSET of TOML
// (sections, string/bool/integer values, single-line string arrays, comments),
// which covers the whole schema below; anything outside the subset is an error.
//
//   [providers]
//   disable = ["compose", "git-log"]   # provider ids to skip this repo
//
//   [docs]
//   dirs = ["docs", "handbook"]        # scan roots (default ["docs"]); README.md is always scanned

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REGISTRY, REGISTRY_ERROR } from "./registry.js";

const SCHEMA = {
  providers: { disable: "string[]" },
  docs: { dirs: "string[]" },
  live: { "dsn-env": "string" }, // the NAME of the env var holding the DSN - never the DSN
};

const DEFAULTS = () => ({ providers: { disable: [] }, docs: { dirs: ["docs"] },
  live: { "dsn-env": "DATABASE_URL" } });

function parseValue(raw, where) {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^"([^"\\]*)"$/.test(s)) return s.slice(1, -1);
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`${where}: arrays must be single-line`);
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((p) => {
      const t = p.trim();
      const m = t.match(/^"([^"\\]*)"$/);
      if (!m) throw new Error(`${where}: array items must be double-quoted strings (got ${t.slice(0, 40)})`);
      return m[1];
    });
  }
  throw new Error(`${where}: unsupported value \`${s.slice(0, 40)}\` (strings, booleans, integers, ["a","b"] arrays only)`);
}

export function parseToml(text) {
  const out = {};
  let section = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const where = `keeldocs.toml:${i + 1}`;
    const line = lines[i].replace(/(^|\s)#.*$/, "").trim(); // comments (values here never contain '#')
    if (line === "") continue;
    const sec = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (sec) {
      section = sec[1];
      if (!(section in SCHEMA)) throw new Error(`${where}: unknown section [${section}] (known: ${Object.keys(SCHEMA).join(", ")})`);
      out[section] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`${where}: expected \`key = value\` or \`[section]\``);
    if (!section) throw new Error(`${where}: keys must live under a [section]`);
    const [, key, rawVal] = kv;
    const want = SCHEMA[section][key];
    if (!want) throw new Error(`${where}: unknown key \`${key}\` in [${section}] (known: ${Object.keys(SCHEMA[section]).join(", ")})`);
    const val = parseValue(rawVal, where);
    if (want === "string[]" && !(Array.isArray(val) && val.every((v) => typeof v === "string"))) {
      throw new Error(`${where}: \`${key}\` must be an array of strings`);
    }
    if (key in out[section]) throw new Error(`${where}: duplicate key \`${key}\``);
    out[section][key] = val;
  }
  return out;
}

// Returns { ok: true, config } or { ok: false, error } - commands emit the
// error as a CONFIG envelope with exit 2 and touch nothing.
export function loadConfig(root) {
  const cfg = DEFAULTS();
  const path = join(root, "keeldocs.toml");
  if (!existsSync(path)) return { ok: true, config: cfg };
  let parsed;
  try {
    parsed = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
  for (const [sec, keys] of Object.entries(parsed)) {
    for (const [k, v] of Object.entries(keys)) cfg[sec][k] = v;
  }
  if (!REGISTRY_ERROR) { // a broken registry is extractAll's loud failure, not config's
    const ids = new Set(REGISTRY.map((r) => r.id));
    for (const id of cfg.providers.disable) {
      if (!ids.has(id)) {
        return { ok: false, error: `keeldocs.toml: [providers] disable names unknown provider \`${id}\` (known: ${[...ids].sort().join(", ")})` };
      }
    }
  }
  if (cfg.docs.dirs.some((d) => d.startsWith("/") || d.includes(".."))) {
    return { ok: false, error: "keeldocs.toml: [docs] dirs must be repo-relative paths without `..`" };
  }
  return { ok: true, config: cfg };
}

// Shared doc discovery for every command: configured scan roots + README.md,
// repo-relative, deduped, sorted (was triplicated across check/init/sync).
export function docPathsOf(root, dirs) {
  const out = [];
  const skip = new Set([".keeldocs", "node_modules", "golden", ".git"]);
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith(".md")) out.push(relative(root, p));
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) rec(join(root, d));
  if (existsSync(join(root, "README.md"))) out.push("README.md");
  return [...new Set(out)].sort();
}
