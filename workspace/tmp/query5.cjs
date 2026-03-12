const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite', {readOnly: true});

// Shard schema
const cols = db.prepare("PRAGMA table_info(cortex_shards)").all();
console.log('Shard columns:', cols.map(c => c.name + ':' + c.type).join(', '));

// Get shards
const shards = db.prepare('SELECT * FROM cortex_shards ORDER BY id DESC LIMIT 10').all();
shards.forEach(s => {
  console.log('\nShard:', s.id.substring(0, 8));
  for (const [k, v] of Object.entries(s)) {
    if (k === 'id') continue;
    console.log('  ' + k + ':', typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v);
  }
});

// Count messages per shard in the incident window
console.log('\n--- Messages per shard (17:00-17:35 UTC) ---');
const perShard = db.prepare(`
  SELECT shard_id, COUNT(*) as c, MIN(id) as first_id, MAX(id) as last_id,
         MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
  FROM cortex_session 
  WHERE timestamp > '2026-03-11T17:00:00' AND timestamp < '2026-03-11T17:35:00'
  GROUP BY shard_id ORDER BY first_id
`).all();
perShard.forEach(r => {
  console.log('  Shard ' + (r.shard_id || 'NULL').substring(0, 8) + ': ' + r.c + ' msgs (' + r.first_id + '-' + r.last_id + ') ' + r.first_ts.substring(11,19) + ' - ' + r.last_ts.substring(11,19));
});

db.close();
