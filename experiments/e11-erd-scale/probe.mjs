import { erdChunks, diagramBody } from "../../src/render.js";

function synth(n, cols, fks, schemas = 1) {
  const m = new Map();
  const names = [];
  for (let i = 0; i < n; i++) names.push(`${schemas > 1 ? `s${i % schemas}.` : "public."}t${String(i).padStart(4, "0")}`);
  names.sort();
  names.forEach((name, i) => {
    const columns = [{ name: "id", type: "uuid", optional: false }];
    for (let c = 1; c < cols; c++) columns.push({ name: `col_${c}_value`, type: c % 3 ? "text" : "timestamptz", optional: c % 2 === 0 });
    const relations = [];
    for (let f = 0; f < fks; f++) relations.push({ target: names[(i + f + 1) % n], field: `fk_${f}_id` });
    m.set(`fact:db-schema/${name}`, { id: `fact:db-schema/${name}`, payload: { type: "table", attrs: { name, columns, relations } } });
    m.set(`fact:db-schema/pk.${name}`, { id: `fact:db-schema/pk.${name}`, payload: { type: "pk", attrs: { table: name, columns: ["id"] } } });
  });
  return m;
}

const MAXC = 50_000, MAXE = 500;
const rows = [];
for (const [n, cols, fks, sch] of [[25,8,2,1],[50,8,2,1],[100,8,2,1],[250,8,2,1],[500,8,2,1],[500,12,3,1],[500,8,2,4],[1000,12,3,4],[3,400,1,1]]) {
  const facts = synth(n, cols, fks, sch);
  const t0 = process.hrtime.bigint();
  const chunks = erdChunks(facts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const full = diagramBody(facts);
  const bodies = chunks.map(c => c.body);
  const worstC = Math.max(...bodies.map(b => b.length));
  const worstE = Math.max(...bodies.map(b => (b.match(/\}o--\|\|/g) || []).length));
  const drawnTables = bodies.reduce((s,b) => s + (b.match(/^  \S+ \{$/gm)||[]).length, 0);
  rows.push(`| ${n} | ${cols} | ${fks} | ${sch} | ${chunks.length} | ${worstC} | ${worstE} | ${worstC<=MAXC?"ok":"OVER"} | ${worstE<=MAXE?"ok":"OVER"} | ${drawnTables===n?"all":`${drawnTables}/${n} LOST`} | ${ms.toFixed(0)}ms |`);
}
console.log("| tables | cols | fk | schemas | chunks | worst chars | worst edges | maxTextSize | maxEdges | tables drawn | plan time |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
