import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

// Check stale facts (>14 days old, hit_count < 3) — these are Evictor candidates
const stale = db.prepare(`
  SELECT COUNT(*) as cnt FROM cortex_hot_memory 
  WHERE last_accessed_at < datetime('now', '-14 days') AND hit_count < 3
`).get();
console.log("Stale facts eligible for eviction:", stale.cnt);

// Check facts by age
const ages = db.prepare(`
  SELECT 
    CASE 
      WHEN last_accessed_at > datetime('now', '-1 day') THEN 'last_24h'
      WHEN last_accessed_at > datetime('now', '-7 days') THEN 'last_7d'
      WHEN last_accessed_at > datetime('now', '-14 days') THEN 'last_14d'
      ELSE 'older_than_14d'
    END as age_bucket,
    COUNT(*) as cnt
  FROM cortex_hot_memory
  GROUP BY age_bucket
`).all();
console.log("\nHot memory by age:");
for (const r of ages) console.log(`  ${r.age_bucket}: ${r.cnt}`);

// Check hit counts distribution
const hits = db.prepare(`
  SELECT hit_count, COUNT(*) as cnt FROM cortex_hot_memory GROUP BY hit_count ORDER BY hit_count
`).all();
console.log("\nHot memory by hit_count:");
for (const r of hits) console.log(`  hits=${r.hit_count}: ${r.cnt}`);

db.close();
