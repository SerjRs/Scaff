import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Get all messages from today (2026-03-11)
const rows = db.prepare(`
  SELECT id, role, channel, sender_id, issuer, shard_id, content, timestamp 
  FROM cortex_session 
  WHERE timestamp >= '2026-03-11T00:00:00.000Z'
  ORDER BY id ASC
`).all();

for (const r of rows) {
  const ts = r.timestamp?.slice(11,19) || '?';
  console.log(`--- [${r.id}] ${ts} | ${r.role} | ${r.channel} | sender=${r.sender_id} | shard=${r.shard_id?.slice(0,8) || 'null'} ---`);
  console.log(r.content || '[empty]');
  console.log();
}

console.log(`Total messages today: ${rows.length}`);
db.close();
