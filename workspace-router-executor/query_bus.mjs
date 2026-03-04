import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { open: true });

console.log('=== cortex_bus (last 20 rows) ===');
try {
  const total = db.prepare('SELECT COUNT(*) as c FROM cortex_bus').get();
  console.log('Total rows:', total.c);
  const rows = db.prepare('SELECT rowid, * FROM cortex_bus ORDER BY rowid DESC LIMIT 20').all();
  for (const row of rows) {
    const r = { ...row };
    if (r.payload && r.payload.length > 200) r.payload = r.payload.slice(0, 200) + '...';
    if (r.data && r.data.length > 200) r.data = r.data.slice(0, 200) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_pending_ops (all rows) ===');
try {
  const total = db.prepare('SELECT COUNT(*) as c FROM cortex_pending_ops').get();
  console.log('Total rows:', total.c);
  const rows = db.prepare('SELECT rowid, * FROM cortex_pending_ops ORDER BY rowid DESC LIMIT 50').all();
  for (const row of rows) {
    const r = { ...row };
    if (r.payload && r.payload.length > 300) r.payload = r.payload.slice(0, 300) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_hot_memory (last 10 rows) ===');
try {
  const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
  console.log('Total rows:', total.c);
  const rows = db.prepare('SELECT rowid, * FROM cortex_hot_memory ORDER BY rowid DESC LIMIT 10').all();
  for (const row of rows) {
    const r = { ...row };
    if (r.value && r.value.length > 200) r.value = r.value.slice(0, 200) + '...';
    if (r.data && r.data.length > 200) r.data = r.data.slice(0, 200) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_cold_memory (last 10 rows) ===');
try {
  const total = db.prepare('SELECT COUNT(*) as c FROM cortex_cold_memory').get();
  console.log('Total rows:', total.c);
  const rows = db.prepare('SELECT rowid, * FROM cortex_cold_memory ORDER BY rowid DESC LIMIT 10').all();
  for (const row of rows) {
    const r = { ...row };
    if (r.content && r.content.length > 200) r.content = r.content.slice(0, 200) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== cortex_channel_states (all rows) ===');
try {
  const rows = db.prepare('SELECT rowid, * FROM cortex_channel_states ORDER BY rowid DESC LIMIT 20').all();
  console.log('Count:', rows.length);
  for (const row of rows) {
    const r = { ...row };
    if (r.data && r.data.length > 300) r.data = r.data.slice(0, 300) + '...';
    console.log(JSON.stringify(r));
  }
} catch(e) { console.log('Error:', e.message); }

db.close();
