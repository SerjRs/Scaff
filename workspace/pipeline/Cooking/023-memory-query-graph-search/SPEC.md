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

## Unit Tests

Add to a new file `src/cortex/__tests__/unit-memory-query.test.ts`:

Use real Ollama embeddings (`nomic-embed-text` at `127.0.0.1:11434`) — NO mocks.

1. **Graph facts appear in memory_query results**
   - Create temp bus.sqlite, init all tables (hot memory, cold, graph, vec)
   - Insert a fact into `hippocampus_facts` with embedding in `hippocampus_facts_vec` (e.g. "Scaff was created on February 3, 2026")
   - Call `executeMemoryQuery(db, { query: "when was Scaff created" }, embedFn)`
   - Assert result JSON contains a fact with `source: "graph"` matching the inserted fact
   - Assert `factId` is present in the result

2. **Graph facts include edge hints**
   - Insert two facts + an edge between them (e.g. fact A "Scaff created Feb 3" → sourced_from → fact B "2026-02-03 daily log")
   - Call `executeMemoryQuery(db, { query: "Scaff creation" }, embedFn)`
   - Assert result includes `edges` array with the edge type and target text

3. **Cold facts still returned alongside graph facts**
   - Insert a fact in `cortex_cold_memory` AND a different fact in `hippocampus_facts`
   - Call `executeMemoryQuery` with a query relevant to both
   - Assert results contain both `source: "graph"` and `source: "cold"` entries
   - Assert results are sorted by distance (best match first regardless of source)

4. **Dedup: same fact in both cold and graph**
   - Insert identical fact text in both `cortex_cold_memory` and `hippocampus_facts`
   - Call `executeMemoryQuery`
   - Assert only one result returned (no duplicates), prefer graph version (has edges)

5. **Empty graph + populated cold still works**
   - Only insert cold facts, no graph facts
   - Call `executeMemoryQuery`
   - Assert cold results returned as before (backward compatibility)

6. **Empty cold + populated graph works**
   - Only insert graph facts, no cold facts
   - Call `executeMemoryQuery`
   - Assert graph results returned

## E2E Tests

Add to `src/cortex/__tests__/e2e-memory-query-graph.test.ts`:

Use real Ollama embeddings and real Sonnet via `complete()` from `src/llm/simple-complete.ts` — NO mocks.

1. **Full Cortex loop: memory_query returns graph facts**
   - Start Cortex with `hippocampusEnabled: true` and real `callLLM` (use `createGatewayLLMCaller` with Sonnet)
   - Insert graph facts with real embeddings
   - Send a webchat message that should trigger Cortex to call `memory_query`
   - Verify the LLM received graph facts in the tool result (check via the response content or debug logging)

2. **memory_query revival still works with graph search**
   - Insert a graph fact, evict it (should go to cold + edge stubs)
   - Call `executeMemoryQuery` with a matching query
   - Assert the fact is found (from cold) AND revived back to active in the graph

## Auth & Dependencies

- Ollama must be running at `127.0.0.1:11434` with `nomic-embed-text` model
- Anthropic auth via `~/.openclaw/agents/main/agent/auth-profiles.json` (profile `anthropic:scaff`)
- `src/llm/simple-complete.ts` handles auth resolution automatically
- `src/cortex/llm-caller.ts` — `createGatewayLLMCaller` for E2E Cortex loop tests

## Embedding Function for Tests

```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json() as { embedding: number[] };
  return new Float32Array(data.embedding);
}
```

## LLM Function for E2E Tests

```typescript
import { complete } from '../../llm/simple-complete.js';
const extractLLM = async (prompt: string) =>
  complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });
```
