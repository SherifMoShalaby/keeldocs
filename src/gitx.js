// Shared git helpers for self-caused scoping (check --since / sync --self).
// The change set is "what THIS line of work touched": merge-base(ref, HEAD)
// diffed against the WORKING TREE plus untracked files - the post-edit nudge
// fires on the edit you just made, which is usually not committed yet.
// Committed-trees-only diffing (ref...HEAD) missed exactly that case.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractAll } from "./facts.js";

export function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function changedFilesSince(root, ref) {
  const mb = git(root, ["merge-base", ref, "HEAD"]);
  if (mb === null) throw new Error(`cannot resolve merge-base of \`${ref}\` and HEAD (unknown ref?)`);
  const diff = git(root, ["diff", "--name-only", mb]);
  if (diff === null) throw new Error(`cannot diff working tree against \`${ref}\``);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "";
  const changed = new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean));
  return { changed, base: mb };
}

// Extract the fact universe AS OF a base commit, via a throwaway worktree.
// Shared by --since/--self classification and the re-anchoring pipeline
// (S2 compares against the dead fact's LAST KNOWN shape, which lives here).
export function extractAtBase(root, base, { disable = [], trustKeys = [] } = {}) {
  const wt = mkdtempSync(join(tmpdir(), "keeldocs-base-"));
  try {
    const r = spawnSync("git", ["worktree", "add", "--detach", "--force", wt, base],
      { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cannot materialize base \`${base}\`: ${(r.stderr || "").slice(-160)}`);
    const { factsById, toolError } = extractAll(wt, { disable, trustKeys });
    if (toolError) throw new Error(`base extraction failed: ${toolError}`);
    return factsById;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: root, encoding: "utf8" });
    rmSync(wt, { recursive: true, force: true });
  }
}

// FACT-level change set: base extraction diffed against the current one. File
// granularity was tried first and over-attributed - a fact merely LIVING in an
// edited file is not caused by the edit; a fact whose HASH moved (or that
// appeared/disappeared) is. Precise meaning of "drift caused by ref..HEAD".
export function changedFactsSince(root, base, factsNow, opts = {}, baseFactsIn = null) {
  const baseFacts = baseFactsIn ?? extractAtBase(root, base, opts);
  const changedFactIds = new Set();
  for (const [id, f] of factsNow) {
    if (baseFacts.get(id)?.hash !== f.hash) changedFactIds.add(id); // new or modified
  }
  for (const id of baseFacts.keys()) {
    if (!factsNow.has(id)) changedFactIds.add(id); // deleted since base
  }
  return changedFactIds;
}

// Rename map for S1: `git diff --name-status -M60 <base>` against the working
// tree - the same base the rest of the pipeline uses.
export function renamesSince(root, base) {
  const out = git(root, ["diff", "--name-status", "-M60", base]);
  return out ?? "";
}
