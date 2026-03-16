import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// 1. Find the Task 011 fact
const task011 = db.prepare(`
  SELECT id, fact_text, fact_type, confidence, status, source_type, source_ref, hit_count, created_at
  FROM hippocampus_facts 
  WHERE fact_text LIKE '%Task 011 addresses 4 root causes%'
`).all();

console.log("=== Task 011 facts ===");
for (const f of task011) {
  console.log(`  id: ${f.id}`);
  console.log(`  text: ${f.fact_text}`);
  console.log(`  type: ${f.fact_type}, confidence: ${f.confidence}, status: ${f.status}`);
  console.log(`  source: ${f.source_type} / ${f.source_ref}`);
  console.log(`  hit_count: ${f.hit_count}, created: ${f.created_at}`);
}

// 2. Check how many facts have vec entries
const totalFacts = db.prepare(`SELECT count(*) as n FROM hippocampus_facts`).get();
const vecInfo = db.prepare(`SELECT * FROM hippocampus_facts_vec_info`).all();
console.log(`\n=== Vec index stats ===`);
console.log(`Total facts: ${totalFacts.n}`);
console.log(`Vec info:`, vecInfo);

// 3. Check vec_rowids to see if Task 011 fact is in vec
if (task011.length > 0) {
  const factId = task011[0].id;
  // Check cold_vector_id
  const withVecId = db.prepare(`SELECT id, cold_vector_id FROM hippocampus_facts WHERE id = ?`).get(factId);
  console.log(`\nTask 011 cold_vector_id: ${withVecId?.cold_vector_id}`);
}

// 4. Sample of distances - get a few random facts and their vec presence
const sample = db.prepare(`
  SELECT id, substr(fact_text, 1, 80) as preview, status, source_type, cold_vector_id
  FROM hippocampus_facts 
  ORDER BY RANDOM() 
  LIMIT 10
`).all();
console.log(`\n=== Random sample of facts ===`);
for (const s of sample) {
  console.log(`  [${s.status}] vec_id=${s.cold_vector_id} src=${s.source_type}: ${s.preview}`);
}

// 5. Check if most facts have null cold_vector_id
const nullVec = db.prepare(`SELECT count(*) as n FROM hippocampus_facts WHERE cold_vector_id IS NULL`).get();
const hasVec = db.prepare(`SELECT count(*) as n FROM hippocampus_facts WHERE cold_vector_id IS NOT NULL`).get();
console.log(`\n=== Vec coverage ===`);
console.log(`Facts WITH cold_vector_id: ${hasVec.n}`);
console.log(`Facts WITHOUT cold_vector_id: ${nullVec.n}`);

// 6. Total rows in vec table
const vecRows = db.prepare(`SELECT count(*) as n FROM hippocampus_facts_vec_rowids`).get();
console.log(`Vec rowids count: ${vecRows.n}`);
