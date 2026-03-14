#!/usr/bin/env node
// One-time backfill: generate embeddings for Library items missing them.
// Idempotent — safe to run multiple times.
// Usage: node scripts/library-backfill-embeddings.mjs

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = process.env.OPENCLAW_LIBRARY_DB || join(homedir(), ".openclaw", "library", "library.sqlite");
const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const TIMEOUT_MS = 30_000;

async function embed(text) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

  // Find items with no embedding
  const todo = db.prepare(`
    SELECT id, title, summary, key_concepts
    FROM items
    WHERE id NOT IN (SELECT item_id FROM item_embeddings)
      AND status != 'failed'
  `).all();

  const totalItems = db.prepare("SELECT COUNT(*) AS cnt FROM items WHERE status != 'failed'").get();
  const existingCount = db.prepare("SELECT COUNT(*) AS cnt FROM item_embeddings").get();

  console.log(`Total active items: ${totalItems.cnt}`);
  console.log(`Already embedded: ${existingCount.cnt}`);
  console.log(`To embed: ${todo.length}`);

  if (todo.length === 0) {
    console.log("Nothing to do — all items already have embeddings.");
    db.close();
    return;
  }

  let embedded = 0;
  let errors = 0;

  for (const item of todo) {
    const keyConcepts = item.key_concepts ? JSON.parse(item.key_concepts).join(". ") : "";
    const text = `${item.title}. ${item.summary} ${keyConcepts}`;

    try {
      const vec = await embed(text);
      db.prepare("DELETE FROM item_embeddings WHERE item_id = ?").run(item.id);
      db.prepare("INSERT INTO item_embeddings (item_id, embedding) VALUES (CAST(? AS INTEGER), ?)").run(
        item.id,
        new Uint8Array(vec.buffer),
      );
      embedded++;
      console.log(`  ✓ [${embedded}/${todo.length}] ${item.title}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ [${item.id}] ${item.title}: ${err.message}`);
    }
  }

  const finalCount = db.prepare("SELECT COUNT(*) AS cnt FROM item_embeddings").get();
  db.close();

  console.log("\n--- Summary ---");
  console.log(`Backfilled: ${embedded}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total embeddings now: ${finalCount.cnt}`);
}

main().catch(console.error);
