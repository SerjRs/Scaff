const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = path.join(process.env.USERPROFILE, ".openclaw", "cortex", "bus.sqlite");
const db = new DatabaseSync(dbPath);

// Get messages from ~17:51 local = 15:51 UTC
const rows = db.prepare(
  `SELECT id, envelope_id, role, channel, sender_id, sender_name, 
          substr(content, 1, 300) as preview, timestamp, shard_id
   FROM cortex_session 
   WHERE timestamp > '2026-03-12T15:45:00'
   ORDER BY id`
).all();

for (const r of rows) {
  const preview = r.preview.replace(/\n/g, "\\n").substring(0, 250);
  console.log(`[${r.id}] ${r.timestamp} ${r.role}/${r.channel} (${r.sender_name || r.sender_id}):`);
  console.log(`  ${preview}`);
  console.log();
}

console.log(`\nTotal: ${rows.length} messages after 15:45 UTC`);
db.close();
