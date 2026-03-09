const path = require('path');
const dbPath = path.join('C:\\Users\\Temp User\\.openclaw', 'router', 'queue.sqlite');

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('better-sqlite3 load failed:', e.message);
  process.exit(1);
}

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('=== TABLES ===');
console.log(tables.map(t => t.name).join(', '));

// Query 1: active/pending/in-flight jobs
console.log('\n=== QUERY 1: Non-terminal jobs ===');
try {
  const q1 = db.prepare("SELECT * FROM jobs WHERE status NOT IN ('completed', 'failed', 'canceled') ORDER BY created_at DESC").all();
  if (q1.length === 0) {
    console.log('(no rows)');
  } else {
    console.log(JSON.stringify(q1, null, 2));
  }
} catch (e) {
  console.log('ERROR:', e.message);
}

// Query 2: status counts
console.log('\n=== QUERY 2: Status counts (jobs) ===');
try {
  const q2 = db.prepare("SELECT status, COUNT(*) as count FROM jobs GROUP BY status").all();
  if (q2.length === 0) {
    console.log('(no rows — table empty)');
    // Query 3: check jobs_archive
    console.log('\n=== QUERY 3: Status counts (jobs_archive) ===');
    try {
      const q3 = db.prepare("SELECT status, COUNT(*) as count FROM jobs_archive GROUP BY status").all();
      if (q3.length === 0) {
        console.log('(no rows)');
      } else {
        console.log(JSON.stringify(q3, null, 2));
      }
    } catch (e2) {
      console.log('ERROR:', e2.message);
    }
  } else {
    console.log(JSON.stringify(q2, null, 2));
  }
} catch (e) {
  console.log('ERROR:', e.message);
}

db.close();
