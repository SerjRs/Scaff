import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Get recent WhatsApp session entries (both user and assistant)
const rows = db.prepare(
  `SELECT role, channel, sender_id, content, timestamp, shard_id
   FROM cortex_session 
   WHERE channel = 'whatsapp' AND timestamp > '2026-03-15T20:40:00'
   ORDER BY timestamp ASC`
).all();

console.log(`WhatsApp session entries since 22:40 Bucharest: ${rows.length}\n`);

for (const r of rows) {
  const content = (r.content || '').substring(0, 150);
  console.log(`${r.timestamp} | ${r.role} | shard=${r.shard_id} | "${content}"`);
}
