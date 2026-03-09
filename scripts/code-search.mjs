#!/usr/bin/env node
/**
 * Semantic Code Search
 * 
 * Natural language query against the code index.
 * Requires: run code-index.mjs first.
 * 
 * Usage:
 *   node scripts/code-search.mjs "where is the router startup"
 *   node scripts/code-search.mjs "how are tools registered" --top 10
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'scaff-tools', 'code-index.sqlite');
const OLLAMA_URL = 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const topK = topIdx >= 0 ? parseInt(args[topIdx + 1]) : 5;
const query = args.filter((a, i) => a !== '--top' && (topIdx < 0 || i !== topIdx + 1)).join(' ');

if (!query) {
  console.error('Usage: node scripts/code-search.mjs "your query" [--top N]');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error('Index not found. Run: node scripts/code-index.mjs');
  process.exit(1);
}

async function embed(text) {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embed failed: ${resp.status}`);
  const data = await resp.json();
  return data.embedding;
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  const sqliteVec = await import('sqlite-vec');
  db.enableLoadExtension(true);
  sqliteVec.load(db);
  
  // Embed the query
  const queryVec = await embed(query);
  const vecBlob = Buffer.from(new Float32Array(queryVec).buffer);
  
  // Search
  const results = db.prepare(`
    SELECT
      v.rowid,
      v.distance,
      c.file_path,
      c.line_start,
      c.line_end,
      c.chunk_type,
      c.chunk_name,
      c.content
    FROM code_chunks_vec v
    JOIN code_chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `).all(vecBlob, topK);
  
  if (results.length === 0) {
    console.log('No results found.');
    db.close();
    return;
  }
  
  const output = {
    query,
    results: results.map(r => ({
      file: r.file_path,
      lines: `${r.line_start}-${r.line_end}`,
      type: r.chunk_type,
      name: r.chunk_name,
      similarity: parseFloat((1 - r.distance).toFixed(3)),
      snippet: r.content.substring(0, 300) + (r.content.length > 300 ? '...' : ''),
    })),
  };
  
  console.log(JSON.stringify(output, null, 2));
  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
