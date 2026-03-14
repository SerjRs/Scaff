const db = require('better-sqlite3')('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite');

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(r => r.name).join(', '));

// For each table, show schema
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info('${t.name}')`).all();
  console.log(`\n${t.name}:`, cols.map(c => `${c.name}(${c.type})`).join(', '));
}

// Find today's messages (March 14, 2026)
const today = new Date('2026-03-14T00:00:00+02:00').getTime();
const tomorrow = new Date('2026-03-15T00:00:00+02:00').getTime();

// Check cortex_session for today's messages
try {
  const msgs = db.prepare(`SELECT * FROM cortex_session WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC`).all(today, tomorrow);
  console.log(`\nToday's cortex_session messages: ${msgs.length}`);
  for (const m of msgs) {
    const content = m.content ? m.content.substring(0, 200) : '(no content)';
    console.log(`  [${new Date(m.timestamp).toISOString()}] role=${m.role} | ${content}`);
  }
} catch(e) {
  console.log('cortex_session query failed:', e.message);
}

// Check cortex_bus for today's tasks
try {
  const tasks = db.prepare(`SELECT * FROM cortex_bus WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`).all(today, tomorrow);
  console.log(`\nToday's cortex_bus entries: ${tasks.length}`);
  for (const t of tasks) {
    console.log(`  [${new Date(t.created_at).toISOString()}] state=${t.state} issuer=${t.issuer} | ${(t.prompt || '').substring(0, 200)}`);
  }
} catch(e) {
  console.log('cortex_bus query failed:', e.message);
}

db.close();
