import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { open: true, readOnly: true });

// Get full content of key messages
const ids = [5402, 5410, 5414, 5417, 5419, 5421, 5430, 5432, 5434];
for (const id of ids) {
  const row = db.prepare(`SELECT id, role, channel, sender_name, content, timestamp, shard_id FROM cortex_session WHERE id = ?`).get(id);
  if (row) {
    console.log(`\n=== ID=${row.id} role=${row.role} channel=${row.channel} sender=${row.sender_name} ts=${row.timestamp} ===`);
    console.log(row.content);
  }
}

// Check shards
const shards = db.prepare(`SELECT * FROM cortex_shards ORDER BY created_at DESC LIMIT 5`).all();
console.log('\n=== Recent shards ===');
for (const s of shards) {
  console.log(`id=${s.id} created=${s.created_at} token_count=${s.token_count} msg_count=${s.message_count}`);
}

db.close();
