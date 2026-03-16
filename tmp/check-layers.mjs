import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// Check source_ref distribution - do facts link back to raw files?
console.log("=== source_ref distribution ===");
const refs = db.prepare(`
  SELECT source_type, 
    CASE WHEN source_ref IS NULL THEN 'NULL' 
         WHEN source_ref = '' THEN 'EMPTY'
         ELSE substr(source_ref, 1, 60) END as ref_sample,
    count(*) as cnt
  FROM hippocampus_facts 
  GROUP BY source_type, CASE WHEN source_ref IS NULL THEN 'NULL' WHEN source_ref = '' THEN 'EMPTY' ELSE substr(source_ref, 1, 60) END
  ORDER BY cnt DESC
`).all();
for (const r of refs) {
  console.log(`  [${r.source_type}] ref=${r.ref_sample} (${r.cnt})`);
}

// Check edges - how connected is the graph?
console.log("\n=== Edge stats ===");
const edgeCount = db.prepare("SELECT count(*) as n FROM hippocampus_edges").get();
console.log(`Total edges: ${edgeCount.n}`);

const edgeTypes = db.prepare("SELECT edge_type, count(*) as cnt FROM hippocampus_edges GROUP BY edge_type ORDER BY cnt DESC").all();
for (const e of edgeTypes) {
  console.log(`  ${e.edge_type}: ${e.cnt}`);
}

// How many facts have NO edges at all?
const orphans = db.prepare(`
  SELECT count(*) as n FROM hippocampus_facts f
  WHERE NOT EXISTS (SELECT 1 FROM hippocampus_edges e WHERE e.from_fact_id = f.id OR e.to_fact_id = f.id)
`).get();
const total = db.prepare("SELECT count(*) as n FROM hippocampus_facts").get();
console.log(`\nOrphan facts (no edges): ${orphans.n} / ${total.n}`);

// Sample a daily_log fact - does it have source_ref to the file?
console.log("\n=== Sample daily_log facts ===");
const samples = db.prepare(`
  SELECT fact_text, source_type, source_ref 
  FROM hippocampus_facts 
  WHERE source_type = 'daily_log' 
  LIMIT 5
`).all();
for (const s of samples) {
  console.log(`  text: ${s.fact_text.slice(0, 80)}`);
  console.log(`  ref: ${s.source_ref}`);
}

// Sample curated_memory
console.log("\n=== Sample curated_memory facts ===");
const curated = db.prepare(`
  SELECT fact_text, source_ref 
  FROM hippocampus_facts 
  WHERE source_type = 'curated_memory' 
  LIMIT 5
`).all();
for (const s of curated) {
  console.log(`  text: ${s.fact_text.slice(0, 80)}`);
  console.log(`  ref: ${s.source_ref}`);
}
