/**
 * 024: Seed hit_count for backfilled hippocampus facts
 *
 * One-shot migration that assigns initial hit_count values based on
 * source_type and fact_type. Only updates rows where hit_count = 0.
 * Idempotent — safe to run multiple times.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".openclaw", "cortex", "bus.sqlite");
console.log(`Opening database: ${dbPath}`);

const db = new DatabaseSync(dbPath);

// Run updates in order of specificity (most specific first where needed)
const updates = [
  {
    label: "curated_memory → 10",
    sql: `UPDATE hippocampus_facts SET hit_count = 10 WHERE source_type = 'curated_memory' AND hit_count = 0`,
  },
  {
    label: "correction → 8",
    sql: `UPDATE hippocampus_facts SET hit_count = 8 WHERE fact_type = 'correction' AND hit_count = 0`,
  },
  {
    label: "daily_log + decision → 7",
    sql: `UPDATE hippocampus_facts SET hit_count = 7 WHERE source_type = 'daily_log' AND fact_type = 'decision' AND hit_count = 0`,
  },
  {
    label: "daily_log + other → 3",
    sql: `UPDATE hippocampus_facts SET hit_count = 3 WHERE source_type = 'daily_log' AND fact_type != 'decision' AND hit_count = 0`,
  },
  {
    label: "pipeline_task/cortex_archive + decision → 5",
    sql: `UPDATE hippocampus_facts SET hit_count = 5 WHERE source_type IN ('pipeline_task', 'cortex_archive') AND fact_type = 'decision' AND hit_count = 0`,
  },
  {
    label: "pipeline_task/cortex_archive + other → 2",
    sql: `UPDATE hippocampus_facts SET hit_count = 2 WHERE source_type IN ('pipeline_task', 'cortex_archive') AND fact_type != 'decision' AND hit_count = 0`,
  },
  {
    label: "article/executor_session/workspace_session/executor_doc → 1",
    sql: `UPDATE hippocampus_facts SET hit_count = 1 WHERE source_type IN ('article', 'executor_session', 'workspace_session', 'executor_doc') AND hit_count = 0`,
  },
];

console.log("\n=== Seeding hit_count values ===\n");

for (const { label, sql } of updates) {
  const result = db.exec(sql);
  console.log(`  ${label}: ${result} rows updated`);
}

// Distribution
console.log("\n=== Distribution ===\n");
const dist = db.prepare(`
  SELECT source_type, fact_type, hit_count, count(*) as cnt
  FROM hippocampus_facts
  GROUP BY source_type, fact_type, hit_count
  ORDER BY hit_count DESC, cnt DESC
`).all();

console.table(dist);

// Top 30 preview
console.log("\n=== Top 30 Facts (System Floor preview) ===\n");
const top30 = db.prepare(`
  SELECT substr(fact_text, 1, 80) as preview, source_type, fact_type, hit_count
  FROM hippocampus_facts
  WHERE status = 'active'
  ORDER BY hit_count DESC, last_accessed_at DESC
  LIMIT 30
`).all();

console.table(top30);

db.close();
console.log("\nDone.");
