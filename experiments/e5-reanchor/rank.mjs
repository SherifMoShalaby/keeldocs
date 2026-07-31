// E5 shim: feed real-corpus orphan cases through the SHIPPED ranking code.
import { readFileSync } from "node:fs";
import { rankSymbolCandidates, renameMapFromStatus } from "../../src/reanchor.js";

const { cases } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
for (const c of cases) {
  const factsNow = new Map(Object.entries(c.now).map(([id, nameless]) => [id, { provenance: { nameless } }]));
  const baseFacts = new Map(Object.entries(c.base).map(([id, nameless]) => [id, { provenance: { nameless } }]));
  const renames = renameMapFromStatus(c.nameStatus);
  for (const missing of c.orphans) {
    out.push({ pair: c.pair, missing,
      ranked: rankSymbolCandidates({ missingId: missing, factsNow, baseFacts, renames }) });
  }
}
process.stdout.write(JSON.stringify(out));
