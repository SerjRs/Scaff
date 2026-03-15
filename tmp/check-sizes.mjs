import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('library/library.sqlite');
const rows = db.prepare("SELECT id, title, length(summary) as slen, length(full_text) as ftlen FROM items WHERE status != 'failed' ORDER BY created_at").all();
for (const r of rows) {
  console.log(`${(r.title||'').substring(0,55).padEnd(55)} summary: ${String(r.slen).padStart(5)}  full_text: ${String(r.ftlen ?? 0).padStart(6)}`);
}
db.close();
