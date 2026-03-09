import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'fs';

const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

// Export current session to JSON backup
const rows = db.prepare("SELECT * FROM cortex_session ORDER BY rowid").all();
console.log(`Exporting ${rows.length} session rows...`);
writeFileSync(
  process.env.USERPROFILE + '/.openclaw/cortex/session-archive-2026-03-09.json',
  JSON.stringify(rows, null, 2),
  'utf8'
);

// Clear session (facts are already in hot/cold memory)
db.prepare("DELETE FROM cortex_session").run();
console.log('Session cleared.');

// Verify
const remaining = db.prepare("SELECT COUNT(*) as c FROM cortex_session").get();
console.log(`Remaining rows: ${remaining.c}`);

db.close();
