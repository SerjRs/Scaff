# 017 — Implementation Tasks

> Each task is independently implementable, testable, and deployable.
> Order matters — dependencies are marked.

---

## Current State (what actually exists in code)

### Implemented (in `src/cortex/hippocampus.ts`):
- `cortex_hot_memory` table — flat facts (id, fact_text, created_at, last_accessed_at, hit_count)
- `cortex_hot_memory_vec` — sqlite-vec virtual table for dedup (cosine 0.85 threshold)
- `cortex_cold_memory` + `cortex_cold_memory_vec` — cold storage with vector search
- CRUD: `insertHotFact`, `getTopHotFacts`, `touchHotFact`, `getStaleHotFacts`, `deleteHotFact`
- Cold CRUD: `insertColdFact`, `searchColdFacts`
- Dedup: `searchHotFacts` (KNN), `updateHotFact` (replace similar facts)

### Implemented (in `src/cortex/context.ts`):
- `loadSystemFloor()` — injects hot facts as flat bullet list: `"- fact_text"`
- `assembleContext()` — calls `getTopHotFacts(db, 50)` and passes to `loadSystemFloor()`

### Implemented (in `src/cortex/tools.ts` + `loop.ts`):
- `memory_query` sync tool — embeds query, searches hot + cold via KNN
- `fetch_chat_history` sync tool — chronological SQL query on cortex_session

### Implemented (Library side):
- Library breadcrumbs injected into system prompt via `retrieval.ts` (titles + tags of top-10 similar items)
- Library tools: `library_get`, `library_search`, `library_stats`, `library_ingest`
- `library.sqlite` — separate database with items, embeddings, full_text

### Implemented (externally):
- `scaff-hot-memory` plugin — handles fact extraction via native hooks (not core code). Extracts facts from conversation, inserts into `cortex_hot_memory` with embedding dedup.

### NOT implemented (designed but not built):
- Gardener tasks (Fact Extractor, Vector Evictor, Channel Compactor) — no automated scheduling
- Any relationship/edge tracking between facts
- Cross-source connections (Library ↔ hot memory)
- Consolidation of any kind

---

## Task 017a: Graph Schema + Migration

> **Depends on:** nothing
> **Touches:** `src/cortex/hippocampus.ts`

### What to build

Add two new tables alongside the existing `cortex_hot_memory`:

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

### Migration

Write a migration function `migrateHotMemoryToGraph(db)`:
1. Create new tables (if not exist)
2. For each row in `cortex_hot_memory`:
   - Insert into `hippocampus_facts` with `fact_type='fact'`, `source_type='conversation'`, same timestamps and hit_count
