---
id: "017a"
title: "Graph schema (hippocampus_facts + hippocampus_edges) + migration"
created: "2026-03-14"
author: "scaff"
priority: "critical"
status: "in_progress"
moved_at: "2026-03-14"
depends_on: []
parent: "017"
---

# 017a — Graph Schema + Migration

> Foundation task. Everything else depends on this.

## Depends on
Nothing.

## Touches
- `src/cortex/hippocampus.ts`

## What to Build

Add two new tables alongside existing `cortex_hot_memory`:

```sql
CREATE TABLE IF NOT EXISTS hippocampus_facts (
  id               TEXT PRIMARY KEY,
  fact_text        TEXT NOT NULL,
  fact_type        TEXT DEFAULT 'fact',        -- fact | decision | outcome | correction
  confidence       TEXT DEFAULT 'medium',      -- high | medium | low
  status           TEXT DEFAULT 'active',      -- active | superseded | evicted
  source_type      TEXT,                       -- conversation | article | consolidation
  source_ref       TEXT,                       -- shard ID, library://item/N, or consolidation run ID
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  cold_vector_id   INTEGER                     -- rowid in cold_memory_vec when evicted
);

CREATE TABLE IF NOT EXISTS hippocampus_edges (
  id             TEXT PRIMARY KEY,
  from_fact_id   TEXT NOT NULL,
  to_fact_id     TEXT NOT NULL,
  edge_type      TEXT NOT NULL,                -- because, informed_by, contradicts, updated_by, related_to, part_of, resulted_in, sourced_from
  confidence     TEXT DEFAULT 'medium',
  is_stub        INTEGER DEFAULT 0,            -- 1 = target fact evicted, edge preserved as skeleton
  stub_topic     TEXT,                         -- topic hint when is_stub=1
  created_at     TEXT NOT NULL,
  FOREIGN KEY (from_fact_id) REFERENCES hippocampus_facts(id),
  FOREIGN KEY (to_fact_id) REFERENCES hippocampus_facts(id)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON hippocampus_edges(from_fact_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON hippocampus_edges(to_fact_id);
CREATE INDEX IF NOT EXISTS idx_facts_status ON hippocampus_facts(status);
CREATE INDEX IF NOT EXISTS idx_facts_hot ON hippocampus_facts(hit_count DESC, last_accessed_at DESC);
```

## Migration

Function `migrateHotMemoryToGraph(db)`:
1. Create new tables (if not exist)
2. For each row in `cortex_hot_memory`: insert into `hippocampus_facts` with `fact_type='fact'`, `source_type='conversation'`, preserving timestamps and hit_count
3. Leave `cortex_hot_memory` intact (backward compat)

## New CRUD Functions

- `insertFact(db, { factText, factType, confidence, sourceType, sourceRef, embedding? })` → returns fact ID
- `insertEdge(db, { fromFactId, toFactId, edgeType, confidence? })` → returns edge ID
- `getFactWithEdges(db, factId)` → fact + immediate edges
- `getTopFactsWithEdges(db, limit, maxEdgesPerFact)` → for System Floor injection
- `updateFactStatus(db, factId, status)` → mark superseded/evicted
- `setEdgeStub(db, edgeId, stubTopic)` → convert edge to stub

## What NOT to Change
- Do NOT delete `cortex_hot_memory` or its existing functions
- Do NOT change `context.ts` or `loadSystemFloor()`
- Do NOT change the hot-memory plugin behavior

## Tests
- Schema creation on empty DB
- Migration from `cortex_hot_memory` with sample data
- CRUD on facts + edges
- `getTopFactsWithEdges` ordered by hit_count with edges attached

## Files
| File | Change |
|------|--------|
| `src/cortex/hippocampus.ts` | New tables, migration function, new CRUD functions |
