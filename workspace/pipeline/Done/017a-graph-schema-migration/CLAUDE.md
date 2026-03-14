# Claude Code Instructions — 017a

## Branch
`feat/017a-graph-schema-migration`

## What to Build

In `src/cortex/hippocampus.ts`, ADD the following (do NOT remove any existing code):

### 1. New table initialization function `initGraphTables(db)`

Create two tables:

```sql
CREATE TABLE IF NOT EXISTS hippocampus_facts (
  id               TEXT PRIMARY KEY,
  fact_text        TEXT NOT NULL,
  fact_type        TEXT DEFAULT 'fact',
  confidence       TEXT DEFAULT 'medium',
  status           TEXT DEFAULT 'active',
  source_type      TEXT,
  source_ref       TEXT,
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  cold_vector_id   INTEGER
);

CREATE TABLE IF NOT EXISTS hippocampus_edges (
  id             TEXT PRIMARY KEY,
  from_fact_id   TEXT NOT NULL,
  to_fact_id     TEXT NOT NULL,
  edge_type      TEXT NOT NULL,
  confidence     TEXT DEFAULT 'medium',
  is_stub        INTEGER DEFAULT 0,
  stub_topic     TEXT,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (from_fact_id) REFERENCES hippocampus_facts(id),
  FOREIGN KEY (to_fact_id) REFERENCES hippocampus_facts(id)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON hippocampus_edges(from_fact_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON hippocampus_edges(to_fact_id);
CREATE INDEX IF NOT EXISTS idx_facts_status ON hippocampus_facts(status);
CREATE INDEX IF NOT EXISTS idx_facts_hot ON hippocampus_facts(hit_count DESC, last_accessed_at DESC);
```

### 2. Migration function `migrateHotMemoryToGraph(db)`

- Check if `hippocampus_facts` already has rows — if yes, skip (idempotent)
- For each row in `cortex_hot_memory`:
  - Insert into `hippocampus_facts` with: same id, fact_text, created_at, last_accessed_at, hit_count, fact_type='fact', source_type='conversation', confidence='medium', status='active'

### 3. New CRUD functions (all exported)

```typescript
// Types
interface GraphFact {
  id: string;
  factText: string;
  factType: string;
  confidence: string;
  status: string;
  sourceType: string | null;
  sourceRef: string | null;
  createdAt: string;
  lastAccessedAt: string;
  hitCount: number;
}

interface GraphEdge {
  id: string;
  fromFactId: string;
  toFactId: string;
  edgeType: string;
  confidence: string;
  isStub: boolean;
  stubTopic: string | null;
}

interface GraphFactWithEdges extends GraphFact {
  edges: Array<{
    edgeId: string;
    edgeType: string;
    targetFactId: string;
    targetHint: string; // first 80 chars of connected fact, or stub_topic if stub
    isStub: boolean;
  }>;
}

// Functions
insertFact(db, opts: { factText, factType?, confidence?, sourceType?, sourceRef?, embedding? }) → string (fact ID)
insertEdge(db, opts: { fromFactId, toFactId, edgeType, confidence? }) → string (edge ID)
getFactWithEdges(db, factId) → GraphFactWithEdges | null
getTopFactsWithEdges(db, limit=30, maxEdgesPerFact=3) → GraphFactWithEdges[]
updateFactStatus(db, factId, status: 'active'|'superseded'|'evicted') → void
setEdgeStub(db, edgeId, stubTopic: string) → void
touchGraphFact(db, factId) → void  // update last_accessed_at, increment hit_count
```

For `insertFact` with embedding: insert into `cortex_hot_memory_vec` for dedup (reuse existing vec table).

For `getTopFactsWithEdges`: query hippocampus_facts ordered by hit_count DESC, last_accessed_at DESC, then for each fact query hippocampus_edges (both directions) limited to maxEdgesPerFact. Join to get target fact_text for the hint.

### 4. Call `initGraphTables` from existing `initHotMemoryTable`

Add `initGraphTables(db)` call at the end of `initHotMemoryTable(db)` so the new tables are created alongside the existing ones.

## Constraints
- Do NOT delete or modify any existing functions (insertHotFact, getTopHotFacts, etc.)
- Do NOT modify any other files (context.ts, tools.ts, etc.)
- All new functions must be exported
- Use `randomUUID()` for IDs (already imported in the file)
- Update STATE.md after each milestone

## Tests
Write tests in `src/cortex/__tests__/hippocampus-graph.test.ts`:
- `initGraphTables` creates both tables on empty DB
- `migrateHotMemoryToGraph` copies facts from cortex_hot_memory
- `migrateHotMemoryToGraph` is idempotent (no duplicates on second run)
- `insertFact` + `insertEdge` basic CRUD
- `getFactWithEdges` returns fact with its edges
- `getTopFactsWithEdges` ordered by hit_count, edges limited to maxEdgesPerFact
- `updateFactStatus` changes status
- `touchGraphFact` increments hit_count

When done, commit and run: `openclaw system event --text 'Done: 017a — graph schema + migration + CRUD' --mode now`
