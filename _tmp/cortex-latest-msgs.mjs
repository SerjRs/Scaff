import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT id, role, channel, sender_id, shard_id, content, timestamp 
  FROM cortex_session 
  WHERE timestamp >= '2026-03-11T09:30:00.000Z'
    AND role = 'assistant'
    AND channel IN ('webchat', 'whatsapp')
  ORDER BY id DESC
  LIMIT 5
`).all();

for (const r of rows) {
  const ts = r.timestamp?.slice(11,19) || '?';
  const shard = r.shard_id ? r.shard_id.slice(0,8) : 'NULL';
  console.log(`=== [${r.id}] ${ts} | ${r.channel} | shard=${shard} ===`);
  console.log(r.content || '[empty]');
  console.log();
}

db.close();
