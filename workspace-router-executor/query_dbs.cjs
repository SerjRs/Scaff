const Database = require('better-sqlite3');
const path = require('path');

const dbs = [
  'C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite',
  'C:\\Users\\Temp User\\.openclaw\\memory\\agent.sqlite',
  'C:\\Users\\Temp User\\.openclaw\\memory\\main.sqlite',
];

for (const dbPath of dbs) {
  console.log('\n========================================');
  console.log('DATABASE: ' + dbPath);
  console.log('========================================');
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map(t => t.name).join(', '));

    for (const t of tables) {
      try {
        const rows = db.prepare('SELECT * FROM [' + t.name + '] ORDER BY rowid DESC LIMIT 20').all();
        console.log('\n--- TABLE: ' + t.name + ' (' + rows.length + ' rows shown) ---');
        if (rows.length > 0) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          console.log('(empty)');
        }
      } catch(e) {
        try {
          const rows = db.prepare('SELECT * FROM [' + t.name + '] LIMIT 20').all();
          console.log('\n--- TABLE: ' + t.name + ' (no rowid, ' + rows.length + ' rows) ---');
          console.log(JSON.stringify(rows, null, 2));
        } catch(e2) {
          console.log('\n--- TABLE: ' + t.name + ' ERROR: ' + e2.message);
        }
      }
    }
    db.close();
  } catch(e) {
    console.log('FAILED to open:', e.message);
  }
}
