const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite', {readOnly: true});

// Count rows in each table
const tables = ['cortex_bus', 'cortex_pending_ops', 'cortex_session', 'cortex_shards', 'cortex_hot_memory', 'library_pending_tasks'];
for (const t of tables) {
  try {
    const r = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
    console.log(t + ':', r.c, 'rows');
  } catch(e) {
    console.log(t + ': ERROR', e.message);
  }
}

// Look at library_pending_tasks
console.log('\n--- library_pending_tasks ---');
try {
  const lpt = db.prepare('SELECT * FROM library_pending_tasks').all();
  lpt.forEach(r => console.log(r));
} catch(e) {
  console.log('ERROR:', e.message);
}

// Look at cortex_pending_ops
console.log('\n--- cortex_pending_ops (last 10) ---');
const ops = db.prepare('SELECT id, type, status, dispatched_at, completed_at, reply_channel FROM cortex_pending_ops ORDER BY id DESC LIMIT 10').all();
if (ops.length === 0) console.log('(empty)');
ops.forEach(op => console.log(op));

// Look at cortex_bus (last 10)
console.log('\n--- cortex_bus (last 10) ---');
const bus = db.prepare('SELECT id, state, priority, enqueued_at, processed_at, attempts, error FROM cortex_bus ORDER BY id DESC LIMIT 10').all();
bus.forEach(b => console.log(b));

db.close();
