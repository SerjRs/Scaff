import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'scaff-tools', 'code-index.sqlite');

const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sqliteVec = await import('sqlite-vec');
db.enableLoadExtension(true);
sqliteVec.load(db);

// Check current state
const total = db.prepare('SELECT COUNT(*) as c FROM code_chunks').get();
const vecs = db.prepare('SELECT COUNT(*) as c FROM code_chunks_vec').get();
console.log(`Chunks: ${total.c}, Vectors: ${vecs.c}`);

if (vecs.c > 0) {
  console.log('Vectors already exist. Use --force to re-embed.');
  if (!process.argv.includes('--force')) { db.close(); process.exit(0); }
  db.prepare('DELETE FROM code_chunks_vec').run();
}

// Get all chunks that need embedding
const chunks = db.prepare('SELECT id, file_path, chunk_name, content FROM code_chunks').all();
console.log(`Embedding ${chunks.length} chunks...`);

const OLLAMA = 'http://127.0.0.1:11434';
async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return (await r.json()).embedding;
}

const insert = db.prepare('INSERT INTO code_chunks_vec (rowid, embedding) VALUES (?, ?)');
let done = 0;
let errors = 0;

for (const c of chunks) {
  try {
    const text = `File: ${c.file_path}${c.chunk_name ? ` | ${c.chunk_name}` : ''}\n\n${c.content.substring(0, 2000)}`;
    const vec = await embed(text);
    insert.run(BigInt(c.id), Buffer.from(new Float32Array(vec).buffer));
    done++;
    if (done % 200 === 0) console.log(`  ${done}/${chunks.length}`);
  } catch (e) {
    errors++;
    if (errors <= 3) console.error(`  Error chunk ${c.id}: ${e.message}`);
  }
}

console.log(`Done. ${done} embedded, ${errors} errors.`);
db.close();

