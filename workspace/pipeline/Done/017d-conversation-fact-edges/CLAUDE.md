# Claude Code Instructions — 017d

## Branch
`feat/017d-conversation-fact-edges`

## Context
The Fact Extractor in `src/cortex/gardener.ts` currently extracts flat string facts from conversation transcripts and inserts them into `cortex_hot_memory` (the old flat table). Task 017a added `hippocampus_facts` + `hippocampus_edges` tables with graph CRUD in `src/cortex/hippocampus.ts`.

This task rewires the Fact Extractor to:
1. Extract typed facts + relationships (not just flat strings)
2. Write to the graph tables (`hippocampus_facts` + `hippocampus_edges`) instead of `cortex_hot_memory`
3. Fix a vec table bug from 017a (embeddings were stored in `cortex_hot_memory_vec` instead of a dedicated graph vec table)

## What to Build

### 1. Create `hippocampus_facts_vec` table — in `hippocampus.ts`

Add a new function `initGraphVecTable(db)` (exported, async) that:
- Calls `loadSqliteVecExtension({ db })` (already imported at top of file)
- Creates: `CREATE VIRTUAL TABLE IF NOT EXISTS hippocampus_facts_vec USING vec0(embedding float[768])`

Call `initGraphVecTable` from the same place that `initColdStorage` is called (check `src/cortex/llm-caller.ts` for the startup sequence — look for `initColdStorage` calls and add `initGraphVecTable` next to them).

### 2. Fix `insertFact()` in `hippocampus.ts`

Change the embedding INSERT from:
```sql
INSERT INTO cortex_hot_memory_vec (rowid, embedding) ...
```
to:
```sql
INSERT INTO hippocampus_facts_vec (rowid, embedding) ...
```

### 3. Add `searchGraphFacts()` in `hippocampus.ts`

New exported function:
```typescript
export function searchGraphFacts(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit = 5,
): (GraphFact & { distance: number })[]
```
Queries `hippocampus_facts_vec` joined with `hippocampus_facts` (same pattern as `searchHotFacts` but using graph tables). Only return facts with `status = 'active'`.

### 4. Modify extraction prompt — in `gardener.ts`

Replace the `extractFactsFromTranscript()` function to return structured data instead of `string[]`.

**New return type:**
```typescript
interface ExtractedFact {
  id: string;     // temporary local id like "f1", "f2" — NOT a UUID
  text: string;
  type: "fact" | "decision" | "outcome" | "correction";
  confidence: "high" | "medium" | "low";
}

interface ExtractedEdge {
  from: string;  // references ExtractedFact.id (e.g. "f1")
  to: string;
  type: "because" | "informed_by" | "resulted_in" | "contradicts" | "updated_by" | "related_to";
}

interface ExtractionResult {
  facts: ExtractedFact[];
  edges: ExtractedEdge[];
}
```

**New prompt** (replace the existing prompt string inside `extractFactsFromTranscript`):
```
From this conversation, extract facts and relationships between them.
${topicContext}
CATEGORIES:
- fact: specific claims, preferences, personal details, configurations
- decision: explicit choices ("we decided...", "let's go with...")
- outcome: results of actions ("it worked", "it failed", "we learned...")
- correction: something was wrong ("actually...", "that was incorrect...")

RELATIONSHIPS between facts (only when clearly stated):
- because: A happened because of B
- informed_by: A was informed by B
- resulted_in: A led to B
- contradicts: A contradicts B
- updated_by: A supersedes/updates B
- related_to: A and B are about the same topic

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer.
- Prefer specific, verifiable facts useful weeks or months later.
- Skip: greetings, filler, routine acks, one-off results, task IDs, ephemeral status.
- Each fact must be a standalone statement.
- If no facts are found, return {"facts": [], "edges": []}.
- Assign confidence: high (explicitly stated), medium (clearly implied), low (loosely implied).

Return ONLY valid JSON:
{
  "facts": [{"id": "f1", "text": "...", "type": "fact", "confidence": "high"}, ...],
  "edges": [{"from": "f1", "to": "f2", "type": "because"}, ...]
}

Conversation:
${transcript}
```

**Change the function signature:**
```typescript
async function extractFactsFromTranscript(
  extractLLM: FactExtractorLLM,
  transcript: string,
  topicContext?: string,
): Promise<ExtractionResult>
```

**Parsing:** Try `JSON.parse(response)`. If that fails, try to extract `{...}` with regex. If still fails, return `{ facts: [], edges: [] }`. Validate that each fact has `id`, `text`, and `type`. Default confidence to "medium" if missing.

