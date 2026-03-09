import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/cortex/bus.sqlite';
const OLLAMA = 'http://127.0.0.1:11434';

const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sv = await import('sqlite-vec');
db.enableLoadExtension(true);
sv.load(db);

// Check stale facts (>14 days old, hit_count <= 3)
const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const stale = db.prepare(
  "SELECT id, fact_text, created_at, hit_count FROM cortex_hot_memory WHERE created_at < ? AND hit_count <= 3"
).all(cutoff);

console.log(`Stale facts (>14d, hits<=3): ${stale.length}`);
console.log(`Cutoff: ${cutoff}`);

if (stale.length === 0) {
  console.log('Nothing to evict.');
  db.close();
  process.exit(0);
}

// Embed and move to cold storage
async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: [text] }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return (await r.json()).embeddings[0];
}

// Check cold storage table structure
const coldCols = db.prepare("PRAGMA table_info(cortex_cold_memory)").all();
console.log('Cold storage columns:', coldCols.map(c => c.name).join(', '));

const insertCold = db.prepare(
  "INSERT INTO cortex_cold_memory (fact_text, created_at, archived_at) VALUES (?, ?, ?)"
);
const insertColdVec = db.prepare(
  "INSERT INTO cortex_cold_memory_vec (rowid, embedding) VALUES (?, ?)"
);
const deleteHot = db.prepare("DELETE FROM cortex_hot_memory WHERE id = ?");

let evicted = 0;
let errors = 0;

for (const fact of stale) {
  try {
    const vec = await embed(fact.fact_text);
    const now = new Date().toISOString();
    
    insertCold.run(fact.fact_text, fact.created_at, now);
    
    // Get the rowid of the last inserted cold fact
    const coldRow = db.prepare("SELECT last_insert_rowid() as rowid").get();
    if (coldRow) {
      insertColdVec.run(BigInt(coldRow.rowid), Buffer.from(new Float32Array(vec).buffer));
    }
    
    deleteHot.run(fact.id);
    evicted++;
    
    if (evicted % 50 === 0) console.log(`  ${evicted}/${stale.length} evicted`);
  } catch (e) {
    errors++;
    if (errors <= 3) console.error(`  Error: ${e.message}`);
  }
}

const hotCount = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
const coldCount = db.prepare('SELECT COUNT(*) as c FROM cortex_cold_memory').get();
console.log(`\nDone. Evicted: ${evicted}, Errors: ${errors}`);
console.log(`Hot memory: ${hotCount.c}, Cold storage: ${coldCount.c}`);

db.close();
