import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');
const rows = db.prepare('SELECT id, channel, sender_id, role, substr(content,1,200) as content, timestamp FROM cortex_session ORDER BY id DESC LIMIT 30').all();
rows.reverse();
for (const r of rows) {
  console.log(`${r.id} | ${r.role} | ${r.channel} | ${r.timestamp} | ${r.content}`);
}
db.close();
