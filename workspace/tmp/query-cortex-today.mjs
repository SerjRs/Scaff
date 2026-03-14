import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { open: true, readOnly: true });

// Messages from 12:44 local (10:44 UTC) onwards
const from = new Date('2026-03-14T10:44:00Z').toISOString();

const msgs = db.prepare(`
  SELECT id, role, channel, sender_name, sender_id, substr(content, 1, 500) as content, timestamp, shard_id
  FROM cortex_session
  WHERE timestamp >= ?
  ORDER BY id ASC
`).all(from);

console.log(`Messages from ${from}: ${msgs.length}\n`);
for (const m of msgs) {
  console.log(`--- [id=${m.id}] role=${m.role} channel=${m.channel} sender=${m.sender_name || m.sender_id} ts=${m.timestamp}`);
  console.log(m.content);
  console.log();
}

db.close();