3. Leave `cortex_hot_memory` intact (don't delete yet — backward compat)

### New CRUD functions

- `insertFact(db, { factText, factType, confidence, sourceType, sourceRef, embedding? })` → returns fact ID
- `insertEdge(db, { fromFactId, toFactId, edgeType, confidence? })` → returns edge ID
- `getFactWithEdges(db, factId)` → fact + immediate edges
- `getTopFactsWithEdges(db, limit, maxEdgesPerFact)` → for System Floor injection
- `updateFactStatus(db, factId, status)` → mark superseded/evicted
- `setEdgeStub(db, edgeId, stubTopic)` → convert edge to stub

### What NOT to change
- Do NOT delete `cortex_hot_memory` or its functions yet
- Do NOT change `context.ts` or `loadSystemFloor()` yet
- Do NOT change the hot-memory plugin behavior

### Tests
- Schema creation on empty DB
- Migration from `cortex_hot_memory` with sample data
- CRUD operations on facts + edges
- `getTopFactsWithEdges` returns facts ordered by hit_count with their edges

---

## Task 017b: System Floor Graph Injection

> **Depends on:** 017a
> **Touches:** `src/cortex/context.ts`, `src/cortex/hippocampus.ts`

### What to change

**In `context.ts` → `loadSystemFloor()`:**

Currently:
```typescript
if (hotFacts && hotFacts.length > 0) {
  const factsText = hotFacts.map((f) => `- ${f.factText}`).join("\n");
  sections.push(`## Known Facts\n${factsText}`);
}
```

Change to:
```typescript
if (graphFacts && graphFacts.length > 0) {
  const lines = graphFacts.map((f) => {
    const edgeHints = f.edges
      .map((e) => `→ ${e.edgeType}: ${e.targetHint}`)
      .join(" | ");
    return edgeHints
      ? `- ${f.factText} [${edgeHints}]`
      : `- ${f.factText}`;
  });
  sections.push(`## Knowledge Graph (Hot Memory)\n${lines.join("\n")}`);
}
```

**In `context.ts` → `assembleContext()`:**

Currently:
```typescript
const { getTopHotFacts } = await import("./hippocampus.js");
hotFacts = getTopHotFacts(db, 50);
```

Change to:
```typescript
const { getTopFactsWithEdges } = await import("./hippocampus.js");
const graphFacts = getTopFactsWithEdges(db, 30, 3); // 30 facts, max 3 edges each
```

### What to delete
- Remove the `hotFacts` parameter from `loadSystemFloor()` signature
- Remove the flat fact injection code
- Remove the `HotFact` import (replace with new type)

### What NOT to change
- Do NOT change Library breadcrumb injection yet (that's 017f)
- Do NOT change `memory_query` tool yet

### Tests
- `loadSystemFloor` with graph facts produces edge-annotated output
- Token budget stays under 15-20% of max context
- Empty graph produces no "Knowledge Graph" section

---

## Task 017c: graph_traverse Sync Tool

> **Depends on:** 017a
> **Touches:** `src/cortex/hippocampus.ts`, `src/cortex/tools.ts`, `src/cortex/llm-caller.ts`, `src/cortex/loop.ts`

### What to build

New sync tool: `graph_traverse`

**Tool definition (tools.ts):**
```typescript
export const GRAPH_TRAVERSE_TOOL = {
  name: "graph_traverse",
  description: "Walk the knowledge graph from a fact node. Returns connected facts and their relationships up to N hops deep. Use when a hot memory breadcrumb shows a connection you want to explore.",
  parameters: {
    type: "object",
    properties: {
      fact_id: { type: "string", description: "Starting fact ID (from hot memory breadcrumbs)" },
      depth: { type: "number", description: "How many hops to traverse (default 2, max 4)" },
      direction: { type: "string", enum: ["outgoing", "incoming", "both"], description: "Edge direction (default: both)" },
    },
    required: ["fact_id"],
  },
};
```

**Executor (hippocampus.ts):**

New function `traverseGraph(db, factId, depth, direction)`:
- Uses recursive CTE to walk edges
- Returns structured subgraph as readable text
- Includes stub indicators for evicted facts
- Caps at 50 nodes to prevent context explosion

**Registration:**
- Add to `SYNC_TOOL_NAMES` set in tools.ts
- Add to `FILE_IO_TOOLS` array in llm-caller.ts
- Add execution handler in loop.ts sync tool switch
- Add to system prompt tool guidance

### What NOT to change
- Do NOT modify `memory_query` — it stays as semantic search
- Do NOT modify `fetch_chat_history` — it stays as chronological replay

### Tests
- Traverse 1-hop returns immediate edges
- Traverse 2-hop returns edges of edges
- Direction filtering works (outgoing only, incoming only)
- Stub facts show as "[evicted]" with topic hint
- Depth cap at 4 is enforced
- Node cap at 50 is enforced

---

## Task 017d: Conversation Fact Extraction with Edges

> **Depends on:** 017a
> **Touches:** the `scaff-hot-memory` plugin (external) OR new extraction code

### Current state
The `scaff-hot-memory` plugin handles fact extraction externally — it hooks into the gateway, reads conversation turns, extracts flat facts via LLM, and inserts into `cortex_hot_memory` with embedding-based dedup.

### What to change

**Option A (preferred): Modify the plugin to output edges**

The plugin already extracts facts. Extend the extraction prompt to also output relationships:
- Input: conversation segment
- Output: `{ facts: [{id, text, type, confidence}], edges: [{from, to, type}] }`
- Write facts to `hippocampus_facts` instead of `cortex_hot_memory`
- Write edges to `hippocampus_edges`
- Keep the embedding dedup logic (cosine 0.85) but apply it to `hippocampus_facts`

**Option B (fallback): New extraction function in hippocampus.ts**

If modifying the plugin is too complex, add a new function `extractFactsAndEdges(db, conversationSegment, embedFn)` that:
1. Calls Ollama llama3.2:3b with the extraction prompt
2. Parses the JSON output
3. Inserts facts + edges into the new tables
4. Handles dedup against existing facts

### Extraction prompt (for either option):

```
From this conversation, extract:
1. Facts: specific claims, observations (not greetings or filler)
2. Decisions: explicit choices ("we decided...", "let's go with...")
3. Outcomes: results ("it worked", "it failed", "we learned...")
4. Corrections: things that were wrong ("actually...", "that was incorrect...")

