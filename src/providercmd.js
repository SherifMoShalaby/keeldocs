// keeldocs provider - the T2 install/trust surface (doc 11 R2, ADR-002).
//   keygen              author: mint an ed25519 keypair (private stays local)
//   sign <dir>          author: sign the provider dir's canonical manifest
//   trust <name> <key>  consumer: add a signer to keeldocs.toml [trust] keys
//   add <dir>           consumer: verify (signature + trusted signer) THEN
//                       copy into .keeldocs/providers/ and pin every file
//                       hash into .keeldocs/providers.lock - refusal first,
//                       installation second, never the other way around
// Local paths only in v0.3 (the PR-review flow: vendor the dir, review it,
// add it); git-url install waits for a fetch story with the same proofs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { generateKeypair, signProvider, manifestOf, refusalOf, loadLock, writeLock, parseTrustedKeys, SIG_FILE, LOCK_REL } from "./trust.js";
import { parseProviderYaml } from "./providers.js";
import { loadConfig } from "./config.js";

const out = (json, exit, code, summary, data = {}, next = []) => {
  const env = { v: 1, ok: exit === 0, code, summary: String(summary).slice(0, 300), data, truncated: false, next };
  process.stdout.write(json ? JSON.stringify(env) + "\n" : `${code}: ${env.summary}\n`);
  return exit;
};

export function runProviderCmd({ root, json, args }) {
  const pos = args.filter((a) => !a.startsWith("--"));
  const sub = pos[1];

  if (sub === "keygen") {
    const kp = generateKeypair();
    const keyPath = join(root, "keeldocs-signing-key.pem");
    if (existsSync(keyPath)) return out(json, 2, "EXISTS", `refusing to overwrite ${basename(keyPath)}`);
    writeFileSync(keyPath, kp.privateKeyPem, { mode: 0o600 });
    return out(json, 0, "KEY_GENERATED",
      "ed25519 keypair minted; the PRIVATE key stays local (never commit it) - hand consumers only the public key",
      { privateKey: "keeldocs-signing-key.pem", publicKeyB64: kp.publicKeyB64 },
      ["keeldocs provider sign <dir> --key keeldocs-signing-key.pem --signer <name>"]);
  }

  if (sub === "sign") {
    const dir = pos[2] && resolve(root, pos[2]);
    const kIdx = args.indexOf("--key"), sIdx = args.indexOf("--signer");
    if (!dir || kIdx === -1 || sIdx === -1) {
      return out(json, 2, "USAGE", "usage: keeldocs provider sign <dir> --key <pem> --signer <name>");
    }
    if (!existsSync(join(dir, "provider.yaml"))) return out(json, 2, "CONFIG", `${pos[2]} has no provider.yaml`);
    const rec = signProvider(dir, readFileSync(args[kIdx + 1], "utf8"), args[sIdx + 1]);
    return out(json, 0, "SIGNED", `manifest signed by \`${rec.signer}\` -> ${pos[2]}/${SIG_FILE}`,
      { signer: rec.signer, files: Object.keys(manifestOf(dir)).length });
  }

  if (sub === "trust") {
    const [, , name, key] = pos;
    if (!name || !key) return out(json, 2, "USAGE", "usage: keeldocs provider trust <name> <spki-base64>");
    if (name.includes(":")) return out(json, 2, "USAGE", "signer names must not contain ':'");
    const tomlPath = join(root, "keeldocs.toml");
    const text = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    if (text.includes(`"${name}:`)) return out(json, 2, "EXISTS", `signer \`${name}\` is already trusted`);
    // append-only edit of the schema-strict toml: extend [trust] keys or create it
    const entry = `"${name}:${key}"`;
    let next_;
    const m = text.match(/(\[trust\][^[]*keys\s*=\s*\[)([^\]]*)(\])/);
    if (m) next_ = text.replace(m[0], `${m[1]}${m[2].trim() ? m[2].trim() + ", " : ""}${entry}${m[3]}`);
    else next_ = (text ? text.replace(/\n*$/, "\n\n") : "") + `[trust]\nkeys = [${entry}]\n`;
    writeFileSync(tomlPath, next_);
    const check = loadConfig(root);
    if (!check.ok) return out(json, 2, "TOOL_ERROR", `trust edit broke keeldocs.toml: ${check.error}`);
    return out(json, 0, "TRUSTED", `signer \`${name}\` added to [trust] keys (commit keeldocs.toml)`,
      { name }, ["keeldocs provider add <dir>"]);
  }

  if (sub === "add") {
    const srcDir = pos[2] && resolve(root, pos[2]);
    if (!srcDir) return out(json, 2, "USAGE", "usage: keeldocs provider add <local-provider-dir>");
    const ymlPath = join(srcDir, "provider.yaml");
    if (!existsSync(ymlPath)) return out(json, 2, "CONFIG", `${pos[2]} has no provider.yaml`);
    const cfg = loadConfig(root);
    if (!cfg.ok) return out(json, 2, "CONFIG", cfg.error);
    let y;
    try { y = parseProviderYaml(readFileSync(ymlPath, "utf8"), `${pos[2]}/provider.yaml`); }
    catch (err) { return out(json, 2, "CONFIG", err.message); }
    if (typeof y.capability !== "string" || typeof y.id !== "string") {
      return out(json, 2, "CONFIG", "provider.yaml needs id + capability");
    }
    // VERIFY FIRST, against the source dir: hashes from the tree being added
    const trusted = parseTrustedKeys(cfg.config.trust.keys);
    const probe = { files: manifestOf(srcDir), capability: y.capability, id: y.id };
    const refusal = refusalOf(srcDir, probe, trusted);
    if (refusal) return out(json, 2, "REFUSED", `provider ${y.capability}/${y.id} REFUSED: ${refusal}`,
      { refusal }, ["keeldocs provider trust <name> <key>  (if the signer is legitimate)"]);
    const dstDir = join(root, ".keeldocs", "providers", y.capability, y.id);
    mkdirSync(dstDir, { recursive: true });
    cpSync(srcDir, dstDir, { recursive: true });
    const lock = loadLock(root);
    const sig = JSON.parse(readFileSync(join(srcDir, SIG_FILE), "utf8"));
    lock.set(`${y.capability}/${y.id}`, {
      v: 1, capability: y.capability, id: y.id, semver: y.semver ?? null,
      signer: sig.signer, files: manifestOf(dstDir),
    });
    writeLock(root, lock);
    return out(json, 0, "INSTALLED",
      `${y.capability}/${y.id} installed and pinned (commit .keeldocs/providers/ and ${LOCK_REL})`,
      { capability: y.capability, id: y.id, files: Object.keys(lock.get(`${y.capability}/${y.id}`).files).length },
      ["keeldocs check"]);
  }

  return out(json, 2, "USAGE", "usage: keeldocs provider <keygen|sign|trust|add> ...");
}
