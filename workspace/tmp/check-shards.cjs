const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite');

// Active shards
console.log('=== ACTIVE SHARDS ===');
const shards = db.prepare(`
  SELECT id, channel, topic, first_message_id, last_message_id, 
         message_count, token_count, started_at, ended_at
  FROM cortex_shards 
  ORDER BY rowid DESC LIMIT 5
`).all();
shards.forEach(s => console.log(s));

// Current foreground shard (open)
console.log('\n=== OPEN SHARDS (foreground) ===');
const open = db.prepare(`
  SELECT id, channel, topic, message_count, token_count, started_at
  FROM cortex_shards WHERE ended_at IS NULL
`).all();
open.forEach(s => console.log(s));

// Count messages per shard loaded in context
console.log('\n=== MESSAGE COUNT IN ACTIVE SHARDS ===');
const msgs = db.prepare(`
  SELECT shard_id, COUNT(*) as cnt 
  FROM cortex_session 
  WHERE shard_id IS NOT NULL 
  GROUP BY shard_id 
  ORDER BY cnt DESC
  LIMIT 10
`).all();
msgs.forEach(m => console.log(m));

// Latest messages
console.log('\n=== LATEST 5 MESSAGES ===');
const latest = db.prepare(`
  SELECT id, role, channel, shard_id, created_at, 
         substr(content, 1, 80) as preview
  FROM cortex_session 
  ORDER BY id DESC LIMIT 5
`).all();
latest.forEach(m => console.log(m));

db.close();
