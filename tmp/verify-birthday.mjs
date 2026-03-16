import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite', { allowExtension: true });
load(db);

async function embed(text) {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json();
  return new Float32Array(json.embedding);
}

// Verify the fact exists
const fact = db.prepare("SELECT rowid, * FROM hippocampus_facts WHERE fact_text LIKE '%February 3, 2026%'").all();
console.log("=== Fact in DB ===");
for (const f of fact) {
  console.log(`  rowid: ${f.rowid}, id: ${f.id}`);
  console.log(`  text: ${f.fact_text}`);
  console.log(`  source_ref: ${f.source_ref}`);
  console.log(`  hit_count: ${f.hit_count}`);
}

// Check vec entry exists
if (fact.length > 0) {
  const vecCheck = db.prepare("SELECT rowid FROM hippocampus_facts_vec_rowids WHERE rowid = ?").get(fact[0].rowid);
  console.log(`  vec entry: ${vecCheck ? 'YES' : 'NO'}`);
}

// Try different queries
const queries = [
  "when was Scaff created born first day alive",
  "Scaff February 2026 birthday",
  "first day alive first conversation",
];

for (const q of queries) {
  const vec = await embed(q);
  const results = db.prepare(`
    SELECT v.distance, f.fact_text, f.source_ref
    FROM hippocampus_facts_vec v
    JOIN hippocampus_facts f ON f.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = 10
    ORDER BY v.distance
  `).all(new Uint8Array(vec.buffer));

  console.log(`\n=== "${q}" ===`);
  for (const r of results) {
    const match = r.fact_text.includes("February 3") ? " <<<" : "";
    console.log(`  [${r.distance.toFixed(3)}] ${r.fact_text.slice(0, 100)}${match}`);
  }
}

db.close();
