// Permission manifest (ADR-002: "installed only via explicit `provider trust`
// SHOWING the permission manifest"). The last line of that decision.
//
// The point of this file is that the manifest is TRUE, not decorative. Since
// the per-glob scoping slice, a provider's declared `inputs` is what it can
// actually read - so the display resolves those globs against THIS repository
// and reports real numbers: how many files it will receive, which directories
// it wants wholesale, and how many files it asked for that the security
// exclusion set will withhold regardless. A human can judge that.
//
// The honesty rule that governs the whole rendering: state the enforcement
// this host will actually apply. On a platform without user+mount namespaces
// the manifest is a STATEMENT OF INTENT, not a boundary, and saying so is the
// difference between a security control and security theatre.

import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseProviderYaml } from "./providers.js";
import { manifestOf, refusalOf, parseTrustedKeys, SIG_FILE } from "./trust.js";
import { repoFiles, resolveInputs, isExcluded, globToRegExp } from "./scope.js";
import { sandboxState } from "./facts.js";
import { toPosix } from "./paths.js";

const SAMPLE = 8;

// What the sandbox will really do to this provider on this host, in the words
// the ADR uses. `live` providers keep their declared network:db exception and
// are never scoped - they read a DSN, not the repository.
export function enforcementOf(live) {
  const { tier, root } = sandboxState();
  if (live) {
    return { level: "declared-exception", enforced: false,
      detail: "a `live` provider keeps its declared network:db socket and is not scoped - it reads a database, not the repository" };
  }
  if (tier === "rofs" && root === "minimal") {
    return { level: "minimal-root", enforced: true,
      detail: "network denied; the repository is read-only and shrunk to exactly the reads listed here; and the rest of the host - home directories, credential stores, other checkouts - is masked away, so this provider's whole filesystem is the runtime plus the list above" };
  }
  if (tier === "rofs") {
    return { level: "per-glob", enforced: true,
      detail: "network denied, repository read-only, and the readable set is exactly the reads listed here - an undeclared file does not exist inside this provider's namespace. The rest of the HOST filesystem is still visible: this machine could not stand up a minimal root" };
  }
  if (tier === "net") {
    return { level: "network-only", enforced: false,
      detail: "network denied, but no usable mount namespace on this host: the read scope listed here is DECLARED, not enforced" };
  }
  return { level: "none", enforced: false,
    detail: "this host (macOS/Windows/restricted) gets subprocess+timeout only: everything listed here is DECLARED, not enforced (ADR-013)" };
}

