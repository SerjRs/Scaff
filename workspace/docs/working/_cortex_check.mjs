import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

// Tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("=== Tables ===");
for (const t of tables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
    console.log(`  ${t.name}: ${count.c} rows`);
  } catch { console.log(`  ${t.name}: (skipped — requires extension)`); }
}

// Session breakdown by role/channel
console.log("\n=== cortex_session by role+channel ===");
const breakdown = db.prepare("SELECT role, channel, COUNT(*) as c FROM cortex_session GROUP BY role, channel ORDER BY c DESC").all();
for (const r of breakdown) console.log(`  ${r.role} / ${r.channel}: ${r.c}`);

// Last 15 messages
console.log("\n=== Last 15 session messages ===");
const recent = db.prepare("SELECT role, channel, sender_id, timestamp, substr(content,1,120) as preview FROM cortex_session ORDER BY timestamp DESC LIMIT 15").all();
for (const r of recent) console.log(`  [${r.timestamp}] ${r.role}/${r.channel} (${r.sender_id}): ${r.preview}`);

// Bus queue status
console.log("\n=== cortex_bus queue ===");
const busStatus = db.prepare("SELECT status, COUNT(*) as c FROM cortex_bus GROUP BY status").all();
for (const r of busStatus) console.log(`  ${r.status}: ${r.c}`);

// Channel states
console.log("\n=== channel_states ===");
try {
  const states = db.prepare("SELECT * FROM channel_states").all();
  for (const s of states) console.log(`  ${JSON.stringify(s)}`);
} catch { console.log("  (table not found)"); }

db.close();
