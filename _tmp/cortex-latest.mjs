import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Latest session messages
console.log("=== LAST 20 SESSION MESSAGES ===");
const rows = db.prepare(`
  SELECT id, role, channel, sender_id, issuer, shard_id, 
         substr(content,1,150) as content, timestamp 
  FROM cortex_session 
  ORDER BY id DESC LIMIT 20
`).all();
rows.reverse();
for (const r of rows) {
  console.log(`${r.id} | ${r.role} | ${r.channel} | sender=${r.sender_id} | issuer=${r.issuer} | shard=${r.shard_id} | ${r.timestamp}`);
  console.log(`  ${r.content}`);
  console.log();
}

// Check bus for pending/failed messages
console.log("=== LAST 10 BUS ENTRIES ===");
const bus = db.prepare(`
  SELECT id, status, channel, substr(payload,1,150) as payload, created_at, processed_at, error
  FROM cortex_bus 
  ORDER BY id DESC LIMIT 10
`).all();
bus.reverse();
for (const b of bus) {
  console.log(`${b.id} | ${b.status} | ${b.channel} | ${b.created_at} | err=${b.error || 'none'}`);
  console.log(`  ${b.payload}`);
  console.log();
}

// Check channel states
console.log("=== CHANNEL STATES ===");
const states = db.prepare(`SELECT * FROM cortex_channel_state`).all();
for (const s of states) {
  console.log(JSON.stringify(s));
}

db.close();