// Build the manifest. Pure with respect to the filesystem it reads; renders
// nothing, so the JSON envelope and the human text share one source of truth.
export function permissionManifest(repoRoot, providerDir, { trustKeys = [] } = {}) {
  const ymlPath = join(providerDir, "provider.yaml");
  if (!existsSync(ymlPath)) throw new Error(`${toPosix(relative(repoRoot, providerDir))} has no provider.yaml`);
  const rel = toPosix(relative(repoRoot, providerDir)) || ".";
  const y = parseProviderYaml(readFileSync(ymlPath, "utf8"), `${rel}/provider.yaml`);

  const inputs = Array.isArray(y.inputs) ? y.inputs.filter((i) => typeof i === "string") : [];
  const factReads = inputs.map((i) => i.match(/^\$\{facts:([a-z0-9-]+)\}$/)).filter(Boolean).map((m) => m[1]);
  const all = repoFiles(repoRoot);
  const { files, dirs } = resolveInputs(repoRoot, inputs, all);

  // The concrete, checkable claim: files this provider ASKED for that it will
  // not get. "Your .env matches its globs and it will not receive it" is the
  // sentence a human can act on - much more useful than naming the rule.
  const withheld = [];
  for (const raw of inputs) {
    if (raw.startsWith("${facts:")) continue;
    const re = globToRegExp(raw.replace(/^\.\//, ""));
    for (const f of all) if (re.test(f) && isExcluded(f) && !withheld.includes(f)) withheld.push(f);
  }
  withheld.sort();

  const signed = existsSync(join(providerDir, SIG_FILE));
  let signer = null, proof = "unsigned";
  if (signed) {
    try { signer = JSON.parse(readFileSync(join(providerDir, SIG_FILE), "utf8")).signer ?? null; }
    catch { signer = null; }
    const refusal = refusalOf(providerDir,
      { files: manifestOf(providerDir), capability: y.capability, id: y.id },
      parseTrustedKeys(trustKeys));
    proof = refusal ? `refused: ${refusal}` : "verified";
  }

  const network = y.live === true ? "database (declared `live`)"
    : (Array.isArray(y.requires) ? y.requires : []).some((r) => String(r).startsWith("network"))
    ? `declared: ${y.requires.join(", ")}` : "denied";

  return {
    id: y.id, capability: y.capability, semver: y.semver ?? null, tier: y.tier ?? null,
    dir: rel,
    runtime: y.runtime === "query" ? "tree-sitter query (no provider code runs)"
      : y.exec === "node" ? "node" : "python",
    entry: y.runtime === "query" ? y.query : y.entry,
    emits: Array.isArray(y.emits) ? y.emits : [],
    reads: { globs: inputs.filter((i) => !i.startsWith("${facts:")), matched: files.length,
             sample: files.slice(0, SAMPLE), dirs },
    factReads,
    withheld: { count: withheld.length, sample: withheld.slice(0, SAMPLE) },
    network,
    trust: { signed, signer, proof, files: signed ? Object.keys(manifestOf(providerDir)).length : null },
    enforcement: enforcementOf(y.live === true),
  };
}

// Human rendering. Deliberately unpretty and dense: this is a consent screen,
// and the numbers are the content.
export function renderManifest(m) {
  const L = [];
  L.push(`Provider ${m.capability}/${m.id}${m.semver ? `@${m.semver}` : ""}  (${m.tier ?? "?"} tier, ${m.dir})`);
  L.push("");
  L.push(`  RUNS      ${m.runtime}${m.entry ? ` - ${m.entry}` : ""}`);
  L.push(`  EMITS     ${m.emits.length ? m.emits.join(", ") : "(nothing declared)"}`);
  L.push(`  NETWORK   ${m.network}`);
  L.push("");
  L.push(`  READS     ${m.reads.matched} file(s) in this repository, matching:`);
  for (const g of m.reads.globs) L.push(`              ${g}`);
  if (!m.reads.globs.length) L.push("              (nothing - this provider declared no repository reads)");
  for (const f of m.reads.sample) L.push(`              -> ${f}`);
  if (m.reads.matched > m.reads.sample.length) {
    L.push(`              -> ... and ${m.reads.matched - m.reads.sample.length} more`);
  }
  if (m.reads.dirs.length) {
    L.push(`  WHOLE DIR ${m.reads.dirs.join(", ")}  <- an entire tree, not a file list`);
  }
  if (m.factReads.length) {
    L.push(`  ALSO GETS resolved facts from: ${m.factReads.join(", ")}`);
  }
  L.push("");
  if (m.withheld.count) {
    L.push(`  WITHHELD  ${m.withheld.count} matching file(s) are secrets and will NOT be handed over:`);
    for (const f of m.withheld.sample) L.push(`              -> ${f}`);
    if (m.withheld.count > m.withheld.sample.length) {
      L.push(`              -> ... and ${m.withheld.count - m.withheld.sample.length} more`);
    }
  } else {
    L.push("  WITHHELD  none of its globs match a secret in this repository");
  }
  L.push("");
  L.push(`  TRUST     ${m.trust.signed ? `signed by \`${m.trust.signer}\` - ${m.trust.proof}` : "UNSIGNED"}` +
    (m.trust.files ? ` (${m.trust.files} files pinned)` : ""));
  L.push(`  SANDBOX   ${m.enforcement.enforced ? "ENFORCED" : "NOT ENFORCED"} (${m.enforcement.level})`);
  L.push(`              ${m.enforcement.detail}`);
  return L.join("\n");
}