For each, identify relationships to OTHER extracted facts:
- because: A happened because of B
- informed_by: A was informed by B
- contradicts: A contradicts B
- updated_by: A is superseded by B
- resulted_in: A led to B

Output JSON:
{
  "facts": [{ "id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low" }],
  "edges": [{ "from": "f1", "to": "f2", "type": "because" }]
}
Only extract facts you're confident about. Do not invent.
```

### What to delete
- After migration is verified: remove writes to `cortex_hot_memory` from the plugin
- The `cortex_hot_memory` table stays readable (for backward compat with any code still reading it) but no longer receives new writes

### Tests
- Extract from sample conversation → verify facts + edges produced
- Dedup: similar fact produces update, not duplicate
- Decision and correction types are correctly tagged

---

## Task 017e: Article Ingestion → Graph

> **Depends on:** 017a, 017d (same extraction format)
> **Touches:** `src/library/librarian-prompt.ts`, `src/cortex/gateway-bridge.ts`

### What to change

**In `librarian-prompt.ts`:**

Extend the Librarian executor output schema to include facts + edges:

```
In addition to title, summary, tags, key_concepts, and full_text, extract factual claims:

"facts": [
  { "id": "f1", "text": "O-RAN reduces TCO by 30%", "type": "fact", "confidence": "high" }
],
"edges": [
  { "from": "f1", "to": "f2", "type": "because" }
]
```

**In `gateway-bridge.ts` → Library task handler (~line 349):**

After storing the item in `library.sqlite` (existing code), also:
1. Parse `parsed.facts` and `parsed.edges`
2. Insert each fact into `hippocampus_facts` with `source_type='article'`, `source_ref='library://item/{itemId}'`
3. Insert each edge into `hippocampus_edges`
4. Add a `sourced_from` edge from each fact to a synthetic "article node":
   - Article node: `{ fact_type: 'source', fact_text: 'Article: {title}', source_ref: 'library://item/{itemId}' }`

### What NOT to change
- Library `insertItem()` still stores raw content in `library.sqlite`
- Library breadcrumbs still work (removed in 017f, not here)
- If the Librarian executor doesn't return facts/edges (old prompt), gracefully skip graph insertion

### Tests
- Ingest article with facts → verify facts + edges in hippocampus tables
- Verify `sourced_from` edge links fact to article node
- Verify article node has `source_ref = 'library://item/{id}'`
- Graceful fallback when executor output lacks facts/edges

---

## Task 017f: Replace Library Breadcrumbs with Graph Breadcrumbs

> **Depends on:** 017b (graph injection working), 017e (articles in graph)
> **Touches:** `src/cortex/llm-caller.ts`, `src/cortex/context.ts`

### What to change

**In `llm-caller.ts` → system prompt:**

Remove the Library breadcrumbs injection. Currently, `contextToMessages()` injects Library item titles + tags into the system prompt. Replace with a note:

```
Library items are indexed in the Knowledge Graph. Use graph_traverse or memory_query to explore domain knowledge. Use library_get(id) to read the full article when you need the source text.
```

**In `context.ts` → `assembleContext()`:**

Remove the call to Library retrieval for breadcrumbs. The hot memory graph (from 017b) now surfaces article-derived facts as breadcrumbs — they have `sourced_from: library://item/N` edges that point to the full article.