### 5. Rewrite `dedupAndInsertFact()` → `dedupAndInsertGraphFact()` in `gardener.ts`

New function that:
1. Exact match: `SELECT id FROM hippocampus_facts WHERE fact_text = ?`
2. If exact match, return the existing fact ID (no insert)
3. If no embedFn, insert via `insertFact()` (from hippocampus.ts) without embedding
4. Embed the fact text
5. Call `searchGraphFacts()` for top-1 nearest
6. If distance < DEDUP_SIMILARITY_THRESHOLD (0.55):
   - If new text is longer → update existing fact (use `db.prepare` to update fact_text + last_accessed_at, and update vec embedding)
   - Else skip — return existing fact ID
7. Otherwise, insert as new fact via `insertFact()`
8. Return the new fact's UUID (needed for edge insertion)

Signature:
```typescript
async function dedupAndInsertGraphFact(
  db: DatabaseSync,
  fact: ExtractedFact,
  sourceType: string,
  embedFn?: EmbedFunction,
): Promise<{ factId: string; inserted: boolean }>
```

### 6. Update `runFactExtractor()` in `gardener.ts`

In both the shard-aware and fallback code paths, after calling `extractFactsFromTranscript`:

```typescript
const extraction = await extractFactsFromTranscript(extractLLM, transcript, topicContext);

// Map local IDs to real UUIDs
const idMap = new Map<string, string>();

// Insert facts first
for (const fact of extraction.facts) {
  if (!fact.text?.trim()) continue;
  const { factId, inserted } = await dedupAndInsertGraphFact(db, fact, "conversation", embedFn);
  idMap.set(fact.id, factId);
  if (inserted) result.processed++;
}

// Insert edges (only where both endpoints resolved)
for (const edge of extraction.edges) {
  const fromId = idMap.get(edge.from);
  const toId = idMap.get(edge.to);
  if (fromId && toId && fromId !== toId) {
    insertEdge(db, { fromFactId: fromId, toFactId: toId, edgeType: edge.type });
  }
}
```

Import `insertEdge` and `searchGraphFacts` from `./hippocampus.js` at the top.

### 7. Keep backward compatibility

- Do NOT delete `dedupAndInsertFact()` — keep it for now (dead code, but safe)
- Do NOT remove any `cortex_hot_memory` writes from other call sites
- Do NOT modify `cortex_hot_memory` table or its CRUD functions

## Files to Modify
| File | Change |
|------|--------|
| `src/cortex/hippocampus.ts` | Add `initGraphVecTable()`, add `searchGraphFacts()`, fix `insertFact()` vec table |
| `src/cortex/gardener.ts` | New prompt, new `ExtractionResult` types, `dedupAndInsertGraphFact()`, update `runFactExtractor()` |
| `src/cortex/llm-caller.ts` | Call `initGraphVecTable()` alongside `initColdStorage()` at startup |

## Tests

Write tests in `src/cortex/__tests__/gardener-graph.test.ts`:

1. **`extractFactsFromTranscript` returns structured ExtractionResult** — mock LLM returns JSON with facts+edges, verify parsing
2. **`extractFactsFromTranscript` handles malformed LLM output** — returns empty result on garbage
3. **`dedupAndInsertGraphFact` inserts new fact into hippocampus_facts** — verify row exists
4. **`dedupAndInsertGraphFact` skips exact duplicate** — same text twice, only one row
5. **`dedupAndInsertGraphFact` replaces near-duplicate when new is longer** — verify updated text
6. **`runFactExtractor` creates facts AND edges in graph tables** — end-to-end with mock LLM returning facts+edges
7. **Edge insertion skips when endpoint missing** — edge referencing nonexistent local ID is silently skipped
8. **Fact types preserved** — decision, correction types stored correctly in hippocampus_facts.fact_type

**Test helpers:**
- Use `initBus()` + `initSessionTables()` + `initHotMemoryTable()` for DB setup (initHotMemoryTable calls initGraphTables internally)
- For vec table tests, call `initGraphVecTable(db)` in setup
- Mock `extractLLM` to return appropriate JSON strings
- Mock `embedFn` with deterministic seed-based embeddings (see existing gardener.test.ts for pattern)

## Important Notes
- The `loadSqliteVecExtension` is async and imported from `../memory/sqlite-vec.js`
- `initGraphVecTable` must be async (vec extension loading is async)
- The `ExtractionResult` types should be exported from gardener.ts (they'll be useful for 017e)
- When done, push branch, create PR, then run: `openclaw system event --text 'Done: 017d — conversation fact extraction with edges' --mode now`
