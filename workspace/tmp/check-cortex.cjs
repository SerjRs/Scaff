const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite', {readOnly: true});

// Channel states
console.log('--- Channel States ---');
const states = db.prepare('SELECT * FROM cortex_channel_states ORDER BY channel').all();
states.forEach(s => console.log(s));

// Last 5 messages
console.log('\n--- Last 10 cortex_session messages ---');
const msgs = db.prepare('SELECT id, timestamp, role, channel, shard_id, substr(content,1,100) as c FROM cortex_session ORDER BY id DESC LIMIT 10').all();
msgs.forEach(m => console.log(m.id, m.timestamp.substring(11,19), m.role, m.channel, m.c?.substring(0,80)));

// Cortex bus queue
console.log('\n--- Cortex bus (last 5) ---');
const bus = db.prepare('SELECT id, state, priority, enqueued_at, attempts, substr(envelope,1,100) as env FROM cortex_bus ORDER BY rowid DESC LIMIT 5').all();
bus.forEach(b => console.log(b));

db.close();
