import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// All WhatsApp messages in the bus
const waMessages = db.prepare(
  "SELECT id, state, enqueued_at, envelope FROM cortex_bus WHERE json_extract(envelope, '$.channel') = 'whatsapp' ORDER BY enqueued_at ASC"
).all();

console.log(`WhatsApp messages in Cortex bus: ${waMessages.length}`);
for (const m of waMessages) {
  const env = JSON.parse(m.envelope);
  console.log(`  [${m.enqueued_at}] state=${m.state} | sender=${env.sender?.name || env.sender?.id} | ${(env.content || '').substring(0, 100)}`);
}

// Check session for WhatsApp entries
const waSessions = db.prepare(
  "SELECT role, sender_id, channel, timestamp, substr(content,1,100) as preview FROM cortex_session WHERE channel = 'whatsapp' ORDER BY timestamp ASC"
).all();
console.log(`\nWhatsApp session rows: ${waSessions.length}`);
for (const s of waSessions) {
  console.log(`  [${s.timestamp}] ${s.role} (${s.sender_id}): ${s.preview}`);
}

db.close();
