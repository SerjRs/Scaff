import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/scaff-tools/code-index.sqlite';
const OLLAMA = 'http://127.0.0.1:11434';
const BATCH = 500;

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return (await r.json()).embedding;
}

async function run() {
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  const sv = await import('sqlite-vec');
  db.enableLoadExtension(true);
  sv.load(db);

  // Get todo list
  const allIds = new Set(db.prepare('SELECT id FROM code_chunks').all().map(r => Number(r.id)));
  const doneIds = new Set(db.prepare('SELECT rowid FROM code_chunks_vec').all().map(r => Number(r.rowid)));
  const todoIds = [...allIds].filter(id => !doneIds.has(id));
  
  console.log(`Total: ${allIds.size}, Done: ${doneIds.size}, Todo: ${todoIds.length}`);
  if (todoIds.length === 0) { db.close(); return; }

  // Get chunk data for this batch
  const batch = todoIds.slice(0, BATCH);
  const placeholders = batch.map(() => '?').join(',');
  const chunks = db.prepare(`SELECT id, file_path, chunk_name, content FROM code_chunks WHERE id IN (${placeholders})`).all(...batch);

  const insert = db.prepare('INSERT OR IGNORE INTO code_chunks_vec (rowid, embedding) VALUES (?, ?)');
  let ok = 0;
  
  for (const c of chunks) {
    try {
      const text = `File: ${c.file_path}${c.chunk_name ? ` | ${c.chunk_name}` : ''}\n\n${c.content.substring(0, 2000)}`;
      const vec = await embed(text);
      insert.run(BigInt(c.id), Buffer.from(new Float32Array(vec).buffer));
      ok++;
    } catch (e) {
      // skip
    }
  }
  
  const newTotal = doneIds.size + ok;
  console.log(`Batch done: +${ok}. Total: ${newTotal}/${allIds.size}. Remaining: ${allIds.size - newTotal}`);
  db.close();
}

await run();
