const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite');

// Show current state
const msgs = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE shard_id LIKE 'dca8eda1%'").get();
console.log('Messages in corrupted shard dca8eda1:', msgs.c);

// Delete all cortex_session messages belonging to this shard
const deleted = db.prepare("DELETE FROM cortex_session WHERE shard_id LIKE 'dca8eda1%'").run();
console.log('Deleted messages:', deleted.changes);

// Delete the shard record too so a new foreground shard is created
const deletedShard = db.prepare("DELETE FROM cortex_shards WHERE id LIKE 'dca8eda1%'").run();
console.log('Deleted shard record:', deletedShard.changes);

// Verify
const remaining = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE shard_id LIKE 'dca8eda1%'").get();
console.log('Remaining:', remaining.c);

// Show latest shard
const cols = db.prepare('PRAGMA table_info(cortex_shards)').all();
const colNames = cols.map(c => c.name).join(', ');
console.log('Shard columns:', colNames);
const latestShards = db.prepare('SELECT * FROM cortex_shards ORDER BY rowid DESC LIMIT 3').all();
latestShards.forEach(s => console.log('Shard:', s));

db.close();
console.log('\nDone — Cortex will create a fresh foreground shard on next message.');
