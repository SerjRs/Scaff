const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite');

// Mark all old background shards as extracted so only the fresh foreground shard loads
// Keep only: c4c99df6 (current open foreground, started 08:31)
const r = db.prepare(`
  UPDATE cortex_shards 
  SET extracted_at = datetime('now')
  WHERE ended_at IS NOT NULL 
    AND extracted_at IS NULL
`).run();
console.log('Marked old closed shards as extracted:', r.changes);

// Verify
const active = db.prepare(`
  SELECT id, channel, topic, message_count, token_count, ended_at
  FROM cortex_shards WHERE extracted_at IS NULL
`).all();
console.log('\nActive (unextracted) shards remaining:');
active.forEach(s => console.log(s));

db.close();
