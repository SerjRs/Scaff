import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT id, channel, role, sender_name, substr(content, 1, 300) as preview, timestamp, shard_id
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T11:18:00' 
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  const name = r.sender_name || r.role;
  console.log(`\n--- ${r.timestamp} [${r.channel}] ${name} (shard: ${r.shard_id}) ---`);
  console.log(r.preview);
}
console.log(`\nTotal: ${rows.length} messages`);
