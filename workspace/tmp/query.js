const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite', {readOnly: true});

// List all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check for router/job tables
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  console.log(`\n${t.name}: ${cols.map(c => c.name).join(', ')}`);
}

db.close();
