// Redaction barrier (ADR-013) - the single choke point between generated
// content and committed artifacts. Generated docs are a secret-exfiltration
// channel (env surfaces, DSN-bearing driver errors, history mining); this
// barrier guarantees a matched secret never lands: it is substituted with
// [REDACTED:<rule>] and reported LOUDLY. High precision beats recall here -
// the E4 lesson applies: a barrier that cries wolf gets disabled.

export const RULESET_VERSION = "kd-redact-1";

// High-precision pattern rules (gitleaks-inspired core, embedded - no binary dep).
const RULES = [
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { id: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z\-]{10,250}\b/g },
  { id: "stripe-key", re: /\b[sr]k_live_[0-9a-zA-Z]{10,99}\b/g },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}T3BlbkFJ[A-Za-z0-9_\-]{20,}\b|\bsk-[A-Za-z0-9]{48}\b/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g },
  { id: "supabase-service-jwt", re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { id: "dsn-userinfo", re: /\b[a-z][a-z0-9+.\-]{1,20}:\/\/[^\/\s:@'"`]{1,64}:[^@\s'"`]{1,128}@[^\s'"`]{1,200}/g },
  { id: "twilio-key", re: /\bSK[0-9a-f]{32}\b/g },
];

// Entropy rule for long opaque token-shaped runs the patterns miss.
// Context exemptions keep keeldocs's own artifacts quiet:
//   - h1:<hex> fact/content hashes (any length)
//   - sha256:<hex> provenance blob hashes
//   - pure hex runs (checksums/ids) - covered by the two above in practice,
//     but plain hex carries no alphabet mix and is exempt outright
const ENTROPY_CANDIDATE = /\b[A-Za-z0-9+\/=_\-]{40,}\b/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

function shannon(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const [, n] of freq) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function entropyHits(text) {
  const hits = [];
  for (const m of text.matchAll(ENTROPY_CANDIDATE)) {
    const tok = m[0];
    if (HEX_ONLY.test(tok)) continue;                       // hashes/checksums
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:h1:|sha256:)$/.test(before)) continue;          // keeldocs hash contexts
    if (/^[A-Za-z]+$/.test(tok) || /^[0-9]+$/.test(tok)) continue; // words/numbers
    if (shannon(tok) >= 4.4) hits.push({ index: m.index, token: tok });
  }
  return hits;
}

// Scan text; returns { clean, redactions } where clean has every hit replaced
// by [REDACTED:<rule>]. options.entropy=false for hash-heavy machine files
// (fact JSONL, journal) where pattern rules alone apply (ADR-013 context tuning).
export function redact(text, options = {}) {
  const entropy = options.entropy !== false;
  const redactions = [];
  let clean = text;
  for (const rule of RULES) {
    clean = clean.replace(rule.re, (match) => {
      redactions.push({ rule: rule.id, sample: match.slice(0, 8) + "..." });
      return `[REDACTED:${rule.id}]`;
    });
  }
  if (entropy) {
    for (const hit of entropyHits(clean)) {
      redactions.push({ rule: "high-entropy", sample: hit.token.slice(0, 8) + "..." });
      clean = clean.split(hit.token).join("[REDACTED:high-entropy]");
    }
  }
  return { clean, redactions, ruleset: RULESET_VERSION };
}

// The write gate for doc artifacts. Never throws over a finding - the secret
// is neutralized and the caller is REQUIRED to surface `redactions` in its
// envelope (silence would defeat the human-acknowledgment requirement).
import { writeFileSync } from "node:fs";
export function safeWriteDoc(path, content, options = {}) {
  const r = redact(content, options);
  writeFileSync(path, r.clean);
  return r.redactions;
}
