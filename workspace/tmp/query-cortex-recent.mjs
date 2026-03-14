import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite', { open: true, readOnly: true });

// Get all session messages from 15:14 local (13:14 UTC) onwards
const msgs = db.prepare(`
  SELECT id, role, channel, sender_id, sender_name, content, timestamp, shard_id, issuer
  FROM cortex_session
  WHERE timestamp >= '2026-03-14T13:14:00'
  ORDER BY timestamp ASC
`).all();

console.log(`Found ${msgs.length} messages\n`);

for (const m of msgs) {
    const localTime = new Date(m.timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const content = m.content && m.content.length > 600 ? m.content.substring(0, 600) + '...' : m.content;
    console.log(`[${localTime}] ${m.channel} | ${m.role} (${m.sender_name || m.sender_id}) | shard=${m.shard_id}`);
    console.log(content || '(empty)');
    console.log('---');
}
