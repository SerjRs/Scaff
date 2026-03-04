import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

// Bus: all 396 completed, 0 pending
console.log("=== cortex_bus ===");
const states = db.prepare("SELECT state, COUNT(*) as c FROM cortex_bus GROUP BY state").all();
for (const r of states) console.log(`  ${r.state}: ${r.c}`);

// Recent bus entries
console.log("\n=== cortex_bus recent 5 ===");
const recent = db.prepare("SELECT id, state, enqueued_at, processed_at, attempts, substr(envelope,1,150) as preview FROM cortex_bus ORDER BY id DESC LIMIT 5").all();
for (const r of recent) console.log(`  #${r.id} ${r.state} enq=${r.enqueued_at} proc=${r.processed_at} att=${r.attempts}\n    ${r.preview}`);

// Any errors?
console.log("\n=== bus errors ===");
const errors = db.prepare("SELECT id, error FROM cortex_bus WHERE error IS NOT NULL AND error != '' LIMIT 5").all();
console.log(errors.length === 0 ? "  None ✅" : errors.map(e => `  #${e.id}: ${e.error}`).join("\n"));

// Channel states
console.log("\n=== cortex_channel_states ===");
const cs = db.prepare("SELECT * FROM cortex_channel_states").all();
for (const s of cs) console.log(`  ${JSON.stringify(s)}`);

// Session duplicates
console.log("\n=== session duplicates ===");
const dupes = db.prepare("SELECT envelope_id, COUNT(*) as c FROM cortex_session GROUP BY envelope_id HAVING c > 1").all();
console.log(dupes.length === 0 ? "  None ✅" : `  ${dupes.length} dupes ⚠️`);

// Session: role distribution
console.log("\n=== session role/channel ===");
const dist = db.prepare("SELECT role, channel, COUNT(*) as c FROM cortex_session GROUP BY role, channel ORDER BY c DESC").all();
for (const r of dist) console.log(`  ${r.role}/${r.channel}: ${r.c}`);

// Hot memory
console.log("\n=== hot_memory ===");
const hm = db.prepare("SELECT COUNT(*) as c FROM cortex_hot_memory").get();
console.log(`  Entries: ${hm.c}`);
const hmCols = db.prepare("PRAGMA table_info(cortex_hot_memory)").all();
const hasTsCol = hmCols.find(c => c.name.includes("created") || c.name.includes("timestamp") || c.name.includes("ts"));
if (hasTsCol) {
  const oldest = db.prepare(`SELECT MIN("${hasTsCol.name}") as v FROM cortex_hot_memory`).get();
  const newest = db.prepare(`SELECT MAX("${hasTsCol.name}") as v FROM cortex_hot_memory`).get();
  console.log(`  Oldest: ${oldest.v}`);
  console.log(`  Newest: ${newest.v}`);
} else {
  console.log(`  Columns: ${hmCols.map(c=>c.name).join(", ")}`);
}

// Pending ops
console.log("\n=== pending_ops ===");
const po = db.prepare("SELECT COUNT(*) as c FROM cortex_pending_ops").get();
console.log(`  ${po.c} pending`);

db.close();
console.log("\n✅ DB check complete");
