// Anchor + region parser (spec/anchor-spec.md). Schema-strict by design (ADR-013):
// fixed key sets, shaped values, length caps, unknown keys => the whole marker is
// QUARANTINED as inert data (never an error, never echoed raw into agent context).
//
// Marker forms:
//   <!-- keeldocs: id=X recipe=name@1 binds=ID[,ID...] hash-kind=fact|shape -->   section anchor
//   <!-- keeldocs:gen id=X [binds=...] hash=h1:HEX [content=h1:HEX] -->body<!-- /keeldocs:gen -->
//   <!-- keeldocs:slot id=X [...] -->body<!-- /keeldocs:slot -->
//
// Value parsing rule: values may contain spaces (endpoint natural keys like
// "fact:http-endpoints/GET /orders"); a value runs until the next `<key>=` token
// from the marker's fixed key set, or end of marker. Multiple binds separated by ",".

const ANCHOR_KEYS = ["id", "recipe", "binds", "hash-kind"];
const GEN_KEYS = ["id", "binds", "hash", "content"];
const SLOT_KEYS = ["id", "binds", "hash", "max-words"]; // hash = fact state at last slot-write
const MAX_VALUE = 200;

const ID_RE = /^[A-Za-z0-9_.:\-]{1,200}$/;
const BIND_RE = /^(fact:[a-z0-9-]+\/[^,]{1,200}|ds [^,]{1,200})$/; // fact natural key or SCIP-shaped symbol
const HASH_RE = /^h[0-9]+:[0-9a-f]{8,64}$/;

function parseKV(body, keys) {
  // Split on known-key boundaries so values may contain spaces.
  const keyAlt = keys.map((k) => k.replace(/[-]/g, "\\-")).join("|");
  const re = new RegExp(`\\b(${keyAlt})=`, "g");
  const hits = [];
  let m;
  while ((m = re.exec(body)) !== null) hits.push({ key: m[1], start: m.index, vstart: re.lastIndex });
  if (hits.length === 0) return { error: "no-keys" };
  // Anything before the first key that isn't whitespace => unknown content.
  if (body.slice(0, hits[0].start).trim() !== "") return { error: "unknown-key" };
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : body.length;
    const raw = body.slice(hits[i].vstart, end).trim();
    if (raw.length === 0 || raw.length > MAX_VALUE * 8) return { error: `bad-value:${hits[i].key}` };
    if (out[hits[i].key] !== undefined) return { error: `duplicate-key:${hits[i].key}` };
    // A stray `foo=` inside a value region would have matched only if foo is a known
    // key; genuinely unknown keys therefore surface as value text - reject `=` followed
    // by nothing we know, when it looks like an attempted key at a token boundary.
    if (/(^|\s)[A-Za-z][A-Za-z0-9-]*=(?!=)/.test(raw)) return { error: "unknown-key" };
    out[hits[i].key] = raw;
  }
  return { kv: out };
}

function parseBinds(raw) {
  const binds = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.length > MAX_VALUE) return null;
    const wildcard = part.endsWith("/*");
    const core = wildcard ? part.slice(0, -2) : part;
    if (wildcard) {
      if (!/^fact:[a-z0-9-]+(\/[^,]*)?$/.test(core)) return null;
    } else if (!BIND_RE.test(part)) {
      return null;
    }
    binds.push({ raw: part, wildcard, prefix: wildcard ? core + "/" : null });
  }
  return binds.length ? binds : null;
}

