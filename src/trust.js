// T2 trust machinery (doc 11 R2, ADR-002's install contract). Third-party
// providers are ARBITRARY CODE; nothing executes unless three proofs hold:
//   1. a committed LOCK entry pins the sha256 of every installed file
//   2. the provider carries an ed25519 signature over its canonical manifest
//   3. the signer's public key is in the repo's TRUSTED set (keeldocs.toml)
// Any missing/failing proof is a REFUSAL (registry error, exit 2) that names
// the provider and the failed proof - never a silently smaller registry.
// Zero-dep: node:crypto ed25519; canonical bytes via jcs.

import { createHash, createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { jcs } from "./jcs.js";
import { toPosix } from "./paths.js";

export const SIG_FILE = "provider.sig";
export const LOCK_REL = ".keeldocs/providers.lock";

// Canonical manifest: sorted repo-relative posix paths -> sha256 of bytes.
// The signature file itself is excluded (it signs, it is not signed).
export function manifestOf(dir) {
  const files = {};
  const rec = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) rec(p, r);
      else if (name !== SIG_FILE) {
        files[toPosix(r)] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    }
  };
  rec(dir, "");
  return files;
}

export const manifestBytes = (files) => Buffer.from(jcs({ v: 1, files }));

// ---------- author side ----------

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export function signProvider(dir, privateKeyPem, signer) {
  const files = manifestOf(dir);
  const sig = sign(null, manifestBytes(files), createPrivateKey(privateKeyPem)).toString("base64");
  const rec = { v: 1, signer, sig };
  writeFileSync(join(dir, SIG_FILE), jcs(rec) + "\n");
  return rec;
}

// ---------- consumer side ----------

const keyFromB64 = (b64) =>
  createPublicKey({ key: Buffer.from(b64, "base64"), type: "spki", format: "der" });

// trusted keys come from keeldocs.toml [trust] keys = ["name:spki-base64", ...]
export function parseTrustedKeys(entries) {
  const out = new Map();
  for (const e of entries ?? []) {
    const i = e.indexOf(":");
    if (i < 1) throw new Error(`[trust] keys entries must be \`name:spki-base64\` (got ${e.slice(0, 24)})`);
    out.set(e.slice(0, i), e.slice(i + 1));
  }
  return out;
}

// Verify one installed provider dir against its lock entry + trusted keys.
// Returns null when every proof holds; otherwise the refusal reason.
export function refusalOf(dir, lockEntry, trustedKeys) {
  if (!lockEntry) return "not in providers.lock (install it with `keeldocs provider add`)";
  const sigPath = join(dir, SIG_FILE);
  if (!existsSync(sigPath)) return "unsigned (no provider.sig)";
  let rec;
  try { rec = JSON.parse(readFileSync(sigPath, "utf8")); } catch { return "provider.sig is not valid JSON"; }
  if (typeof rec.signer !== "string" || typeof rec.sig !== "string") return "provider.sig is missing signer/sig";
  const keyB64 = trustedKeys.get(rec.signer);
  if (!keyB64) return `signer \`${rec.signer}\` is not trusted (add via \`keeldocs provider trust\`)`;
  const files = manifestOf(dir);
  const want = lockEntry.files ?? {};
  const paths = new Set([...Object.keys(files), ...Object.keys(want)]);
  for (const p of [...paths].sort()) {
    if (files[p] !== want[p]) return `file hash mismatch at \`${p}\` (installed tree != providers.lock)`;
  }
  let ok = false;
  try { ok = verify(null, manifestBytes(files), keyFromB64(keyB64), Buffer.from(rec.sig, "base64")); }
  catch { return "signature verification errored (malformed key or sig)"; }
  if (!ok) return "signature does not verify against the trusted key";
  return null;
}

// ---------- lock file (committed, jcs lines, one per provider) ----------

export function loadLock(repoRoot) {
  const p = join(repoRoot, LOCK_REL);
  const out = new Map();
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.capability === "string" && typeof e.id === "string") {
        out.set(`${e.capability}/${e.id}`, e);
      }
    } catch { /* malformed lock lines surface as missing entries -> refusal */ }
  }
  return out;
}

export function writeLock(repoRoot, entries) {
  const lines = [...entries.values()]
    .sort((a, b) => `${a.capability}/${a.id}`.localeCompare(`${b.capability}/${b.id}`))
    .map((e) => jcs(e));
  writeFileSync(join(repoRoot, LOCK_REL), lines.join("\n") + (lines.length ? "\n" : ""));
}
