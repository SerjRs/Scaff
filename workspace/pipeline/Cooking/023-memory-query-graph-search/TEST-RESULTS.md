# 023 — memory_query Graph Search Test Results

Generated: 2026-03-16
Duration: 2.02s (all 8 tests)

## Summary

- **Total:** 8
- **Passed:** 8
- **Failed:** 0

## Unit Tests (`unit-memory-query.test.ts`)

All use real Ollama embeddings (`nomic-embed-text` at `127.0.0.1:11434`).

### 1. Graph facts appear in memory_query results ✅ (305ms)
- Inserted a graph fact with real embedding
- Queried with semantically related query
- Result contains `source: "graph"` with `factId`

### 2. Graph facts include edge hints ✅ (211ms)
- Inserted two facts + `sourced_from` edge
- Query returned graph fact with `edges` array
- Edge includes `type: "sourced_from"` and target hint text

### 3. Cold facts returned alongside graph facts ✅ (323ms)
- Inserted graph fact + cold fact
- Both `source: "graph"` and `source: "cold"` appear
- Results sorted by distance (ascending)

### 4. Dedup: same fact in both cold and graph ✅ (96ms)
- Identical text in both cold and graph storage
- Only one result returned (no duplicates)
- Graph version preferred (`source: "graph"`)

### 5. Returns cold facts when graph is empty ✅ (253ms)
- Only cold facts present
- Cold results returned with `archivedAt` field
- Backward compatibility maintained

### 6. Returns graph facts when cold storage is empty ✅ (222ms)
- Only graph facts present
- Graph results returned with `factId`

## E2E Tests (`e2e-memory-query-graph.test.ts`)

All use real Ollama embeddings.

### 1. Full pipeline: graph facts with edges via real embeddings ✅ (812ms)
- Seeded 5 graph facts with 3 edges (realistic knowledge cluster)
- Added unrelated cold fact
- Query "When was Scaff first created and who made it?" returned graph facts
- Creation fact found with edges attached
- Results sorted by distance
- Side effects verified: hit_count incremented, facts promoted to hot memory

### 2. Eviction → cold search → revival ✅ (370ms)
- Inserted graph fact + related fact + edge
- Evicted fact to cold storage (edges became stubs)
- memory_query found the fact via cold storage
- Side effect: evicted fact revived to `active` status
- Edge reconnected (un-stubbed) since other endpoint is active
