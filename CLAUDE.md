# Claude Code Instructions — 017g

## Branch
`feat/017g-consolidator`

## Context
The knowledge graph now has facts from conversations (017d) and articles (017e) in `hippocampus_facts` + `hippocampus_edges`. Facts from different sources may be related but have no edges connecting them. The Consolidator finds these cross-connections by scanning recent facts, finding candidates via entity overlap + embedding similarity, and asking an LLM to identify relationships.

## What to Build

### 1. New file: `src/cortex/consolidator.ts`

```typescript
import type { DatabaseSync } from "node:sqlite";
import type { EmbedFunction } from "./tools.js";
import type { FactExtractorLLM } from "./gardener.js";
import { insertEdge, searchGraphFacts } from "./hippocampus.js";

export interface ConsolidationResult {
  factsScanned: number;
  edgesDiscovered: number;
  errors: string[];
}

/**
 * Find cross-connections between recent facts and existing facts.
 * 
 * @param db - bus.sqlite database
 * @param embedFn - embedding function for similarity search
 * @param llmFn - LLM function for relationship identification (same type as FactExtractorLLM)
 * @param since - ISO timestamp, only process facts created after this (default: 24h ago)
 * @param maxFacts - max recent facts to process per run (default: 50)
 */
export async function runConsolidation(params: {
  db: DatabaseSync;
  embedFn: EmbedFunction;
  llmFn: FactExtractorLLM;
  since?: string;
  maxFacts?: number;
}): Promise<ConsolidationResult>
```

**Implementation steps:**

1. **Get recent facts:**
```sql
SELECT id, fact_text, fact_type, source_type, created_at
FROM hippocampus_facts
WHERE created_at > ? AND status = 'active'
ORDER BY created_at DESC
LIMIT ?
```
Use `since` param (default: 24h ago). Use `maxFacts` param (default: 50).

2. **For each recent fact, find candidates:**
   - **Embedding similarity:** Call `searchGraphFacts(db, embedding, 5)` to find top-5 similar existing facts. Filter out:
     - The fact itself (same id)
     - Facts that already have an edge connecting them to this fact
   - Collect all unique candidates across all recent facts

3. **Batch LLM call for relationship discovery:**
   Group recent facts + their candidates and ask the LLM:
```
You are analyzing a knowledge graph for missing connections.

Recent facts:
${recentFacts.map(f => `[${f.id}] ${f.factText} (${f.factType}, from ${f.sourceType})`).join('\n')}

Existing related facts:
${candidates.map(f => `[${f.id}] ${f.factText}`).join('\n')}

Identify relationships between ANY of these facts (recent↔existing or recent↔recent).
Only output relationships you are confident about. Do not invent connections.

Valid edge types: because, informed_by, resulted_in, contradicts, updated_by, related_to

Output ONLY valid JSON:
{"edges": [{"from": "<fact_id>", "to": "<fact_id>", "type": "<edge_type>"}]}

If no relationships exist, output: {"edges": []}
```

   **Important:** Process in batches of 10 recent facts at a time to keep prompts manageable.

4. **Insert edges, skipping duplicates:**
   Before inserting each edge, check:
```sql
SELECT id FROM hippocampus_edges
WHERE (from_fact_id = ? AND to_fact_id = ? AND edge_type = ?)
   OR (from_fact_id = ? AND to_fact_id = ? AND edge_type = ?)
```
   (Check both directions for the same edge type to avoid A→B and B→A duplicates.)
   
   Only insert if no existing edge found. Set confidence to "medium" for consolidation-discovered edges.

5. **Return result** with counts.

### 2. Add helper: `getExistingEdgePairs()` in consolidator.ts

```typescript
function getExistingEdgePairs(db: DatabaseSync, factIds: string[]): Set<string>
```
Returns a Set of `"fromId|toId|type"` strings for all existing edges between the given fact IDs. Used for fast dedup checking.

### 3. Add consolidator to Gardener — `src/cortex/gardener.ts`

Add the consolidation run to the `startGardener` function. Add a new timer alongside the existing compactor/extractor/evictor:

```typescript
// In startGardener params:
consolidatorIntervalMs?: number;  // default: 24 * 60 * 60 * 1000 (daily)

// In startGardener body:
const runConsolidator = async () => {
  try {
    const { runConsolidation } = await import("./consolidator.js");
    const result = await runConsolidation({ db, embedFn, llmFn: extractLLM });
    console.log(`[gardener] Consolidator done: scanned=${result.factsScanned}, edges=${result.edgesDiscovered}`);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
};

timers.push(setInterval(runConsolidator, consolidatorIntervalMs));
```

Also add consolidation to the `runAll()` method:
```typescript
const { runConsolidation } = await import("./consolidator.js");
results.push({ 
  task: "consolidator", 
  ...await runConsolidation({ db, embedFn, llmFn: summarize })
});
```

Wait — `runAll()` returns `GardenerRunResult[]` which has `{ task, processed, errors }`. Make `ConsolidationResult` compatible: add a `task` field or map it when pushing.

Actually, just map it:
```typescript
const consResult = await runConsolidation({ db, embedFn, llmFn: summarize });
results.push({ task: "consolidator", processed: consResult.edgesDiscovered, errors: consResult.errors });
```

### 4. Export from index — `src/cortex/index.ts`

Add: `export { runConsolidation, type ConsolidationResult } from "./consolidator.js";`

## Files to Create/Modify
| File | Change |
|------|--------|
| `src/cortex/consolidator.ts` | **New** — consolidation logic |
| `src/cortex/gardener.ts` | Add consolidator timer to `startGardener` + `runAll` |
| `src/cortex/index.ts` | Export consolidator |

## Tests

Write tests in `src/cortex/__tests__/consolidator.test.ts`:

1. **Two unconnected facts about same topic → edge discovered** — insert two related facts (e.g. "Serj uses TypeScript" and "The project is built with TypeScript"), run consolidation with mock LLM that returns a `related_to` edge, verify edge created
2. **Cross-source edge** — insert one conversation fact and one article fact about same topic, run consolidation, verify edge links them
3. **Already-connected facts → no duplicate edges** — insert two facts with an existing edge, run consolidation, verify no new edge added
4. **Empty recent facts → no-op** — set `since` far in the future, verify result has factsScanned=0, edgesDiscovered=0, no errors
5. **LLM returns empty edges → no crash** — mock LLM returns `{"edges": []}`, verify clean result
6. **Malformed LLM output → graceful error** — mock LLM returns garbage, verify errors array populated but no crash

**Test helpers:**
- Use `initBus()` + `initSessionTables()` + `initHotMemoryTable()` for DB setup
- For embedding search tests, also call `initGraphVecTable(db)` (from hippocampus.ts)
- Mock `embedFn` with deterministic seed-based embeddings (see gardener.test.ts for pattern)
- Mock `llmFn` to return appropriate JSON strings
- Use `insertFact` and `insertEdge` from hippocampus.ts for test data setup

## Constraints
- Use dynamic `import()` for consolidator in gardener.ts (keeps it lazy-loaded)
- LLM prompt must include fact IDs so the response references actual UUIDs
- Batch size of 10 recent facts per LLM call to keep prompts under control
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 017g consolidator"`
