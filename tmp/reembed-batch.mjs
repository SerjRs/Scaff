import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/scaff-tools/code-index.sqlite';
const OLLAMA = 'http://127.0.0.1:11434';
const BATCH = 50;

async function embedBatch(texts) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  return (await r.json()).embeddings;
}

const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sv = await import('sqlite-vec');
db.enableLoadExtension(true);
sv.load(db);

const allIds = new Set(db.prepare('SELECT id FROM code_chunks').all().map(r => Number(r.id)));
const doneIds = new Set(db.prepare('SELECT rowid FROM code_chunks_vec').all().map(r => Number(r.rowid)));
const todoIds = [...allIds].filter(id => !doneIds.has(id));

console.log(`Total: ${allIds.size}, Done: ${doneIds.size}, Todo: ${todoIds.length}`);
if (todoIds.length === 0) { console.log('All done!'); db.close(); process.exit(0); }

// Load all todo chunks
const chunks = [];
for (let i = 0; i < todoIds.length; i += 1000) {
  const slice = todoIds.slice(i, i + 1000);
  const ph = slice.map(() => '?').join(',');
  chunks.push(...db.prepare(`SELECT id, file_path, chunk_name, content FROM code_chunks WHERE id IN (${ph})`).all(...slice));
}

const insert = db.prepare('INSERT OR IGNORE INTO code_chunks_vec (rowid, embedding) VALUES (?, ?)');
let done = 0;
let errors = 0;

for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const texts = batch.map(c =>
    `File: ${c.file_path}${c.chunk_name ? ` | ${c.chunk_name}` : ''}\n\n${c.content.substring(0, 2000)}`
  );

  try {
    const vecs = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      insert.run(BigInt(batch[j].id), Buffer.from(new Float32Array(vecs[j]).buffer));
    }
    done += batch.length;
  } catch (e) {
    errors++;
    console.error(`  Batch error at ${i}: ${e.message}`);
    if (errors > 5) { console.error('Too many errors, stopping.'); break; }
  }

  if ((i + BATCH) % 500 === 0 || i + BATCH >= chunks.length) {
    console.log(`  ${doneIds.size + done}/${allIds.size}`);
  }
}

console.log(`Done. +${done} embeddings (${errors} batch errors). Total: ${doneIds.size + done}/${allIds.size}`);
db.close();
