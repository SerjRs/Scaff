import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Get messages after 09:25 UTC (11:25 local) — around the restart
const rows = db.prepare(`
  SELECT id, role, channel, sender_id, shard_id, substr(content, 1, 200) as preview, timestamp 
  FROM cortex_session 
  WHERE timestamp >= '2026-03-11T09:25:00.000Z'
  ORDER BY id ASC
`).all();

for (const r of rows) {
  const ts = r.timestamp?.slice(11,19) || '?';
  const shard = r.shard_id ? r.shard_id.slice(0,8) : 'NULL';
  console.log(`[${r.id}] ${ts} | ${r.role.padEnd(9)} | ${r.channel.padEnd(10)} | sender=${(r.sender_id||'').padEnd(12)} | shard=${shard}`);
  console.log(`  ${(r.preview || '[empty]').replace(/\n/g, ' ').slice(0, 180)}`);
  console.log();
}

console.log(`Total messages since restart: ${rows.length}`);
db.close();
