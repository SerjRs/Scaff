import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// What facts were extracted from the Feb 3 daily log?
const facts = db.prepare(`
  SELECT fact_text, fact_type, hit_count, source_ref
  FROM hippocampus_facts 
  WHERE source_ref LIKE '%2026-02-03%'
`).all();

console.log(`=== Facts from Feb 3 log (${facts.length}) ===`);
for (const f of facts) {
  console.log(`  [${f.fact_type}] (hits:${f.hit_count}) ${f.fact_text}`);
}

// What edges connect to these facts?
const edges = db.prepare(`
  SELECT e.edge_type, 
    f1.fact_text as from_text, 
    f2.fact_text as to_text
  FROM hippocampus_edges e
  JOIN hippocampus_facts f1 ON e.from_fact_id = f1.id
  JOIN hippocampus_facts f2 ON e.to_fact_id = f2.id
  WHERE f1.source_ref LIKE '%2026-02-03%' OR f2.source_ref LIKE '%2026-02-03%'
`).all();

console.log(`\n=== Edges involving Feb 3 facts (${edges.length}) ===`);
for (const e of edges) {
  console.log(`  ${e.from_text.slice(0, 50)} --[${e.edge_type}]--> ${e.to_text.slice(0, 50)}`);
}