### What to delete
- Library breadcrumb injection code in `llm-caller.ts` (the system prompt section that injects titles + tags)
- Library retrieval call in `assembleContext()` (if it exists there)
- The `library_search` tool stays (Cortex can still explicitly search Library)
- The `library_get` tool stays (Cortex can still pull full article text)
- The `library_stats` tool stays
- `library_ingest` stays (it now feeds the graph via 017e)

### What NOT to delete
- `library.sqlite` — stays as content store
- Library embedding infrastructure — stays (used by `library_search`)
- Library tools — all stay, just the automatic breadcrumb injection goes away

### Tests
- System prompt no longer contains Library breadcrumb section
- Article-derived facts appear in hot memory graph with `sourced_from` edges
- `library_get(id)` still works for pulling full text
- `library_search(query)` still works for explicit search

---

## Task 017g: Consolidator (Gardener Task)

> **Depends on:** 017a, 017d, 017e (facts from both sources exist in graph)
> **Touches:** new file `src/cortex/consolidator.ts`, cron configuration

### What to build

New module: `consolidator.ts`

Function `runConsolidation(db, embedFn, llmFn)`:

1. **Find recent facts** — facts created since last consolidation run:
   ```sql
   SELECT * FROM hippocampus_facts
   WHERE created_at > ? AND status = 'active'
   ```

2. **Find candidate connections** — for each recent fact:
   - A. Entity overlap: extract key terms from fact_text, find existing facts containing same terms
   - B. Embedding similarity: embed the fact, find top-5 similar existing facts via `cortex_hot_memory_vec`

3. **Ask LLM for relationships** — batch recent facts + candidates:
   ```
   Given these new facts: [...]
   And these existing facts: [...]
   Identify relationships. Output: { edges: [{ from, to, type, confidence }] }
   Only output relationships you're confident about.
   ```

4. **Insert discovered edges** into `hippocampus_edges`

5. **Log** the run: timestamp, facts scanned, edges discovered

### Scheduling

Register as a cron job or Gardener task:
- Frequency: daily (configurable)
- Trigger: also runs after article ingestion completes
- Model: Ollama llama3.2:3b (free, local)

### Tests
- Two unconnected facts about the same topic → consolidation finds the edge
- Facts from different sources (conversation + article) → cross-source edge discovered
- Already-connected facts → no duplicate edges created

---

## Task 017h: Eviction with Edge Stubs + Revival

> **Depends on:** 017a, 017b (graph injection must handle stubs)
> **Touches:** `src/cortex/hippocampus.ts`, `src/cortex/tools.ts` (memory_query enhancement)

### What to change

**New function `evictFact(db, factId, embedding)`:**

1. Insert into `cortex_cold_memory` + `cortex_cold_memory_vec` (existing cold storage)
2. Set `hippocampus_facts.status = 'evicted'`, store `cold_vector_id`
3. For each edge touching this fact:
   - Set `is_stub = 1`
   - Set `stub_topic` = first 50 chars of fact_text

**New function `reviveFact(db, factId)`:**

1. Set `hippocampus_facts.status = 'active'`
2. Reset `hit_count = 1`, `last_accessed_at = now`
3. Clear `cold_vector_id`
4. For each stub edge touching this fact:
   - Set `is_stub = 0`, clear `stub_topic`

**Enhance `memory_query` tool:**

Currently searches cold + hot memory. Add:
- After finding a cold storage hit → call `reviveFact()` automatically
- Return the revived fact + its reconnected edges in the response

