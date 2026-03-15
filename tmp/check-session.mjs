import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Check cortex_session for whatsapp channel
const sessions = db.prepare(
  `SELECT id, channel_id, shard_id, updated_at, substr(history, -2000) as tail
   FROM cortex_session WHERE channel_id = ? ORDER BY updated_at DESC LIMIT 3`
).all('whatsapp');

console.log(`WhatsApp sessions: ${sessions.length}\n`);

for (const s of sessions) {
  console.log(`Session: ${s.id} | shard=${s.shard_id} | updated=${s.updated_at}`);
  try {
    // Parse the tail of history to find assistant replies
    const hist = JSON.parse('[' + s.tail.substring(s.tail.indexOf('{"role"')));
    const assistantMsgs = hist.filter(m => m.role === 'assistant');
    console.log(`  Recent assistant messages: ${assistantMsgs.length}`);
    for (const m of assistantMsgs.slice(-5)) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      console.log(`  -> ${content.substring(0, 150)}`);
    }
  } catch (e) {
    console.log(`  (could not parse history tail: ${e.message})`);
  }
  console.log();
}
