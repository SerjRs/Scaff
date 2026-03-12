import Database from 'better-sqlite3';

const db = new Database('C:\\Users\\Temp User\\.openclaw\\library\\library.sqlite');

console.log('=== DATABASE SCHEMA ===\n');
const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name;").all();
tables.forEach(t => {
  if (t.sql) console.log(t.sql + ';\n');
});

console.log('=== RECORD WITH id=1 ===\n');
try {
  const record = db.prepare('SELECT * FROM items WHERE id=1;').all();
  console.log('Result:', JSON.stringify(record, null, 2));
  if (record.length === 0) {
    console.log('No record found with id=1');
  }
} catch (e) {
  console.log('Error querying items table:', e.message);
}

db.close();
