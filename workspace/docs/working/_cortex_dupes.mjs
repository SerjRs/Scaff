import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

const dupes = db.prepare(`
  SELECT envelope_id, COUNT(*) as c 
  FROM cortex_session 
  GROUP BY envelope_id 
  HAVING c > 1
  ORDER BY c DESC
  LIMIT 10
`).all();

console.log(`=== ${dupes.length} duplicate envelope_ids (showing top 10) ===\n`);

for (const d of dupes) {
  console.log(`envelope_id: ${d.envelope_id} (${d.c}x)`);
  const rows = db.prepare("SELECT role, channel, sender_id, timestamp, substr(content,1,100) as preview FROM cortex_session WHERE envelope_id = ?").all(d.envelope_id);
  for (const r of rows) {
    console.log(`  [${r.timestamp}] ${r.role}/${r.channel} (${r.sender_id}): ${r.preview}`);
  }
  console.log();
}

db.close();
