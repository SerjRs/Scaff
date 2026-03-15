---
id: "023"
title: "memory_query must search hippocampus_facts_vec"
created: "2026-03-16"
author: "scaff"
priority: "critical"
status: "cooking"
---

# 023 — memory_query Must Search the Knowledge Graph

## Problem

`executeMemoryQuery` in `src/cortex/tools.ts` only searches `cortex_cold_memory` (687 pre-graph facts via `searchColdFacts`). It completely ignores `hippocampus_facts_vec` (6,655 graph facts with embeddings).

When Cortex calls `memory_query("when was I created")`, it searches 687 old cold facts and misses the 6,655 facts in the knowledge graph — including facts that explicitly mention "first day alive" and "2026-02-03".

The spec (017) says `memory_query` returns "facts + their edges." The graph has both. Cold storage has neither edges nor the backfilled knowledge.

## Root Cause

`memory_query` was built before the graph existed (it searched cold storage only). When 017d added `searchGraphFacts()`, it was wired into the consolidator and gardener (internal processes) but never into the `memory_query` tool (the LLM-facing search).

## Fix

In `executeMemoryQuery` (`src/cortex/tools.ts`):

1. Call `searchGraphFacts(db, queryEmbedding, limit)` alongside `searchColdFacts(db, queryEmbedding, limit)`
2. Merge results by distance, deduplicate by fact text
3. For graph results, include edge hints in the response (edge type + connected fact text) — these are the pull-cords for `graph_traverse`
4. Keep cold storage search as fallback for evicted facts not yet in the graph

## Expected Response Format

```json
{
  "facts": [
    {
      "text": "Daily logs span from 2026-02-03 (first day alive)",
      "distance": 2.1,
      "source": "graph",
      "factId": "abc-123",
      "edges": [
        { "type": "sourced_from", "target": "2026-02-03 daily log" }
      ]
    },
    {
      "text": "Some old cold fact",
      "distance": 5.3,
      "source": "cold",
      "archivedAt": "2026-03-01"
    }
  ]
}
```

## Files to Change

- `src/cortex/tools.ts` — `executeMemoryQuery()`: add `searchGraphFacts` call, merge results
- Import `searchGraphFacts` from `./hippocampus.js`
- Import `queryEdgesForFact` for edge hints on graph results

## Tests

- Existing `e2e-webchat-hippo.test.ts` tests memory_query but uses mocked cold storage — needs a test that inserts graph facts and verifies they appear in memory_query results
- Add test: insert fact into `hippocampus_facts` + `hippocampus_facts_vec`, call `executeMemoryQuery`, assert result includes the graph fact with edges