export function parseDoc(text, docPath) {
  const anchors = [];
  const regions = [];
  const quarantined = [];
  const lines = text.split("\n");
  const lineOf = (idx) => text.slice(0, idx).split("\n").length;

  // Tag grammar: "keeldocs:" = section anchor, "keeldocs:gen"/"keeldocs:slot" = regions.
  const MARKER = /<!--\s*(\/?)keeldocs(:gen|:slot|:)\s*([^>]*?)\s*-->/g;
  const openStack = [];
  let m;
  while ((m = MARKER.exec(text)) !== null) {
    const [whole, closing, kind, body] = m;
    const line = lineOf(m.index);
    if (closing === "/") {
      const want = kind === ":gen" ? "gen" : kind === ":slot" ? "slot" : null;
      const top = openStack[openStack.length - 1];
      if (!want || !top || top.kind !== want) {
        quarantined.push({ doc: docPath, line, reason: "unbalanced-close" });
        continue;
      }
      openStack.pop();
      top.body = text.slice(top.bodyStart, m.index);
      regions.push(top);
      continue;
    }
    if (kind === ":gen" || kind === ":slot") {
      const keys = kind === ":gen" ? GEN_KEYS : SLOT_KEYS;
      const r = parseKV(body, keys);
      if (r.error) { quarantined.push({ doc: docPath, line, reason: r.error }); continue; }
      const kv = r.kv;
      if (!kv.id || !ID_RE.test(kv.id)) { quarantined.push({ doc: docPath, line, reason: "bad-id" }); continue; }
      const region = {
        kind: kind.slice(1), id: kv.id, doc: docPath, line,
        binds: kv.binds !== undefined ? parseBinds(kv.binds) : undefined,
        hash: kv.hash, content: kv.content,
        bodyStart: m.index + whole.length,
      };
      if (kv.binds !== undefined && region.binds === null) { quarantined.push({ doc: docPath, line, reason: "bad-binds" }); continue; }
      if (kv.hash !== undefined && !HASH_RE.test(kv.hash)) {
        quarantined.push({ doc: docPath, line, reason: "bad-hash" }); continue;
      }
      if (kv["max-words"] !== undefined) {
        if (!/^[0-9]{1,4}$/.test(kv["max-words"])) { quarantined.push({ doc: docPath, line, reason: "bad-max-words" }); continue; }
        region.maxWords = parseInt(kv["max-words"], 10);
      }
      if (kv.content !== undefined && !HASH_RE.test(kv.content)) {
        quarantined.push({ doc: docPath, line, reason: "bad-content-hash" }); continue;
      }
      openStack.push(region);
      continue;
    }
    // section anchor
    const r = parseKV(body, ANCHOR_KEYS);
    if (r.error) { quarantined.push({ doc: docPath, line, reason: r.error }); continue; }
    const kv = r.kv;
    if (!kv.id || !ID_RE.test(kv.id)) { quarantined.push({ doc: docPath, line, reason: "bad-id" }); continue; }
    if (kv.recipe !== undefined && !/^[a-z0-9-]+@[0-9]+$/.test(kv.recipe)) {
      quarantined.push({ doc: docPath, line, reason: "bad-recipe" }); continue;
    }
    const hashKind = kv["hash-kind"] ?? "fact";
    if (!["fact", "shape"].includes(hashKind)) { quarantined.push({ doc: docPath, line, reason: "bad-hash-kind" }); continue; }
    const binds = kv.binds !== undefined ? parseBinds(kv.binds) : [];
    if (binds === null) { quarantined.push({ doc: docPath, line, reason: "bad-binds" }); continue; }
    anchors.push({ id: kv.id, recipe: kv.recipe, binds, hashKind, doc: docPath, line });
  }
  for (const open of openStack) {
    quarantined.push({ doc: docPath, line: open.line, reason: `unclosed-${open.kind}` });
  }
  // deterministic ordering
  anchors.sort((a, b) => a.line - b.line);
  regions.sort((a, b) => a.line - b.line);
  return { anchors, regions, quarantined, lineCount: lines.length };
}

// A gen/slot region inherits binds from the anchor whose id is the longest
// dot-prefix of the region id (convention: erd.orders.columns under erd.orders).
export function inheritBinds(region, anchors) {
  if (region.binds && region.binds.length) return region.binds;
  let best = null;
  for (const a of anchors) {
    if (region.id === a.id || region.id.startsWith(a.id + ".")) {
      if (!best || a.id.length > best.id.length) best = a;
    }
  }
  return best ? best.binds : [];
}
