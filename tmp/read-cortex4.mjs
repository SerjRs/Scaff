import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT channel, role, sender_name, substr(content, 1, 500) as preview, timestamp
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T13:44:00' 
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  if (r.channel === 'internal' && r.preview.includes('thinking')) continue; // skip thinking
  const name = r.sender_name || r.role;
  let content = r.preview;
  // Clean up thinking blocks
  content = content.replace(/\[?\{"type":"thinking".*$/s, '[thinking...]');
  console.log(`\n--- ${r.timestamp} [${r.channel}] ${name} ---`);
  console.log(content.slice(0, 350));
}
console.log(`\nTotal: ${rows.length} messages`);
