const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite');

// Mark the 120K token freeze shard as extracted so context assembly skips it
// This shard is from the March 11 freeze (X.com ingestion)
const r1 = db.prepare(`
  UPDATE cortex_shards 
  SET extracted_at = datetime('now')
  WHERE id = '1021bb59-71db-4305-9daf-6620099f162e'
`).run();
console.log('Marked 1021bb59 as extracted:', r1.changes);

// Also mark the webchat shard (not relevant for whatsapp Cortex)
const r2 = db.prepare(`
  UPDATE cortex_shards 
  SET extracted_at = datetime('now')
  WHERE id = '062410a3-0408-4380-8486-67a6c069cfa3'
    AND channel = 'webchat'
`).run();
console.log('Marked webchat shard as extracted:', r2.changes);

// Check what's left in active context pool
const active = db.prepare(`
  SELECT id, channel, topic, message_count, token_count, 
         started_at, ended_at, extracted_at
  FROM cortex_shards 
  WHERE extracted_at IS NULL
  ORDER BY rowid DESC LIMIT 5
`).all();
console.log('\nActive (unextracted) shards:');
active.forEach(s => console.log(s));

db.close();
