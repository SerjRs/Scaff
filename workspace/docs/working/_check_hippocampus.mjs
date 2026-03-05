import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

// Hot memory
try {
  const hot = db.prepare("SELECT COUNT(*) as cnt FROM cortex_hot_memory").get();
  console.log("\nHot memory rows:", hot.cnt);
  const sample = db.prepare("SELECT id, fact_text, hit_count, last_accessed_at FROM cortex_hot_memory ORDER BY last_accessed_at DESC LIMIT 5").all();
  for (const r of sample) console.log("  ", r.fact_text?.slice(0, 80), `(hits: ${r.hit_count})`);
} catch(e) { console.log("Hot memory error:", e.message); }

// Cold memory
try {
  const cold = db.prepare("SELECT COUNT(*) as cnt FROM cortex_cold_memory").get();
  console.log("\nCold memory rows:", cold.cnt);
} catch(e) { console.log("Cold memory:", e.message); }

// Channel states
try {
  const ch = db.prepare("SELECT COUNT(*) as cnt FROM cortex_channel_states").get();
  console.log("\nChannel states:", ch.cnt);
  const sample = db.prepare("SELECT * FROM cortex_channel_states LIMIT 5").all();
  for (const r of sample) console.log("  ", JSON.stringify(r).slice(0, 120));
} catch(e) { console.log("Channel states:", e.message); }

// Pending ops
try {
  const ops = db.prepare("SELECT COUNT(*) as cnt FROM cortex_pending_ops").get();
  console.log("\nPending ops:", ops.cnt);
} catch(e) { console.log("Pending ops:", e.message); }

// Session
try {
  const sess = db.prepare("SELECT COUNT(*) as cnt FROM cortex_session").get();
  console.log("\nSession rows:", sess.cnt);
} catch(e) { console.log("Session:", e.message); }

db.close();
