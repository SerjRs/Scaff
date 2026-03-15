import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

const recent = db.prepare(
  `SELECT id, state, priority, enqueued_at, processed_at, attempts, error, envelope
   FROM cortex_bus WHERE enqueued_at > ? ORDER BY enqueued_at ASC`
).all('2026-03-15T20:40:00');

console.log(`Messages since 22:40 Bucharest (20:40 UTC): ${recent.length}\n`);

for (const r of recent) {
  let env;
  try { env = JSON.parse(r.envelope); } catch { env = {}; }
  const content = (env.content || env.text || '').substring(0, 80);
  const channel = env.channel || '?';
  console.log(
    `${r.enqueued_at} | ${r.state} | ${channel} | pri=${r.priority} | attempts=${r.attempts}` +
    (r.error ? ` | ERR: ${r.error.substring(0, 120)}` : '') +
    (content ? ` | "${content}"` : '')
  );
}
