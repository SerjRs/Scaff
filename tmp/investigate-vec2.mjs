import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// What are the 10 entries in the vec index?
const vecRowids = db.prepare(`SELECT rowid FROM hippocampus_facts_vec_rowids`).all();
console.log("=== Vec rowids ===");
console.log(vecRowids);

// Check if the vec table uses integer rowids that map to hippocampus_facts
// Let's look at how facts are inserted - check for any facts with sequential IDs
const recentFacts = db.prepare(`
  SELECT id, substr(fact_text, 1, 100) as preview, source_type, created_at 
  FROM hippocampus_facts 
  ORDER BY created_at DESC 
  LIMIT 15
`).all();
console.log("\n=== Most recent facts ===");
for (const f of recentFacts) {
  console.log(`  ${f.created_at} [${f.source_type}]: ${f.preview}`);
}

// Check how many facts were created today (from live Cortex conversation)
const todayFacts = db.prepare(`
  SELECT count(*) as n FROM hippocampus_facts 
  WHERE created_at >= '2026-03-16'
`).get();
console.log(`\nFacts created today: ${todayFacts.n}`);

// Those 10 vec entries - what rowids?
const chunks = db.prepare(`SELECT * FROM hippocampus_facts_vec_chunks`).all();
console.log(`\n=== Vec chunks ===`);
console.log(`Count: ${chunks.length}`);
if (chunks.length > 0) {
  console.log(`Sample:`, chunks[0]);
}

// Check the cold_memory vec for comparison
const coldVecRows = db.prepare(`SELECT count(*) as n FROM cortex_cold_memory_vec_rowids`).get();
const coldTotal = db.prepare(`SELECT count(*) as n FROM cortex_cold_memory`).get();
console.log(`\n=== Cold memory comparison ===`);
console.log(`Cold facts: ${coldTotal.n}`);
console.log(`Cold vec rowids: ${coldVecRows.n}`);
