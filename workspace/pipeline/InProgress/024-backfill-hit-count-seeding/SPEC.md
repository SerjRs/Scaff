---
id: "024"
title: "Seed hit_count for backfilled graph facts"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
---

# 024 — Seed hit_count for Backfilled Graph Facts

## Problem

The System Floor injects the top-30 facts from `hippocampus_facts` ranked by `hit_count DESC, last_accessed_at DESC`. All 6,655 backfilled facts have `hit_count = 0` and roughly the same `last_accessed_at` timestamp (backfill time). The top-30 is effectively random — Cortex sees arbitrary backfilled facts instead of the most important ones.

This means the "small graph" on the System Floor (the breadcrumbs the LLM sees every turn) is useless noise rather than curated high-value knowledge.

## Root Cause

The backfill script (`scripts/backfill-memory.ts`) inserted facts with default `hit_count = 0` and `last_accessed_at = NOW()`. It had no way to rank importance — all facts were treated equally regardless of source or content.

## Fix Options

### Option A: Source-based seeding (recommended)
Assign initial `hit_count` based on source type and fact type:

| Source Type | Fact Type | Initial hit_count |
|---|---|---|
| curated_memory | any | 10 |
| correction | any | 8 |
| daily_log | decision | 7 |
| daily_log | fact | 3 |
| pipeline_task | decision | 5 |
| pipeline_task | fact | 2 |
| cortex_archive | decision | 5 |
| cortex_archive | fact | 2 |
| article | any | 1 |
| executor_session | any | 1 |
| workspace_session | any | 1 |

Rationale: curated memory (MEMORY.md, MEMORY-BCK.md) was hand-written by Scaff — highest signal. Corrections are high-value learning. Daily log decisions matter more than raw facts. Articles and executor sessions are reference material.

### Option B: LLM-based importance scoring
Run a cheap model (Haiku) over all 6,655 facts with a prompt like "Rate 1-10 how important this fact is for an AI assistant's long-term memory." Use the score as hit_count. More accurate but costs API calls (~$2-3 for 6,655 facts).

### Option C: Hybrid
Apply Option A first (free, instant), then run Option B on the top-500 to refine.

## Implementation

One-shot migration script (similar to `scripts/backfill-memory.ts`):

```sql
UPDATE hippocampus_facts SET hit_count = 10 WHERE source_type = 'curated_memory';
UPDATE hippocampus_facts SET hit_count = 8 WHERE source_type = 'correction';
UPDATE hippocampus_facts SET hit_count = 7 WHERE source_type = 'daily_log' AND fact_type = 'decision';
UPDATE hippocampus_facts SET hit_count = 3 WHERE source_type = 'daily_log' AND fact_type != 'decision';
-- etc.
```

Also update `last_accessed_at` to spread across the original source dates (not backfill time) so recency ranking reflects actual chronology.

## Future: Backfill script should seed hit_count

Update `scripts/backfill-memory.ts` to apply source-based seeding at insert time, so future backfills don't repeat this problem.

## Files to Change

- New script: `scripts/seed-hit-counts.ts` (one-shot migration)
- Optional: `scripts/backfill-memory.ts` — add hit_count seeding to `insertFact` calls

## Tests

- After seeding, verify `getTopFactsWithEdges(db, 30)` returns curated_memory and correction facts first
- Verify System Floor content includes high-value facts, not random backfill noise
