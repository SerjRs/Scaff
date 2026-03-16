/**
 * 025a — Backfill embeddings for hippocampus facts missing vec entries.
 * Uses Ollama nomic-embed-text (768 dims) and sqlite-vec.
 *
 * Usage: npx tsx scripts/backfill-embeddings.ts
 */
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "cortex/bus.sqlite";
const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const MODEL = "nomic-embed-text";

async function embed(text: string): Promise<Float32Array | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { embedding: number[] };
      return new Float32Array(json.embedding);
    } catch (err) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  Retry ${attempt + 1}/3: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });

  // Load sqlite-vec
  const sqliteVec = await import("sqlite-vec");
  sqliteVec.load(db);
  console.log("sqlite-vec loaded");

  // Find facts missing vec entries
  const missing = db.prepare(`
    SELECT f.rowid as rid, f.id, f.fact_text
    FROM hippocampus_facts f
    LEFT JOIN hippocampus_facts_vec_rowids v ON v.rowid = f.rowid
    WHERE v.rowid IS NULL AND f.status = 'active'
    ORDER BY f.rowid ASC
  `).all() as { rid: number | bigint; id: string; fact_text: string }[];

  console.log(`Found ${missing.length} facts without embeddings`);

  const vecBefore = (db.prepare("SELECT count(*) as n FROM hippocampus_facts_vec_rowids").get() as { n: number }).n;
  console.log(`Vec entries before: ${vecBefore}`);

  let success = 0;
  let failed = 0;
  const start = Date.now();

  const insertStmt = db.prepare(`
    INSERT INTO hippocampus_facts_vec (rowid, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `);

  for (let i = 0; i < missing.length; i++) {
    const fact = missing[i];
    const embedding = await embed(fact.fact_text);

    if (embedding && embedding.length === 768) {
      insertStmt.run(Number(fact.rid), new Uint8Array(embedding.buffer));
      success++;
    } else {
      console.log(`  FAILED rowid ${fact.rid}: ${fact.fact_text.slice(0, 60)}`);
      failed++;
    }

    if ((i + 1) % 100 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Progress: ${i + 1}/${missing.length} (${success} ok, ${failed} failed) [${elapsed}s]`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. Success: ${success}, Failed: ${failed}`);

  const vecAfter = (db.prepare("SELECT count(*) as n FROM hippocampus_facts_vec_rowids").get() as { n: number }).n;
  const activeCount = (db.prepare("SELECT count(*) as n FROM hippocampus_facts WHERE status = 'active'").get() as { n: number }).n;
  console.log(`Vec entries: ${vecAfter} / Active facts: ${activeCount}`);

  // Test query
  console.log("\n--- Test: 'Scaff birthday creation date' ---");
  const testEmbedding = await embed("Scaff birthday creation date");
  if (testEmbedding) {
    const results = db.prepare(`
      SELECT v.distance, f.fact_text, f.source_type
      FROM hippocampus_facts_vec v
      JOIN hippocampus_facts f ON f.rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = 5
      ORDER BY v.distance
    `).all(new Uint8Array(testEmbedding.buffer)) as { distance: number; fact_text: string; source_type: string }[];

    for (const r of results) {
      console.log(`  [${r.distance.toFixed(3)}] [${r.source_type}] ${r.fact_text.slice(0, 100)}`);
    }
  }

  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
