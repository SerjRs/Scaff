import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Find the rows containing the duplicate tool_result
const rows = db.prepare(`
  SELECT id, role, channel, substr(content, 1, 200) as content, timestamp
  FROM cortex_session
  WHERE content LIKE '%toolu_01G3qN2yjF8zXAFZyUFiTdcV%'
  ORDER BY id ASC
`).all();

console.log(`Found ${rows.length} rows with the corrupted tool ID:`);
for (const r of rows) {
  console.log(`  ID=${r.id} | role=${r.role} | ${r.timestamp} | ${r.content.substring(0, 150)}`);
}

const total = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_session`).get();
console.log(`\nTotal session rows: ${total.cnt}`);

if (rows.length > 0) {
  const firstCorrupt = rows[0].id;
  const affected = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_session WHERE id >= ?`).get(firstCorrupt);
  console.log(`Rows that would be deleted (id >= ${firstCorrupt}): ${affected.cnt}`);
  console.log(`Rows that would be preserved (id < ${firstCorrupt}): ${total.cnt - affected.cnt}`);
}

db.close();
