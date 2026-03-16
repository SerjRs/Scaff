# CLAUDE.md — 024: Seed hit_count for backfilled facts

> **DO NOT ASK FOR CONFIRMATION. Execute all steps immediately.**

## Task

Create and run a one-shot migration script that seeds `hit_count` values for 6,655 backfilled hippocampus facts based on their `source_type` and `fact_type`. Currently all have `hit_count = 0`.

## Steps

### 1. Create `scripts/seed-hit-counts.ts`

The script should:

a) Open `cortex/bus.sqlite` using `DatabaseSync` from `node:sqlite`

b) Run these UPDATE statements (Option A from SPEC.md):

```sql
UPDATE hippocampus_facts SET hit_count = 10 WHERE source_type = 'curated_memory' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 8 WHERE fact_type = 'correction' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 7 WHERE source_type = 'daily_log' AND fact_type = 'decision' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 3 WHERE source_type = 'daily_log' AND fact_type != 'decision' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 5 WHERE source_type IN ('pipeline_task', 'cortex_archive') AND fact_type = 'decision' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 2 WHERE source_type IN ('pipeline_task', 'cortex_archive') AND fact_type != 'decision' AND hit_count = 0;
UPDATE hippocampus_facts SET hit_count = 1 WHERE source_type IN ('article', 'executor_session', 'workspace_session', 'executor_doc') AND hit_count = 0;
```

c) Log how many rows were updated per source_type

d) Query and log the new distribution:
```sql
SELECT source_type, fact_type, hit_count, count(*) as cnt 
FROM hippocampus_facts 
GROUP BY source_type, fact_type, hit_count 
ORDER BY hit_count DESC, cnt DESC;
```

e) Verify the top-30 facts (what System Floor would show):
```sql
SELECT substr(fact_text, 1, 80) as preview, source_type, fact_type, hit_count
FROM hippocampus_facts 
WHERE status = 'active'
ORDER BY hit_count DESC, last_accessed_at DESC 
LIMIT 30;
```

### 2. Run the script

```bash
npx tsx scripts/seed-hit-counts.ts
```

### 3. Write results

Create `workspace/pipeline/InProgress/024-backfill-hit-count-seeding/TEST-RESULTS.md` with:
- Number of rows updated per source_type
- Distribution table
- Top-30 preview
- Pass/fail: top-30 should contain curated_memory and decision facts, NOT random pipeline noise

### 4. Commit

```bash
git add scripts/seed-hit-counts.ts workspace/pipeline/InProgress/024-backfill-hit-count-seeding/
git commit -m "feat(024): seed hit_count for backfilled hippocampus facts"
```

## Environment
- Working dir: `C:\Users\Temp User\.openclaw`
- DB path: `C:\Users\Temp User\.openclaw\cortex\bus.sqlite`
- Node v24.13.0, Windows
- `node:sqlite` DatabaseSync — no external sqlite packages needed
- Branch: `feat/024-hit-count-seeding`

## Constraints
- Do NOT modify any source code in `src/` — this is a data migration only
- Do NOT delete or recreate tables
- Only update rows where `hit_count = 0` (don't overwrite live conversation facts that already have real hit_counts)
- Script must be idempotent (safe to run multiple times)
