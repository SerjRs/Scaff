import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

// Bus columns
const busInfo = db.prepare("PRAGMA table_info(cortex_bus)").all();
console.log("=== cortex_bus columns ===");
console.log(busInfo.map(c => c.name).join(", "));

// Bus by state
const stateCol = busInfo.find(c => c.name === "state" || c.name === "status");
if (stateCol) {
  const states = db.prepare(`SELECT "${stateCol.name}", COUNT(*) as c FROM cortex_bus GROUP BY "${stateCol.name}"`).all();
  console.log("\n=== cortex_bus by " + stateCol.name + " ===");
  for (const r of states) console.log(`  ${r[stateCol.name]}: ${r.c}`);
}

// Unprocessed messages?
console.log("\n=== cortex_bus recent 10 ===");
const busMsgs = db.prepare("SELECT id, created_at, substr(payload,1,100) as preview FROM cortex_bus ORDER BY id DESC LIMIT 10").all();
for (const r of busMsgs) console.log(`  #${r.id} [${r.created_at}] ${r.preview}`);

// Channel states
console.log("\n=== cortex_channel_states ===");
const states = db.prepare("SELECT * FROM cortex_channel_states").all();
for (const s of states) console.log(`  ${JSON.stringify(s)}`);

// Session health: any duplicate envelope_ids?
console.log("\n=== session duplicates check ===");
const dupes = db.prepare("SELECT envelope_id, COUNT(*) as c FROM cortex_session GROUP BY envelope_id HAVING c > 1").all();
console.log(dupes.length === 0 ? "  No duplicates ✅" : `  ${dupes.length} duplicate envelope_ids ⚠️`);

// Hot memory stats
console.log("\n=== cortex_hot_memory stats ===");
const hmCount = db.prepare("SELECT COUNT(*) as c FROM cortex_hot_memory").get();
console.log(`  Total entries: ${hmCount.c}`);
try {
  const hmOldest = db.prepare("SELECT MIN(created_at) as oldest FROM cortex_hot_memory").get();
  const hmNewest = db.prepare("SELECT MAX(created_at) as newest FROM cortex_hot_memory").get();
  console.log(`  Oldest: ${hmOldest.oldest}`);
  console.log(`  Newest: ${hmNewest.newest}`);
} catch {}

db.close();
