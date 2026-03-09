import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const facts = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log('Facts:', facts.c);

const cols = db.prepare("PRAGMA table_info(cortex_hot_memory)").all();
console.log('Hot memory columns:', cols.map(c => c.name).join(', '));

const sample = db.prepare('SELECT * FROM cortex_hot_memory LIMIT 3').all();
for (const f of sample) {
  console.log(JSON.stringify(f, (k,v) => typeof v === 'bigint' ? Number(v) : v).substring(0, 300));
}

db.close();