**New function `pruneOldStubs(db, olderThanDays=90)`:**

Delete edge stubs where BOTH endpoints are evicted and the stub is older than threshold.

**Automated eviction (Gardener weekly task):**

```typescript
function runEviction(db, embedFn) {
  const stale = getStaleGraphFacts(db, 14, 3); // >14 days old, <3 hits
  for (const fact of stale) {
    const embedding = await embedFn(fact.factText);
    evictFact(db, fact.id, embedding);
  }
  pruneOldStubs(db, 90);
}
```

### What to delete
- Remove `getStaleHotFacts` from old code (replaced by graph-aware version)
- Remove old eviction functions that operated on `cortex_hot_memory` directly

### What NOT to change
- Cold storage schema stays the same (`cortex_cold_memory` + vec)
- `searchColdFacts` stays the same

### Tests
- Evict a fact → edges become stubs with topic hints
- System Floor injection shows stubs as `[evicted: topic hint]`
- `memory_query` hit on evicted fact → fact revived, edges reconnected
- Stub pruning removes old stubs where both endpoints evicted
- Evicted facts don't appear in `getTopFactsWithEdges`

---

## Task 017i: Migration Script — Existing Library Items → Graph

> **Depends on:** 017a, 017e (article ingestion pipeline exists)
> **Touches:** new script `scripts/library-to-graph.mjs`

### What to build

One-time migration script that processes all 21 existing Library items:

1. For each active item in `library.sqlite`:
   - Read title, summary, key_concepts, tags
   - Call Ollama (or Sonnet for better quality) with the extraction prompt from 017e
   - Insert extracted facts into `hippocampus_facts` with `source_type='article'`, `source_ref='library://item/{id}'`
   - Insert edges into `hippocampus_edges`
   - Create article source node + `sourced_from` edges

2. After all items processed:
   - Run the Consolidator (017g) to find cross-article connections
   - Log summary: items processed, facts extracted, edges created

### Constraints
- Idempotent: safe to run multiple times (check for existing `source_ref` before inserting)
- Timeout: 30s per item for LLM extraction
- Batch: process sequentially (don't overload Ollama)

### This is the last task — run it after everything else is deployed.

---

## Execution Order

```
017a (schema + migration)           ← foundation, no deps
  ├── 017b (System Floor injection) ← needs 017a
  ├── 017c (graph_traverse tool)    ← needs 017a
  ├── 017d (conversation extraction)← needs 017a
  │     └── 017e (article ingestion)← needs 017a, 017d (same format)
  │           └── 017f (replace Library breadcrumbs) ← needs 017b, 017e
  ├── 017g (consolidator)           ← needs 017a, 017d, 017e
  └── 017h (eviction + revival)     ← needs 017a, 017b
        └── 017i (migration script) ← needs all of the above, runs last
```

Parallelizable: 017b, 017c, 017d can run simultaneously after 017a.
Sequential: 017e after 017d, 017f after 017b+017e, 017g after 017d+017e, 017i last.

---

## What Gets Deleted (summary across all tasks)

| What | When | Replaced by |
|------|------|-------------|
| Flat fact injection in `loadSystemFloor()` | 017b | Graph breadcrumb injection |
| Library breadcrumbs in system prompt | 017f | Hot memory graph (article facts have `sourced_from` edges) |
| Writes to `cortex_hot_memory` (from plugin) | 017d | Writes to `hippocampus_facts` + `hippocampus_edges` |
| Old eviction functions on `cortex_hot_memory` | 017h | Graph-aware eviction with edge stubs |

| What | When | NOT deleted, reason |
|------|------|---------------------|
| `cortex_hot_memory` table | Keep indefinitely | Backward compat, other code may read it |
| `library.sqlite` | Never | Content store — raw text, URLs, full_text |
| Library tools (get, search, stats, ingest) | Never | Still useful for content access |
| Cold storage tables | Never | Used by graph eviction |
