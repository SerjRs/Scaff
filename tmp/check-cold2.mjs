import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite', { allowExtension: true });
const sv = await import('sqlite-vec');
db.enableLoadExtension(true);
sv.load(db);

const cold = db.prepare('SELECT COUNT(*) as c FROM cortex_cold_memory').get();
console.log('Cold memory rows:', cold.c);

const coldVec = db.prepare('SELECT COUNT(*) as c FROM cortex_cold_memory_vec').get();
console.log('Cold memory vectors:', coldVec.c);

if (cold.c > 0) {
  const cols = db.prepare('PRAGMA table_info(cortex_cold_memory)').all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
  const sample = db.prepare('SELECT * FROM cortex_cold_memory LIMIT 3').all();
  for (const s of sample) {
    console.log(JSON.stringify(s, (k,v) => typeof v === 'bigint' ? Number(v) : v).substring(0, 300));
  }
} else {
  console.log('\nCold storage is empty. Vector Evictor has not run yet.');
  console.log('Evictor interval: 1 week');
}

db.close();
