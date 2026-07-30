// Canonical JSON serialization - RFC 8785 (JCS) safe subset.
// keeldocs facts contain only strings, booleans, integers, null, arrays, objects.
// Floats are BANNED by ADR-003 (enumerated lattice, no scores) - we enforce, not assume.

export function jcs(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`jcs: non-integer number ${v} - floats are banned in facts (ADR-003)`);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(canonicalize);
  if (t === "object") {
    const out = {};
    // JCS orders member names by UTF-16 code units - JS default sort on strings.
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = canonicalize(v[k]);
    }
    return out;
  }
  throw new TypeError(`jcs: unsupported type ${t}`);
}
