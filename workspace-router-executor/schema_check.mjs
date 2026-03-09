import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const dbPath = 'C:\\Users\\Temp User\\.openclaw\\router-jobs.db';

if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ error: 'DB file not found', path: dbPath }));
  process.exit(0);
}

const db = new DatabaseSync(dbPath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
const pragma = db.prepare('PRAGMA journal_mode').get();
const pageSize = db.prepare('PRAGMA page_size').get();
const pageCount = db.prepare('PRAGMA page_count').get();

console.log('=== SCHEMA VALIDATION ===');
console.log(JSON.stringify({ tables: tables.map(t => t.name), journal: pragma, pageSize, pageCount }));

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  const idxs = db.prepare(`PRAGMA index_list(${t.name})`).all();
  console.log(`\n[TABLE: ${t.name}]`);
  console.log('  columns:', JSON.stringify(cols.map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }))));
  console.log('  indexes:', JSON.stringify(idxs.map(i => i.name)));
}
