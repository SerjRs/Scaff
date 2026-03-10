import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Find actual shard table name
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%shard%'`).all();
console.log('Shard tables:', tables.map(t => t.name));

for (const t of tables) {
  const active = db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}" WHERE status = 'active'`).get();
  console.log(`${t.name}: ${active.cnt} active`);
  if (active.cnt > 0) {
    const r = db.prepare(`UPDATE "${t.name}" SET status = 'closed' WHERE status = 'active'`).run();
    console.log(`  Closed: ${r.changes}`);
  }
}

const after = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_session`).get();
console.log(`\nSession rows: ${after.cnt}`);

// Verify last row is clean
const last = db.prepare(`SELECT id, role, substr(content,1,100) as content FROM cortex_session ORDER BY id DESC LIMIT 1`).get();
console.log(`Last row: id=${last.id} role=${last.role} ${last.content}`);

db.close();
