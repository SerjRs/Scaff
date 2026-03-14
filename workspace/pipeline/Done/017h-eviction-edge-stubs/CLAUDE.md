# Claude Code Instructions — 017h

## Branch
`feat/017h-eviction-edge-stubs`

## Context
The knowledge graph has `hippocampus_facts` (active facts) and `hippocampus_edges` (relationships). Cold storage exists in `cortex_cold_memory` + `cortex_cold_memory_vec` tables. Currently the Vector Evictor in `gardener.ts` evicts from `cortex_hot_memory` → cold storage. This task adds graph-aware eviction that preserves edge structure via stubs, and revival when cold facts get queried.

## What to Build

### 1. Add `getStaleGraphFacts()` in `hippocampus.ts`

```typescript
export function getStaleGraphFacts(
  db: DatabaseSync,
  olderThanDays = 14,
  maxHitCount = 3,
): GraphFact[]
```
Same logic as `getStaleHotFacts` but queries `hippocampus_facts WHERE status = 'active'`.

### 2. Add `evictFact()` in `hippocampus.ts`

```typescript
export function evictFact(
  db: DatabaseSync,
  factId: string,
  embedding: Float32Array,
): void
```

Steps:
1. Read the fact from `hippocampus_facts`
2. Insert into cold storage via existing `insertColdFact(db, factText, embedding)` — returns a rowid
3. Update `hippocampus_facts` SET `status = 'evicted'`, `cold_vector_id = <rowid from step 2>`
4. For each edge in `hippocampus_edges` where `from_fact_id = factId OR to_fact_id = factId`:
   - SET `is_stub = 1`, `stub_topic = <first 50 chars of fact_text>`

### 3. Add `reviveFact()` in `hippocampus.ts`

```typescript
export function reviveFact(db: DatabaseSync, factId: string): void
```

Steps:
1. Update `hippocampus_facts` SET `status = 'active'`, `hit_count = 1`, `last_accessed_at = now`, `cold_vector_id = NULL`
2. For each edge where `from_fact_id = factId OR to_fact_id = factId` AND `is_stub = 1`:
   - Check if the OTHER endpoint fact is still active (or also being revived)
   - If the other endpoint is active: SET `is_stub = 0`, `stub_topic = NULL`
   - If the other endpoint is evicted: leave as stub (only clear this fact's side)

Note: For simplicity, just clear `is_stub` on any edge touching the revived fact where the OTHER endpoint has `status = 'active'`. Edges where both endpoints are evicted stay as stubs.

### 4. Add `pruneOldStubs()` in `hippocampus.ts`

```typescript
export function pruneOldStubs(db: DatabaseSync, olderThanDays = 90): number
```

Delete edges from `hippocampus_edges` WHERE:
- `is_stub = 1`
- `created_at < <cutoff>`
- BOTH `from_fact_id` and `to_fact_id` have `status = 'evicted'` in `hippocampus_facts`

Return count of deleted edges.

### 5. Update `runVectorEvictor()` in `gardener.ts`

Add a second pass that evicts stale graph facts:
```typescript
// After existing cortex_hot_memory eviction...

// Graph-aware eviction
const staleGraphFacts = getStaleGraphFacts(db, olderThanDays, maxHitCount);
for (const fact of staleGraphFacts) {
  try {
    const embedding = await embedFn(fact.factText);
    evictFact(db, fact.id, embedding);
    result.processed++;
  } catch (err) {
    result.errors.push(`graph:${fact.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Prune old stubs
pruneOldStubs(db, 90);
```

Import `getStaleGraphFacts`, `evictFact`, `pruneOldStubs` from `./hippocampus.js`.

### 6. Update `executeMemoryQuery()` in `tools.ts`

After searching cold storage and finding results, check if any cold fact matches an evicted graph fact and revive it:

After the existing `searchColdFacts` call and before returning results, add:
```typescript
// Check if any cold results match evicted graph facts — revive them
for (const fact of results) {
  const evictedMatch = db.prepare(
    `SELECT id FROM hippocampus_facts WHERE fact_text = ? AND status = 'evicted'`
  ).get(fact.factText) as { id: string } | undefined;
  
  if (evictedMatch) {
    reviveFact(db, evictedMatch.id);
  }
}
```

Import `reviveFact` from `./hippocampus.js` at the top of tools.ts.

Also update the tracking hook section to work with graph facts too:
```typescript
// After revival check, also touch graph facts
for (const fact of results) {
  const graphMatch = db.prepare(
    `SELECT id FROM hippocampus_facts WHERE fact_text = ? AND status = 'active'`
  ).get(fact.factText) as { id: string } | undefined;
  
  if (graphMatch) {
    touchGraphFact(db, graphMatch.id);
  }
}
```

Import `touchGraphFact` from `./hippocampus.js`.

## Files to Modify
| File | Change |
|------|--------|
| `src/cortex/hippocampus.ts` | `getStaleGraphFacts`, `evictFact`, `reviveFact`, `pruneOldStubs` |
| `src/cortex/gardener.ts` | Add graph eviction pass to `runVectorEvictor()` |
| `src/cortex/tools.ts` | Add revival logic to `executeMemoryQuery()` |

## Tests

Write tests in `src/cortex/__tests__/eviction-stubs.test.ts`:

1. **`evictFact` moves fact to cold + sets edges as stubs** — insert fact + edges, evict, verify status='evicted', edges have is_stub=1 and stub_topic set
2. **`evictFact` stores cold_vector_id** — verify hippocampus_facts.cold_vector_id is set after eviction
3. **Evicted facts excluded from getTopFactsWithEdges** — evicted facts don't appear in hot results
4. **`reviveFact` restores status and reconnects edges** — evict then revive, verify status='active', hit_count=1, edges with active endpoints have is_stub=0
5. **`reviveFact` leaves stubs for still-evicted endpoints** — two facts connected by edge, evict both, revive only one, edge stays as stub
6. **`pruneOldStubs` deletes old stubs where both endpoints evicted** — create old stub edge between two evicted facts, prune, verify deleted
7. **`pruneOldStubs` keeps stubs where one endpoint is active** — edge with one active endpoint survives pruning
8. **`getStaleGraphFacts` returns only active stale facts** — mix of active and evicted facts, only active returned
9. **`executeMemoryQuery` revives evicted graph fact on cold hit** — full E2E: insert graph fact, evict it, query cold storage, verify revival

For test setup:
- Use `initBus()` + `initSessionTables()` + `initHotMemoryTable()` (creates graph tables too)
- Use `initColdStorage(db)` for cold storage vec table
- Use `initGraphVecTable(db)` for graph fact vec table (from hippocampus.ts, added in 017d)
- Mock embedFn with deterministic seed-based embeddings (see gardener.test.ts for pattern)
- For `pruneOldStubs` test: manually INSERT edges with old `created_at` timestamps

## Constraints
- Do NOT remove existing `cortex_hot_memory` eviction from `runVectorEvictor` — keep it as-is, add graph eviction as a second pass
- All new functions must be exported from hippocampus.ts
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 017h eviction edge stubs"`
