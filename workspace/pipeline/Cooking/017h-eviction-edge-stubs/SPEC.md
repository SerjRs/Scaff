---
id: "017h"
title: "Eviction with edge stubs + revival on search hit"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a", "017b"]
parent: "017"
---

# 017h — Eviction with Edge Stubs + Revival

## Depends on
- 017a (graph schema)
- 017b (System Floor injection must handle stubs)

## Touches
- `src/cortex/hippocampus.ts`
- `src/cortex/tools.ts` (memory_query enhancement)

## What to Build

**`evictFact(db, factId, embedding)`:**
1. Insert fact text + embedding into existing cold storage (`cortex_cold_memory` + `cortex_cold_memory_vec`)
2. Set `hippocampus_facts.status = 'evicted'`, store `cold_vector_id`
3. For each edge touching this fact: set `is_stub = 1`, `stub_topic` = first 50 chars of fact_text

**`reviveFact(db, factId)`:**
1. Set `hippocampus_facts.status = 'active'`
2. Reset `hit_count = 1`, `last_accessed_at = now`
3. Clear `cold_vector_id`
4. For each stub edge touching this fact: set `is_stub = 0`, clear `stub_topic`

**`pruneOldStubs(db, olderThanDays=90)`:**
Delete edge stubs where BOTH endpoints are evicted and stub is >90 days old.

**Enhance `memory_query` tool:**
After finding a cold storage hit → call `reviveFact()` automatically. Return the revived fact + reconnected edges.

**Automated eviction (Gardener weekly):**
```typescript
function runEviction(db, embedFn) {
  const stale = getStaleGraphFacts(db, 14, 3); // >14d old, <3 hits
  for (const fact of stale) {
    const embedding = await embedFn(fact.factText);
    evictFact(db, fact.id, embedding);
  }
  pruneOldStubs(db, 90);
}
```

## What to Delete
- Old eviction functions that operate on `cortex_hot_memory` directly (replaced by graph-aware versions)

## What NOT to Change
- Cold storage schema (`cortex_cold_memory` + vec) — stays the same
- `searchColdFacts` — stays the same

## Tests
- Evict fact → edges become stubs with topic hints
- System Floor shows stubs as `[evicted: topic]`
- `memory_query` hit on evicted fact → fact revived, edges reconnected
- Stub pruning removes old stubs where both endpoints evicted
- Evicted facts don't appear in `getTopFactsWithEdges`
- Revival resets hit_count and reconnects all stub edges

## Files
| File | Change |
|------|--------|
| `src/cortex/hippocampus.ts` | `evictFact`, `reviveFact`, `pruneOldStubs`, `getStaleGraphFacts` |
| `src/cortex/tools.ts` | Enhance `memory_query` executor with revival |
