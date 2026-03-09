import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

// List all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('All tables:', tables.map(t => t.name).join(', '));

// Check cold/vector/archive tables
for (const name of tables.map(t => t.name)) {
  if (name.match(/cold|long|vector|archive|evict/i)) {
    const c = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get();
    console.log(`\n${name}: ${c.c} rows`);
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    console.log('  Columns:', cols.map(c => c.name).join(', '));
    if (c.c > 0) {
      const sample = db.prepare(`SELECT * FROM "${name}" LIMIT 2`).all();
      for (const s of sample) {
        console.log('  ', JSON.stringify(s, (k,v) => typeof v === 'bigint' ? Number(v) : v).substring(0, 200));
      }
    }
  }
}

db.close();
