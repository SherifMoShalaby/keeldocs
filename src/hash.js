// Fact and content hashing (ADR-008): SHA-256, algorithm version embedded ("h1:"),
// display truncated to 64 bits (16 hex). Cross-version comparison is invalid by
// definition and must re-baseline, never render as drift.

import { createHash } from "node:crypto";
import { jcs } from "./jcs.js";

export const HASH_VERSION = "h1";

export function factHash(payload) {
  return `${HASH_VERSION}:${sha256(jcs(payload))}`;
}

export function contentHash(bodyText) {
  return `${HASH_VERSION}:${sha256(normalizeBody(bodyText))}`;
}

// Body normalization for tamper detection: CRLF -> LF, strip trailing spaces
// per line, strip leading/trailing blank lines. Formatting-neutral, content-sensitive.
export function normalizeBody(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function display(hash) {
  // "h1:" + first 16 hex chars. Full digest lives in the derived index/report.
  const [ver, hex] = hash.split(":");
  return `${ver}:${hex.slice(0, 16)}`;
}

// Compare a recorded (possibly display-truncated) hash to a full current hash.
// Different algorithm versions are NOT comparable -> caller re-baselines.
export function hashesMatch(recorded, currentFull) {
  const [rv, rhex] = String(recorded).split(":");
  const [cv, chex] = String(currentFull).split(":");
  if (!rhex || !chex) return false;
  if (rv !== cv) return "version-mismatch";
  const n = Math.min(rhex.length, chex.length);
  return rhex.slice(0, n) === chex.slice(0, n);
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
