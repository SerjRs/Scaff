import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { open: true });

console.log('=== TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(t => t.name).join(', '));

console.log('\n=== router_bus (last 20 rows) ===');
try {
  const rows = db.prepare('SELECT rowid, * FROM router_bus ORDER BY rowid DESC LIMIT 20').all();
  console.log('Count:', rows.length);
  for (const row of rows) {
    // Truncate content for readability
    const r = { ...row };
    if (r.content && r.content.length > 200) r.content = r.content.slice(0, 200) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_session (last 10 rows) ===');
try {
  const rows = db.prepare('SELECT rowid, * FROM cortex_session ORDER BY rowid DESC LIMIT 10').all();
  console.log('Count:', rows.length);
  for (const row of rows) {
    const r = { ...row };
    if (r.content && r.content.length > 300) r.content = r.content.slice(0, 300) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_checkpoints (last 10 rows) ===');
try {
  const rows = db.prepare('SELECT rowid, * FROM cortex_checkpoints ORDER BY rowid DESC LIMIT 10').all();
  console.log('Count:', rows.length);
  for (const row of rows) {
    const r = { ...row };
    if (r.data && r.data.length > 200) r.data = r.data.slice(0, 200) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== sqlite_sequence ===');
try {
  const rows = db.prepare('SELECT * FROM sqlite_sequence').all();
  for (const row of rows) console.log(JSON.stringify(row));
} catch(e) { console.log('Error:', e.message); }

db.close();
