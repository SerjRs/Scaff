#!/usr/bin/env node
// Backfill hot memory embeddings for dedup support
// One-time migration: embeds all cortex_hot_memory facts missing from cortex_hot_memory_vec
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = process.env.OPENCLAW_BUS_DB || join(homedir(), ".openclaw", "cortex", "bus.sqlite");
const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 100;

async function embed(text) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return new Float32Array(data.embedding);
}

async function main() {
  console.log(`Opening database: ${DB_PATH}`);

  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.enableLoadExtension(true);
  const sqliteVec = await import("sqlite-vec");
  sqliteVec.load(db);
  db.enableLoadExtension(false);

  // Ensure the vec table exists
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cortex_hot_memory_vec
    USING vec0(embedding float[768])
  `);

  // Get all hot memory rowids
  const allFacts = db.prepare(`
    SELECT rowid, id, fact_text FROM cortex_hot_memory
  `).all();

  // Get rowids already in the vec table
  const existingRowids = new Set(
    db.prepare(`SELECT rowid FROM cortex_hot_memory_vec`).all().map(r => Number(r.rowid))
  );

  // Filter to only facts needing embeddings
  const todo = allFacts.filter(f => !existingRowids.has(Number(f.rowid)));

  console.log(`Total hot facts: ${allFacts.length}`);
  console.log(`Already embedded: ${existingRowids.size}`);
  console.log(`To embed: ${todo.length}`);

  if (todo.length === 0) {
    console.log("Nothing to do — all facts already have embeddings.");
    db.close();
    return;
  }

  const insertStmt = db.prepare(`
    INSERT INTO cortex_hot_memory_vec (rowid, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `);

  let embedded = 0;
  let skipped = existingRowids.size;
  let errors = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);

    for (const fact of batch) {
      try {
        const vec = await embed(fact.fact_text);
        const rowidNum = Number(fact.rowid);
        insertStmt.run(rowidNum, new Uint8Array(vec.buffer));
        embedded++;
      } catch (err) {
        errors++;
        console.error(`  Error embedding fact ${fact.id}: ${err.message}`);
      }
    }

    console.log(`Embedded ${embedded}/${todo.length} facts`);

    // Delay between batches to avoid hammering Ollama
    if (i + BATCH_SIZE < todo.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  db.close();

  console.log("\n--- Summary ---");
  console.log(`Total embedded: ${embedded}`);
  console.log(`Total skipped (already had embeddings): ${skipped}`);
  console.log(`Total errors: ${errors}`);
}

main().catch(console.error);
