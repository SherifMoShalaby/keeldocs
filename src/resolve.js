// ADR-003 deterministic resolution (audit item 11): when more than one
// provider claims the SAME fact id, the winner is picked by a pure total
// order - never by provider run order, wall clock, or iteration accident.
//
//   1. enumerated confidence lattice (no floats, total order)
//   2. static per-capability provider precedence (versioned with the engine)
//   3. lexicographic provider id - the backstop that makes the order TOTAL
//
// Merge semantics per the ADR: union across distinct ids; identical id ->
// pick-one WHOLE fact (attribute-level merging multiplies conflict surface
// for marginal gain). Claims that agree byte-wise (same payload hash) are
// CORROBORATION, not conflict - the winner's provenance stands and nothing
// is reported. Claims that disagree emit a conflict record: every claim,
// the winner, and the rule that decided - rendered in reports, so silent
// averaging (the dishonest failure mode) is structurally impossible.

export const LATTICE = ["INTROSPECTED", "PARSED", "PATTERN", "GENERIC", "OBSERVED", "INFERRED"];

// Static per-capability provider precedence (tiebreak stage 2), versioned so
// a changed table is a visible engine change. v1 is empty ON PURPOSE: no
// capability has evidence for a principled provider order yet, so same-tier
// ties fall to the lexicographic backstop. Populate per capability (winner
// first) as real pairs land - drizzle-vs-prisma is the expected first entry.
export const PRECEDENCE_VERSION = 1;
export const PRECEDENCE = {};

const latticeRank = (c) => {
  const i = LATTICE.indexOf(c);
  return i === -1 ? LATTICE.length : i; // unknown tier sorts below every known one
};

export const providerIdOf = (f) => String(f.provenance?.provider ?? "").split("@")[0];

// Total order over claims on ONE id. Winner = minimum under this comparator,
// i.e. a max over a total order - independent of the order claims arrived.
export function claimCmp(a, b, capability, precedence = PRECEDENCE) {
  const la = latticeRank(a.provenance?.confidence), lb = latticeRank(b.provenance?.confidence);
  if (la !== lb) return la - lb;
  const table = precedence[capability] ?? [];
  const pa = providerIdOf(a), pb = providerIdOf(b);
  const ia = table.indexOf(pa), ib = table.indexOf(pb);
  const ra = ia === -1 ? table.length : ia, rb = ib === -1 ? table.length : ib;
  if (ra !== rb) return ra - rb;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

function decidingRule(a, b, capability, precedence) {
  if (latticeRank(a.provenance?.confidence) !== latticeRank(b.provenance?.confidence)) return "lattice";
  const table = precedence[capability] ?? [];
  const ia = table.indexOf(providerIdOf(a)), ib = table.indexOf(providerIdOf(b));
  if ((ia === -1 ? table.length : ia) !== (ib === -1 ? table.length : ib)) return "precedence";
  return "provider-id";
}

// Resolve every claim on one fact id. Returns { winner, conflict } where
// conflict is null for single claims and for corroboration (all hashes equal).
export function resolveClaims(id, claims, capability, precedence = PRECEDENCE) {
  const sorted = [...claims].sort((a, b) => claimCmp(a, b, capability, precedence));
  const winner = sorted[0];
  if (claims.length < 2 || new Set(claims.map((c) => c.hash)).size <= 1) {
    return { winner, conflict: null };
  }
  return {
    winner,
    conflict: {
      id,
      winner: winner.provenance.provider,
      rule: decidingRule(sorted[0], sorted[1], capability, precedence),
      precedenceVersion: PRECEDENCE_VERSION,
      claims: sorted.map((c) => ({
        provider: c.provenance.provider,
        confidence: c.provenance.confidence ?? null,
        hash: c.hash,
      })),
    },
  };
}
