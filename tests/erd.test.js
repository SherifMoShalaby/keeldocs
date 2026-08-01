import test from "node:test";
import assert from "node:assert/strict";
import { erdChunks, diagramBody, renderRegionBody } from "../src/render.js";

// Mermaid's SHIPPED defaults, not keeldocs' internal budget. The budget exists
// to stay under these; the tests assert against the real ceilings so a budget
// change can never quietly cross the line it was chosen to respect. (E11, R13)
const MERMAID_MAX_TEXT = 50_000;
const MERMAID_MAX_EDGES = 500;

function db({ tables, columns = 8, fks = 2, schemas = 1 }) {
  const names = [];
  for (let i = 0; i < tables; i++) {
    names.push(`${schemas > 1 ? `s${i % schemas}` : "public"}.t${String(i).padStart(4, "0")}`);
  }
  names.sort();
  const m = new Map();
  names.forEach((name, i) => {
    const cols = [{ name: "id", type: "uuid", optional: false }];
    for (let c = 1; c < columns; c++) {
      cols.push({ name: `col_${c}_value`, type: c % 3 ? "text" : "timestamptz", optional: c % 2 === 0 });
    }
    const relations = [];
    for (let f = 0; f < fks && tables > 1; f++) {
      relations.push({ target: names[(i + f + 1) % tables], field: `fk_${f}_id` });
    }
    m.set(`fact:db-schema/${name}`,
      { id: `fact:db-schema/${name}`, payload: { type: "table", attrs: { name, columns: cols, relations } } });
    m.set(`fact:db-schema/pk.${name}`,
      { id: `fact:db-schema/pk.${name}`, payload: { type: "pk", attrs: { table: name, columns: ["id"] } } });
  });
  return m;
}

const entitiesIn = (body) => (body.match(/^ {2}(\S+) \{$/gm) ?? []).map((l) => l.trim().slice(0, -2));
const edgesIn = (body) => (body.match(/\}o--\|\|/g) ?? []).length;
const fences = (body) => (body.match(/^```mermaid$/gm) ?? []).length;

test("a database under the ceiling stays ONE picture, with no headings bolted on", () => {
  const body = diagramBody(db({ tables: 40 }));
  assert.equal(fences(body), 1);
  assert.ok(body.startsWith("```mermaid\nerDiagram\n"), "byte-identical to the pre-chunking renderer");
  assert.ok(!body.includes("###"), "a repo that never needed splitting must not grow section headings");
  assert.equal(entitiesIn(body).length, 40);
});

test("a database over the ceiling splits, and EVERY table still reaches the reader", () => {
  const facts = db({ tables: 500, columns: 12, fks: 3 });
  const body = diagramBody(facts);
  const drawn = entitiesIn(body);
  assert.equal(drawn.length, 500, "silent truncation is the failure this whole mechanism exists to prevent");
  assert.equal(new Set(drawn).size, 500, "and no table is drawn twice");
  assert.ok(fences(body) > 1);
});

test("each chunk is a diagram Mermaid will actually render", () => {
  for (const shape of [{ tables: 250 }, { tables: 500, columns: 12, fks: 3 }, { tables: 800, schemas: 4 }]) {
    for (const c of erdChunks(db(shape))) {
      assert.ok(c.body.length <= MERMAID_MAX_TEXT,
        `${JSON.stringify(shape)} chunk ${c.id}: ${c.body.length} chars exceeds maxTextSize`);
      assert.ok(edgesIn(c.body) <= MERMAID_MAX_EDGES,
        `${JSON.stringify(shape)} chunk ${c.id}: ${edgesIn(c.body)} edges exceeds maxEdges`);
    }
  }
});

test("a chunk draws no edge to a table it does not contain, and says how many it dropped", () => {
  const chunks = erdChunks(db({ tables: 500, columns: 12, fks: 3 }));
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const present = new Set(entitiesIn(c.body));
    for (const [, from, to] of c.body.matchAll(/^ {2}(\S+) \}o--\|\| (\S+) : /gm)) {
      assert.ok(present.has(from) && present.has(to),
        `chunk ${c.id} draws ${from}->${to}, materialising a ghost entity Mermaid would count against maxEdges`);
    }
  }
  const dropped = chunks.filter((c) => /_\d+ relationship\(s\) to tables outside this view are not drawn\._/.test(c.body));
  assert.ok(dropped.length > 0, "cross-chunk relationships exist here; hiding that they were omitted is the lie");
});

test("splitting is by schema before it is by count", () => {
  const chunks = erdChunks(db({ tables: 500, schemas: 4 }));
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    const schemas = new Set(entitiesIn(c.body).map((n) => n.slice(0, n.indexOf("."))));
    assert.equal(schemas.size, 1, `chunk ${c.id} mixes schemas ${[...schemas]}`);
    assert.match(c.title, /^Schema `s\d`/);
  }
});

test("one table too wide to split says so rather than shipping a picture that will not render", () => {
  const m = new Map();
  for (const [name, n] of [["public.monster", 1500], ["public.small", 5]]) {
    const columns = [{ name: "id", type: "uuid", optional: false }];
    for (let c = 1; c < n; c++) columns.push({ name: `a_very_long_column_name_${c}`, type: "timestamptz", optional: true });
    m.set(`fact:db-schema/${name}`, { id: `fact:db-schema/${name}`, payload: { type: "table", attrs: { name, columns, relations: [] } } });
  }
  const chunks = erdChunks(m);
  const over = chunks.filter((c) => c.body.length > MERMAID_MAX_TEXT);
  assert.equal(over.length, 1);
  assert.match(over[0].body, /past Mermaid's ceiling; `public\.monster` is too wide to split further and may not render/);
  assert.equal(entitiesIn(diagramBody(m)).length, 2, "the unsplittable table does not cost the reader the other one");
});

test("sync can repair a chunked diagram - one region id, regenerated whole", () => {
  const facts = db({ tables: 500, columns: 12, fks: 3 });
  const repaired = renderRegionBody("db.root.diagram", [...facts.keys()], facts);
  assert.equal(repaired, diagramBody(facts),
    "init and sync must produce the same bytes, or a chunked diagram is reported stale forever");
  assert.equal(entitiesIn(repaired).length, 500);
});

test("the plan is deterministic - same facts, same chunks, whatever the map order", () => {
  const a = db({ tables: 300, columns: 12, fks: 3 });
  const shuffled = new Map([...a].reverse());
  assert.deepEqual(erdChunks(shuffled).map((c) => [c.id, c.body]), erdChunks(a).map((c) => [c.id, c.body]));
});
