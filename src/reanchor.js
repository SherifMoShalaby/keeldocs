// Re-anchoring pipeline S1/S2 (ADR-007 + amendments; audit item 4).
// Signals per dead `ds` binding, each independent and named in evidence:
//   S1  - git rename map (-M60): the symbol's MODULE file was renamed and the
//         same descriptor tail exists at the new path
//   S2  - signature match against the BASE extraction (the dead fact's last
//         known shape): "exact" = identical nameless sig set (rename-tolerant
//         by construction), "near" = same arity + token overlap >= 0.6
//   S1b - unique same-descriptor candidate repo-wide (the E3 consolidation case)
//
// AUTO-REBIND GATE (<0.5% false-rebind go/no-go, ADR-007): metadata-only,
// journaled, reversible, EXACTLY ONE candidate, and two independent agreeing
// signals - instantiated as S1 + S2-exact (the file-move case, accuracy gate
// >=99%). Body-shingle similarity (S3) is deferred; per the E3 amendment,
// signature corroboration stands in for body corroboration. Everything else
// - S2-exact alone (in-place rename), S1 + S2-near, S1b + S2 - is a RANKED
// PROPOSAL with the signals named. S1b alone stays proposal-grade, as amended.

export function renameMapFromStatus(nameStatus) {
  // parse `git diff --name-status -M60 <base>` output: R<score>\told\tnew
  const renames = new Map();
  for (const line of (nameStatus ?? "").split("\n")) {
    const m = line.match(/^R\d*\t([^\t]+)\t([^\t]+)$/);
    if (m) renames.set(m[1], m[2]);
  }
  return renames;
}

const tailOf = (dsId) => dsId.slice(dsId.lastIndexOf("/") + 1); // name+suffix
const moduleOf = (dsId) => {
  // `ds <pkg> <ver> <path>/<descriptor>` -> path
  const parts = dsId.split(" ");
  const desc = parts.slice(3).join(" ");
  return desc.slice(0, desc.lastIndexOf("/"));
};

function tokens(s) {
  return (s ?? "").split(/[^A-Za-z0-9_§]+/).filter(Boolean);
}

function arity(sig) {
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return 0;
  const inner = m[1].trim();
  return inner === "" ? 0 : inner.split(",").length;
}

// Compare nameless signature SETS (overloads included). Exact = identical
// sorted sets. Near = every base sig has some candidate sig with equal arity
// and token-Jaccard >= 0.6.
export function sigMatch(baseNameless, candNameless) {
  const a = [...(baseNameless ?? [])].sort();
  const b = [...(candNameless ?? [])].sort();
  if (a.length && a.length === b.length && a.every((s, i) => s === b[i])) return "exact";
  if (!a.length || !b.length) return null;
  const near = a.every((sa) => b.some((sb) => {
    if (arity(sa) !== arity(sb)) return false;
    const ta = new Set(tokens(sa)), tb = new Set(tokens(sb));
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (new Set([...ta, ...tb]).size || 1) >= 0.6;
  }));
  return near ? "near" : null;
}

// Rank candidates for one missing `ds` id. Returns sorted candidates with
// named signals and the auto flag; empty array when nothing plausible.
export function rankSymbolCandidates({ missingId, factsNow, baseFacts, renames }) {
  if (!missingId.startsWith("ds ")) return [];
  const tail = tailOf(missingId);
  const oldModule = moduleOf(missingId);
  const renamedTo = renames?.get(oldModule) ?? null;
  const baseNameless = baseFacts?.get(missingId)?.provenance?.nameless ?? null;

  const out = [];
  for (const [id, f] of factsNow) {
    if (!id.startsWith("ds ") || id === missingId) continue;
    const signals = {};
    const sameTail = tailOf(id) === tail;
    if (sameTail && renamedTo !== null && moduleOf(id) === renamedTo) signals.s1 = true;
    const sm = baseNameless ? sigMatch(baseNameless, f.provenance?.nameless) : null;
    if (sm) signals.s2 = sm;
    // admission: same descriptor tail (rename/move of the file or consolidation),
    // or a DIFFERENT name whose shape is exactly the dead symbol's (in-place rename)
    if (!sameTail && sm !== "exact") continue;
    out.push({ id, signals, sameTail });
  }
  // S1b: unique same-tail candidate repo-wide
  const sameTailCands = out.filter((c) => c.sameTail);
  if (sameTailCands.length === 1) sameTailCands[0].signals.s1b = true;

  for (const c of out) {
    c.score = (c.signals.s1 ? 4 : 0) + (c.signals.s2 === "exact" ? 3 : c.signals.s2 === "near" ? 1 : 0)
            + (c.signals.s1b ? 2 : 0);
  }
  const ranked = out.filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // the gate: exactly one candidate overall, carrying S1 AND S2-exact
  if (ranked.length === 1 && ranked[0].signals.s1 && ranked[0].signals.s2 === "exact") {
    ranked[0].auto = true;
  }
  return ranked.slice(0, 3).map(({ sameTail, ...c }) => c);
}

export function evidenceText(missingId, cands) {
  const parts = cands.slice(0, 3).map((c) => {
    const sig = [
      c.signals.s1 ? "S1 file-rename (git -M60)" : null,
      c.signals.s2 ? `S2 signature ${c.signals.s2}` : null,
      c.signals.s1b ? "S1b unique same-name" : null,
    ].filter(Boolean).join(" + ");
    return `${c.id} [${sig}${c.auto ? " -> auto-rebind qualified" : ""}]`;
  });
  return `\`${missingId}\` no longer resolves; ${parts.join("; ")}`;
}
