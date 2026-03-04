import { DatabaseSync } from 'node:sqlite';

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
    const db = new DatabaseSync(dbPath, { open: true });
    const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
    console.log('Tables/Views:', tables.map(t => t.name).join(', '));

    for (const t of tables) {
      try {
        // Try to get row count
        let count = 0;
        try { count = db.prepare('SELECT COUNT(*) as c FROM [' + t.name + ']').get().c; } catch {}

        // Get last 20 rows
        let rows;
        try {
          rows = db.prepare('SELECT * FROM [' + t.name + '] ORDER BY rowid DESC LIMIT 20').all();
        } catch {
          try {
            rows = db.prepare('SELECT * FROM [' + t.name + '] LIMIT 20').all();
          } catch(e2) {
            console.log('\n--- TABLE: ' + t.name + ' [ERROR: ' + e2.message + '] ---');
            continue;
          }
        }
        console.log('\n--- TABLE: ' + t.name + ' (total rows ~' + count + ', showing ' + rows.length + ') ---');
        if (rows.length > 0) {
          // Print column names
          console.log('Columns:', Object.keys(rows[0]).join(' | '));
          console.log('---');
          for (const row of rows) {
            console.log(JSON.stringify(row));
          }
        } else {
          console.log('(empty)');
        }
      } catch(e) {
        console.log('\n--- TABLE: ' + t.name + ' [SKIP: ' + e.message + '] ---');
      }
    }
    db.close();
  } catch(e) {
    console.log('FAILED to open:', e.message);
  }
}
