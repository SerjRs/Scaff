import { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";

const db = new DatabaseSync("cortex/bus.sqlite", { allowExtension: true });
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

const queries = [
  "Scaff birthday creation date February",
  "DNA contract alignment agreement two entities",
  "why is Scaff called Scaff name origin scaffolds",
];

for (const q of queries) {
  console.log(`\n=== "${q}" ===`);
  const vec = await embed(q);
  const results = db.prepare(`
    SELECT v.distance, f.fact_text, f.source_type
    FROM hippocampus_facts_vec v
    JOIN hippocampus_facts f ON f.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = 5
    ORDER BY v.distance
  `).all(new Uint8Array(vec.buffer));
  for (const r of results) {
    console.log(`  [${r.distance.toFixed(3)}] [${r.source_type}] ${r.fact_text.slice(0, 120)}`);
  }
}

db.close();
