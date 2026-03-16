import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT channel, role, sender_name, substr(content, 1, 400) as preview, timestamp, shard_id
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T13:13:00' 
  AND channel = 'whatsapp'
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  const name = r.sender_name || r.role;
  const content = r.preview.replace(/\{"type":"thinking".*?"thinkingSignature":"[^"]*"/g, '[thinking...]');
  console.log(`\n--- ${r.timestamp} [${name}] ---`);
  console.log(content.slice(0, 300));
}
console.log(`\nTotal: ${rows.length} messages`);
