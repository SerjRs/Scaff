import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/scaff-tools/code-index.sqlite';

const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sqliteVec = await import('sqlite-vec');
db.enableLoadExtension(true);
sqliteVec.load(db);

// Get chunks that DON'T have vectors yet
const existing = new Set(
  db.prepare('SELECT rowid FROM code_chunks_vec').all().map(r => Number(r.rowid))
);
const allChunks = db.prepare('SELECT id, file_path, chunk_name, content FROM code_chunks').all();
const todo = allChunks.filter(c => !existing.has(Number(c.id)));

console.log(`Total: ${allChunks.length}, Done: ${existing.size}, Remaining: ${todo.length}`);

if (todo.length === 0) { console.log('All done!'); db.close(); process.exit(0); }

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

for (const c of todo) {
  try {
    const text = `File: ${c.file_path}${c.chunk_name ? ` | ${c.chunk_name}` : ''}\n\n${c.content.substring(0, 2000)}`;
    const vec = await embed(text);
    insert.run(BigInt(c.id), Buffer.from(new Float32Array(vec).buffer));
    done++;
    if (done % 500 === 0) {
      const total = existing.size + done;
      console.log(`  ${total}/${allChunks.length} (${done} this run)`);
    }
  } catch (e) {
    console.error(`  Error ${c.id}: ${e.message}`);
    // If Ollama is down, wait and retry
    if (e.message.includes('fetch failed') || e.message.includes('ECONNREFUSED')) {
      console.log('  Waiting 5s for Ollama...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

console.log(`Done. ${done} new embeddings. Total: ${existing.size + done}/${allChunks.length}`);
db.close();
