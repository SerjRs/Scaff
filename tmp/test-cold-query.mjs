import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/cortex/bus.sqlite';
const OLLAMA = 'http://127.0.0.1:11434';

const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sv = await import('sqlite-vec');
db.enableLoadExtension(true);
sv.load(db);

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: [text] }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return (await r.json()).embeddings[0];
}

// Test queries
const queries = [
  "What is Serj's phone number?",
  "Router scoring and weight tiers",
  "DNA verification and security",
  "Ollama configuration and models",
  "WhatsApp gateway issues",
];

for (const q of queries) {
  console.log(`\nQuery: "${q}"`);
  const vec = await embed(q);
  const vecBlob = Buffer.from(new Float32Array(vec).buffer);
  
  const results = db.prepare(`
    SELECT v.rowid, v.distance, c.fact_text
    FROM cortex_cold_memory_vec v
    JOIN cortex_cold_memory c ON c.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = 3
    ORDER BY v.distance ASC
  `).all(vecBlob);
  
  for (const r of results) {
    console.log(`  [${r.distance.toFixed(3)}] ${r.fact_text.substring(0, 120)}`);
  }
}

db.close();
