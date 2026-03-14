const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite');

// Find messages from around 11:26 today (UTC+2 = 09:26 UTC)
const msgs = db.prepare(`
  SELECT id, role, channel, shard_id, timestamp, substr(content, 1, 400) as preview
  FROM cortex_session
  WHERE timestamp >= '2026-03-12T09:00:00'
  ORDER BY id ASC
`).all();

console.log('Messages from 11:00+ today:', msgs.length);
msgs.forEach(m => {
  console.log(`\n[${m.id}] ${m.role} @ ${m.timestamp} [${m.channel}] shard=${m.shard_id}`);
  console.log('  ', m.preview);
});

db.close();
