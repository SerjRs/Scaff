import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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

async function main() {
  const factId = randomUUID();
  const now = new Date().toISOString();
  const factText = "Scaff was created on February 3, 2026 — first day alive, first daily log, first conversation with Serj";

  // 1. Insert fact
  db.prepare(`
    INSERT INTO hippocampus_facts (id, fact_text, fact_type, confidence, status, source_type, source_ref, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, 'fact', 'high', 'active', 'curated_memory', 'workspace/memory/2026-02-03.md', ?, ?, 10)
  `).run(factId, factText, now, now);

  // 2. Generate and insert embedding
  const embedding = await embed(factText);
  const row = db.prepare("SELECT rowid FROM hippocampus_facts WHERE id = ?").get(factId);
  db.prepare("INSERT INTO hippocampus_facts_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)").run(Number(row.rowid), new Uint8Array(embedding.buffer));

  console.log(`Inserted fact: ${factId}`);

  // 3. Add edge to "Scaf's name derives from scaffolds"
  const nameFactRow = db.prepare("SELECT id FROM hippocampus_facts WHERE fact_text LIKE '%scaffolds metaphor%'").get();
  if (nameFactRow) {
    const edgeId = randomUUID();
    db.prepare("INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, confidence, created_at) VALUES (?, ?, ?, 'related_to', 'high', ?)").run(edgeId, factId, nameFactRow.id, now);
    console.log(`Edge to name fact: ${edgeId}`);
  }

  // 4. Add edge to "User's name is Serj" 
  const serjFactRow = db.prepare("SELECT id FROM hippocampus_facts WHERE fact_text = ? AND source_ref LIKE '%2026-02-03%'").get("User's name is Serj");
  if (serjFactRow) {
    const edgeId = randomUUID();
    db.prepare("INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, confidence, created_at) VALUES (?, ?, ?, 'related_to', 'high', ?)").run(edgeId, factId, serjFactRow.id, now);
    console.log(`Edge to Serj fact: ${edgeId}`);
  }

  // 5. Verify — search for it
  const queryVec = await embed("Scaff birthday creation date");
  const results = db.prepare(`
    SELECT v.distance, f.fact_text, f.source_ref
    FROM hippocampus_facts_vec v
    JOIN hippocampus_facts f ON f.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = 3
    ORDER BY v.distance
  `).all(new Uint8Array(queryVec.buffer));

  console.log("\nVerification — query: 'Scaff birthday creation date'");
  for (const r of results) {
    console.log(`  [${r.distance.toFixed(3)}] ${r.fact_text.slice(0, 100)}`);
    console.log(`    ref: ${r.source_ref}`);
  }

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
