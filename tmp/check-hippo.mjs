import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
    console.log(`  ${t.name}: ${count.c} rows`);
  } catch(e) { console.log(`  ${t.name}: error - ${e.message}`); }
}

db.close();
