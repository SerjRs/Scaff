# Three-Tier Knowledge Architecture

*Version: 1.0 — 2026-03-20*
*Status: Approved*
*Authors: Serj + Scaff (spec), Super Architect (synthesis)*
*Supersedes: SPEC.md (which remains as historical reference)*

---

## 1. Philosophy

**P1: One graph, two lenses.** All knowledge lives in a single graph (`kg_facts` + `kg_edges`) from the moment it's created. "Working memory" is a time-windowed view (breadcrumbs) into this graph — not a separate store. Facts never move, never copy, never delete. Breadcrumbs expire; facts persist forever.

**P2: Fixed-cost attention.** The LLM sees ≤2,000 tokens of active memory per turn, regardless of whether the graph has 500 or 50,000 facts. This budget is split: ~1,200 tokens for breadcrumbs (recent 96h), ~500 tokens for top-ranked long-term facts, ~300 tokens for Library breadcrumbs. The rest of knowledge is pull-on-demand via tools.

**P3: Gravity, not garbage collection.** Facts gain relevance through use (pop) and lose it through neglect (sink). Nothing is ever deleted. Shallow search surfaces high-gravity facts; deep search walks the graph regardless of gravity. The system gets smarter over time because the graph grows and edges compound.

---

## 2. The Three Tiers

```
┌─────────────────────────────────────────────────────┐
│  TIER 1 — Breadcrumbs (Working Memory Window)       │
│  Time-windowed pointers into Tier 2. ≤96h. ~1200t.  │
├─────────────────────────────────────────────────────┤
│  TIER 2 — Knowledge Graph (All Facts + Edges)       │
│  Permanent. Pop/sink ranked. Vector + graph search.  │
├─────────────────────────────────────────────────────┤
│  TIER 3 — Sources (Provenance)                      │
│  URIs to raw content. Never searched directly.       │
└─────────────────────────────────────────────────────┘
```

**Tier 1** is a view, not a store. A breadcrumb is a row in `kg_breadcrumbs` that points to a `kg_facts` row. It has a 96h TTL. When it expires, the breadcrumb row is deleted — the fact stays in Tier 2 forever.

**Tier 2** is the unified knowledge graph. Every fact from every source (conversations, articles, audio, files, tasks) lives here with typed edges connecting them. Vector embeddings enable semantic search. A `relevance_score` determines search ranking.

**Tier 3** is the evidence layer. Every Tier 2 fact has a `source_ref` URI pointing to the raw material it was extracted from. The LLM follows these links when asked "where did you learn that?"

---

## 3. Data Model

All tables live in `cortex/bus.sqlite` (existing database). Rationale: atomic transactions when creating facts + edges + breadcrumbs + sources in one write. Backup is already handled. A separate DB would add connection management complexity for minimal benefit.

### 3.1 kg_facts (Tier 2 — evolves `hippocampus_facts`)

```sql
CREATE TABLE kg_facts (
  id               TEXT PRIMARY KEY,
  fact_text        TEXT NOT NULL,
  fact_type        TEXT DEFAULT 'fact',     -- fact, decision, event, concept, preference
  confidence       TEXT DEFAULT 'medium',   -- high, medium, low
  status           TEXT DEFAULT 'active',   -- active, disputed, superseded
  source_type      TEXT,                    -- conversation, article, audio, file, task, system
  source_ref       TEXT,                    -- URI → kg_sources.uri
  relevance_score  REAL DEFAULT 5.0,       -- pop/sink score (see §8)
  hit_count        INTEGER DEFAULT 0,
  edge_count       INTEGER DEFAULT 0,      -- denormalized for fast ranking
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

CREATE INDEX idx_kg_relevance ON kg_facts(relevance_score DESC);
CREATE INDEX idx_kg_status ON kg_facts(status);
CREATE INDEX idx_kg_source_ref ON kg_facts(source_ref);
CREATE INDEX idx_kg_created ON kg_facts(created_at DESC);
```

**Changes from `hippocampus_facts`:** Added `relevance_score` (REAL), `edge_count` (INTEGER). Removed `cold_vector_id` (no more hot/cold split). Status values changed: `evicted` → removed (facts are never evicted, they just sink).

### 3.2 kg_edges (Tier 2 — evolves `hippocampus_edges`)

```sql
CREATE TABLE kg_edges (
  id             TEXT PRIMARY KEY,
  from_fact_id   TEXT NOT NULL REFERENCES kg_facts(id),
  to_fact_id     TEXT NOT NULL REFERENCES kg_facts(id),
  edge_type      TEXT NOT NULL,            -- related_to, caused_by, sourced_from,
                                           -- contradicts, supersedes, resulted_in,
                                           -- informed_by, part_of
  confidence     TEXT DEFAULT 'medium',
  weight         REAL DEFAULT 1.0,         -- edge strength for traversal ranking
  created_at     TEXT NOT NULL,
  created_by     TEXT DEFAULT 'extractor'  -- extractor, synthesizer, librarian, user
);

CREATE INDEX idx_kg_edges_from ON kg_edges(from_fact_id);
CREATE INDEX idx_kg_edges_to ON kg_edges(to_fact_id);
```

**Changes from `hippocampus_edges`:** Added `weight` (REAL), `created_by` (TEXT). Removed `is_stub` and `stub_topic` (no more eviction, so no stubs needed).

### 3.3 kg_facts_vec (Tier 2 — evolves `hippocampus_facts_vec`)

```sql
CREATE VIRTUAL TABLE kg_facts_vec USING vec0(
  embedding float[768]
);
```

Rowids match `kg_facts` rowids. Embeddings generated by Ollama `nomic-embed-text` (local, free).

### 3.4 kg_breadcrumbs (Tier 1 — new, replaces `cortex_hot_memory`)

```sql
CREATE TABLE kg_breadcrumbs (
  id             TEXT PRIMARY KEY,
  kg_fact_id     TEXT NOT NULL REFERENCES kg_facts(id),
  summary_text   TEXT NOT NULL,            -- short text for injection (~50 tokens max)
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,            -- created_at + 96h
  refreshed_at   TEXT                      -- reset on reference, extends visibility
);

CREATE INDEX idx_bc_expires ON kg_breadcrumbs(expires_at);
CREATE INDEX idx_bc_created ON kg_breadcrumbs(created_at DESC);
CREATE INDEX idx_bc_fact ON kg_breadcrumbs(kg_fact_id);
```

**Design decision:** No `source_type` column on breadcrumbs. The fact's `source_type` is available via the join. Breadcrumbs are intentionally minimal.

**Size control:** Max 30 active breadcrumbs. If inserting a new breadcrumb would exceed 30, the oldest (by `refreshed_at ?? created_at`) is deleted. This is a hard cap independent of the 96h TTL.

### 3.5 kg_sources (Tier 3 — new)

```sql
CREATE TABLE kg_sources (
  id           TEXT PRIMARY KEY,
  uri          TEXT NOT NULL UNIQUE,
  source_type  TEXT NOT NULL,             -- url, library_item, audio_transcript,
                                          -- conversation_shard, file, task_result
  title        TEXT,
  metadata     TEXT,                      -- JSON blob
  content_hash TEXT,                      -- SHA-256 for dedup
  created_at   TEXT NOT NULL,
  status       TEXT DEFAULT 'active'      -- active, dead, archived
);

CREATE INDEX idx_sources_uri ON kg_sources(uri);
CREATE INDEX idx_sources_type ON kg_sources(source_type);
```

**URI scheme:**
```
url://https://example.com/article
library://item/46
audio://b55b299d-9c9b-4d54-...
shard://agent:main:cortex/4872
file://workspace/docs/cortex-architecture.md
task://c0857f28-1d5e-4578-...
```

**Resolution:** Each scheme has a resolver function that fetches raw content:
- `url://` → `web_fetch` or cached in Library
- `library://` → query `library.sqlite` items table
- `audio://` → read `workspace/data/audio/transcripts/{id}.json`
- `shard://` → query `cortex_session` filtered by shard_id
- `file://` → read from disk
- `task://` → query `cortex_task_dispatch` for result

### 3.6 Tables Removed

| Table | Replacement |
|-------|-------------|
| `cortex_hot_memory` | `kg_breadcrumbs` (view) + `kg_facts` (store) |
| `cortex_hot_memory_vec` | `kg_facts_vec` (unified) |
| `cortex_cold_memory` | Eliminated — facts stay in `kg_facts`, sink via `relevance_score` |
| `cortex_cold_memory_vec` | Eliminated — merged into `kg_facts_vec` |

---

## 4. Write Path

Every piece of information that enters the system follows one path: **extract → insert into `kg_facts` → create edges → create breadcrumb → register source.**

### 4.1 From Conversations (Gardener Fact Extractor)

```
Gardener scans closed shards (every 6h, or on shard close)
  → LLM (Haiku) extracts facts + edges from shard messages
  → For each fact:
      INSERT INTO kg_facts (permanent)
      INSERT embedding INTO kg_facts_vec
      INSERT INTO kg_breadcrumbs (96h TTL)
      Synthesizer runs on new fact (§7)
  → Register shard as source:
      INSERT INTO kg_sources (uri = shard://...)
  → Link facts to source:
      kg_facts.source_ref = shard://...
```

**No change to extraction logic.** The Gardener's `ExtractionResult` type (facts + edges) maps directly. The only change: facts go to `kg_facts` instead of `cortex_hot_memory`, and breadcrumbs are created alongside.

### 4.2 From Library Articles (Librarian → Gateway Bridge)

```
User drops link → Cortex spawns Librarian executor
  → Librarian returns JSON: title, summary, key_concepts, tags
  → Gateway bridge:
      1. Writes to library.sqlite (unchanged)
      2. For each key_concept:
           INSERT INTO kg_facts (source_type = 'article', source_ref = library://item/{id})
           INSERT embedding INTO kg_facts_vec
           INSERT INTO kg_breadcrumbs
      3. INSERT INTO kg_sources (uri = library://item/{id})
      4. Synthesizer runs on new facts
```

**Library DB stays separate.** It's a Tier 3 source store — rich structured content (full_text, tags, summaries). The KG stores extracted atomic facts with links back to the Library item.

### 4.3 From Audio Transcripts

```
Audio pipeline: chunks → Whisper → transcript
  → Librarian processes transcript (existing path)
  → Same as §4.2, but source_ref = audio://{session-id}
  → INSERT INTO kg_sources (uri = audio://..., metadata = {duration, speakers, ...})
```

### 4.4 From Files

```
Cortex reads a workspace file (via read_file tool)
  → If file contains extractable knowledge (architecture docs, specs):
      Gardener extracts facts on next sweep
      source_ref = file://path/to/file
      INSERT INTO kg_sources (uri = file://...)
```

File-sourced facts are lower priority — only extracted when the Gardener specifically processes workspace files (deferred to Phase 5).

### 4.5 From Task Results

```
Router executor completes a task
  → Result arrives via gateway-bridge
  → Fact Extractor processes result text
  → source_ref = task://{task-id}
  → INSERT INTO kg_sources (uri = task://...)
```

---

## 5. Active Memory Injection

### 5.1 What the LLM Sees Every Turn

```
## Working Memory (last 96h)
- Fixed 3 audio pipeline bugs: channel null, status ordering, error propagation [→ kg:audio-pipeline]
- Serj tested live audio capture at 3:01 PM — full E2E verified [→ kg:audio-test-0319]
- All test rewrite tasks complete (030-043), 114 tests passing [→ kg:test-rewrite]
- Three-tier knowledge architecture spec drafted [→ kg:045-spec]
... (up to 20 breadcrumbs, ~1200 tokens)

## Long-Term Knowledge (top ranked)
- Budget is 2.4M EUR [→ kg:project-budget]
- Nokia contract renewal Q3 2026 [→ kg:nokia-contract]
- O-RAN reduces TCO by 30% for rural sites [→ kg:oran-tco]
... (up to 10 facts, ~500 tokens)

## Library (relevant items — use knowledge_search for more)
  [id:7]  "Ericsson O-RAN Rural Deployment" — o-ran, rural, tco
  [id:12] "3GPP Release 18 Spectrum Sharing" — spectrum, 3gpp
  [id:23] "Internal: North Region Site Plan" — north, planning
... (up to 6 items, ~300 tokens)
```

**Total: ≤2,000 tokens.** Fixed regardless of graph size.

### 5.2 Assembly Algorithm (modifies `loadSystemFloor` in `context.ts`)

```typescript
// 1. Breadcrumbs: active, not expired, sorted by refreshed_at DESC
const breadcrumbs = db.prepare(`
  SELECT b.summary_text, b.kg_fact_id
  FROM kg_breadcrumbs b
  WHERE b.expires_at > datetime('now')
  ORDER BY COALESCE(b.refreshed_at, b.created_at) DESC
  LIMIT 20
`).all();

// 2. Top-ranked long-term facts (not already in breadcrumbs)
const breadcrumbFactIds = new Set(breadcrumbs.map(b => b.kg_fact_id));
const topFacts = db.prepare(`
  SELECT id, fact_text
  FROM kg_facts
  WHERE status = 'active' AND id NOT IN (${placeholders})
  ORDER BY relevance_score DESC
  LIMIT 10
`).all();

// 3. Library breadcrumbs (existing path, unchanged)
const libraryBreadcrumbs = queryLibraryBreadcrumbs(userMessage, 6);
```
**Critical Rule: Passive Injection is Read-Only.** The `loadSystemFloor` execution must be purely `SELECT` statements. Simply appearing in the LLM's context window (whether as a Tier 1 breadcrumb or a top Tier 2 fact) **DOES NOT** increment `hit_count` or update `last_accessed_at`. This prevents a "rich get richer" feedback loop where top facts permanently lock up the context window just by being visible.

### 5.3 Breadcrumb Refresh

When the LLM references a fact (via search results, graph traversal, or inline reference), the corresponding breadcrumb's `refreshed_at` is updated and `expires_at` is extended by 96h. If no breadcrumb exists for that fact, one is created (the fact "pops" back into working memory).

```sql
-- Refresh existing breadcrumb
UPDATE kg_breadcrumbs
SET refreshed_at = datetime('now'), expires_at = datetime('now', '+96 hours')
WHERE kg_fact_id = ?;

-- Or create new breadcrumb if fact was accessed via search
INSERT INTO kg_breadcrumbs (id, kg_fact_id, summary_text, created_at, expires_at)
VALUES (?, ?, ?, datetime('now'), datetime('now', '+96 hours'));
```

---

## 6. Read Path / Tools

Three tools replace the current fragmented set.

### 6.1 `knowledge_search` (replaces `memory_query` + `library_search`)

```
knowledge_search(query: string, limit?: number = 10)
```

1. Embed query via Ollama nomic-embed-text
2. Vector KNN on `kg_facts_vec` → candidate fact rowids
3. Join with `kg_facts` WHERE status = 'active'
4. Rank by: `(1 - vec_distance) * 0.6 + (relevance_score / max_score) * 0.4`
5. Return top-N: `{ fact_text, fact_type, source_ref, edge_hints[], relevance_score }`
6. Side effects: bump `hit_count`, update `last_accessed_at`, refresh/create breadcrumbs

**Sunk facts** (low `relevance_score`) naturally fall below the ranking cutoff. They exist but don't surface in shallow search.

### 6.2 `knowledge_deep_search` (replaces `graph_traverse`)

```
knowledge_deep_search(query_or_fact_ids: string | string[], depth?: number = 3, max_nodes?: number = 50)
```

1. If string query: run `knowledge_search` (limit=5) to get seed fact IDs
2. Recursive CTE from seeds, following all edges up to `depth` hops
3. Return subgraph: facts + edges + source_refs
4. **No relevance filtering** — walks the full graph including sunk facts
5. Side effects: bump `hit_count` on all traversed facts

This is the "dig into the archives" tool. Expensive but thorough. The existing `traverseGraph()` function in `hippocampus.ts` maps directly — just rename the entry point.

### 6.3 `knowledge_source` (new)

```
knowledge_source(fact_id_or_uri: string)
```

1. If fact_id: look up `kg_facts.source_ref` to get URI
2. Look up URI in `kg_sources` for metadata
3. Resolve URI via the appropriate resolver (§3.5)
4. Return: raw content (transcript text, article summary, shard messages, file content) + source metadata

This is the "show me where you learned that" tool.

### 6.4 Backward Compatibility

| Old Tool | New Tool | Migration |
|----------|----------|-----------|
| `memory_query` | `knowledge_search` | Same semantics, broader scope |
| `library_search` | `knowledge_search` | Article facts now in KG |
| `library_get` | `knowledge_source` + `library_get` | Keep `library_get` for full article content |
| `graph_traverse` | `knowledge_deep_search` | Same graph walk, better entry point |
| `fetch_chat_history` | Unchanged | Still needed for verbatim shard retrieval |

**`library_get` is kept.** It returns full Library article content (summary, key_concepts, tags). `knowledge_source` returns the raw provenance. Different use cases.

---

## 7. Synthesizer

The Synthesizer creates cross-source edges. It runs after every fact insertion.

### 7.1 Algorithm

```
For each new fact F:
  1. Vector KNN search against kg_facts_vec (top 10, exclude F)
  2. For each candidate C where distance < 0.35 (high similarity):
     → Create edge: F --related_to--> C (confidence: high, weight: 1-distance)
     → No LLM call needed — vector proximity is sufficient for "related_to"
  3. For each candidate C where 0.35 ≤ distance < 0.55 (moderate similarity):
     → Haiku classification call:
       "Given fact A: '{F.fact_text}' and fact B: '{C.fact_text}',
        what is their relationship? Options: related_to, contradicts,
        supersedes, caused_by, part_of, none"
     → If not "none": create typed edge with Haiku's classification
  4. Candidates with distance ≥ 0.55: skip (too dissimilar)
  5. Update edge_count on all affected facts
```

### 7.2 Cost Analysis

- **Vector search:** Free (local Ollama + sqlite-vec)
- **High-similarity edges (distance < 0.35):** Free (no LLM call)
- **Moderate-similarity edges:** ~$0.001 per Haiku call. With 5 facts per shard extraction and ~2 moderate-similarity candidates per fact: ~$0.01 per extraction run. At 4 extraction runs/day: **~$0.04/day**.
- **Daily catch-up synthesis:** Not needed. Synthesis runs inline on every fact insertion. A weekly audit can scan for orphan facts (zero edges) and retry synthesis.

### 7.3 When It Runs

- **Inline:** After every `INSERT INTO kg_facts` (conversation extraction, article ingestion, audio ingestion)
- **Weekly audit:** Gardener scans for facts with `edge_count = 0` and `created_at > 7 days ago`, retries synthesis. Catches facts that were inserted when Ollama was down or when the embedding was temporarily unavailable.

**Decision: No separate Consolidation Agent.** The Always-On Memory Agent (ref [5]) uses a separate consolidation agent running on a timer. We don't need this — our Synthesizer runs inline and the Gardener covers catch-up. Adding a timer-based consolidator would add latency to ingestion without meaningful benefit for our scale (hundreds of facts, not millions).

---

## 8. Pop/Sink Algorithm

### 8.1 Formula

```
relevance_score = base_score + recency_bonus + edge_bonus

where:
  base_score    = min(hit_count * 1.5, 30)          -- caps at 30 to prevent runaway
  recency_bonus = max(0, 15 - days_since_access)    -- linear decay over 15 days
  edge_bonus    = min(edge_count * 2, 10)            -- caps at 10 (5+ edges)
```

**Score range:** 0 to 55. New facts start at ~20 (hit_count=0, recency=15, edges=~2).

### 8.2 When It's Recalculated

- **On access:** Passive inclusion in the System Floor (Tier 1 breadcrumbs or Top 10 Tier 2 facts) is strictly read-only and DOES NOT increment hit_count or update last_accessed_at.
- **Nightly batch:** Gardener recalculates all active facts' `relevance_score` to account for recency decay. One SQL statement:

```sql
UPDATE kg_facts
SET relevance_score = (
  MIN(hit_count * 1.5, 30) +
  MAX(0, 15 - CAST(julianday('now') - julianday(last_accessed_at) AS REAL)) +
  MIN(edge_count * 2, 10)
)
WHERE status = 'active';
```

### 8.3 Lifecycle Example

```
Day 0:  Fact extracted: "Budget is 2.4M EUR"
        hit_count=0, recency=15, edges=2 → score=19
        Breadcrumb created (96h TTL)

Day 1:  LLM references it in a conversation
        hit_count=1, recency=14 → score=19.5
        Breadcrumb refreshed (96h from now)

Day 4:  Not referenced. Breadcrumb expires.
        Fact stays in kg_facts. score=17.5 (recency decayed)

Day 15: Never accessed again.
        score = 1.5 + 0 + 4 = 5.5
        Still exists. Shallow search won't surface it.

Day 60: User asks about budget. knowledge_search hits it.
        hit_count=2, recency=15 → score=22
        New breadcrumb created. Fact "pops" back to working memory.
```

---

## 9. Maintenance (Gardener Workers)

### 9.1 Adapted Workers

| Worker | Schedule | What It Does | Cost |
|--------|----------|--------------|------|
| **Fact Extractor** | Every 6h + on shard close | Extracts facts from closed shards → `kg_facts` + `kg_breadcrumbs`. Creates `sourced_from` edges to shard sources. Triggers Synthesizer per fact. | ~$0.02/run (Haiku extraction) |
| **Breadcrumb Sweeper** | Hourly | `DELETE FROM kg_breadcrumbs WHERE expires_at < datetime('now')`. Pure SQL, no LLM. | Free |
| **Score Decay** | Nightly | Recalculates `relevance_score` for all active facts (single UPDATE). | Free |
| **Orphan Audit** | Weekly | Finds facts with `edge_count = 0`, retries Synthesizer. Prunes truly orphaned facts older than 90 days by setting `status = 'superseded'`. | ~$0.05 (Haiku for edge classification) |
| **Channel Compactor** | Hourly | Unchanged — compresses inactive channels to background summaries. | ~$0.01/run |

### 9.2 Removed Workers

| Worker | Why Removed |
|--------|-------------|
| **Vector Evictor** | No more hot→cold eviction. Facts stay in `kg_facts` with pop/sink ranking. |
| **Stub Pruner** | No more stubs. Edges are permanent (facts are never evicted). |

---

## 10. Migration from Current System

### Phase 1: Schema Migration (1 session)

1. **Rename tables:**
   - `hippocampus_facts` → `kg_facts` (via `ALTER TABLE RENAME`)
   - `hippocampus_edges` → `kg_edges`
   - `hippocampus_facts_vec` → `kg_facts_vec`

2. **Add new columns to `kg_facts`:**
   ```sql
   ALTER TABLE kg_facts ADD COLUMN relevance_score REAL DEFAULT 5.0;
   ALTER TABLE kg_facts ADD COLUMN edge_count INTEGER DEFAULT 0;
   ```

3. **Backfill `relevance_score`:**
   ```sql
   UPDATE kg_facts SET relevance_score = (
     MIN(hit_count * 1.5, 30) +
     MAX(0, 15 - CAST(julianday('now') - julianday(last_accessed_at) AS REAL)) +
     (SELECT MIN(COUNT(*), 5) * 2 FROM kg_edges
      WHERE from_fact_id = kg_facts.id OR to_fact_id = kg_facts.id)
   );
   UPDATE kg_facts SET edge_count = (
     SELECT COUNT(*) FROM kg_edges
     WHERE from_fact_id = kg_facts.id OR to_fact_id = kg_facts.id
   );
   ```

4. **Add new columns to `kg_edges`:**
   ```sql
   ALTER TABLE kg_edges ADD COLUMN weight REAL DEFAULT 1.0;
   ALTER TABLE kg_edges ADD COLUMN created_by TEXT DEFAULT 'extractor';
   ```

5. **Drop stub columns** (can't ALTER TABLE DROP in SQLite — use a view or ignore):
   - `is_stub` and `stub_topic` remain in schema but are ignored. Clean up in a future SQLite rebuild.

6. **Create `kg_breadcrumbs` table.**

7. **Create `kg_sources` table.**

8. **Seed breadcrumbs** from current hot memory:
   ```sql
   INSERT INTO kg_breadcrumbs (id, kg_fact_id, summary_text, created_at, expires_at)
   SELECT hex(randomblob(16)), id, fact_text, datetime('now'), datetime('now', '+96 hours')
   FROM kg_facts
   WHERE status = 'active'
   ORDER BY hit_count DESC, last_accessed_at DESC
   LIMIT 30;
   ```

9. **Backfill `kg_sources`** from existing `source_ref` values in `kg_facts`:
   ```sql
   INSERT OR IGNORE INTO kg_sources (id, uri, source_type, created_at)
   SELECT hex(randomblob(16)), source_ref, source_type, created_at
   FROM kg_facts
   WHERE source_ref IS NOT NULL
   GROUP BY source_ref;
   ```

### Phase 2: Working Memory + Injection (1-2 sessions)

- Modify `loadSystemFloor()` to read from `kg_breadcrumbs` + top-ranked `kg_facts`
- Implement breadcrumb creation in Fact Extractor
- Implement breadcrumb expiry (hourly sweep)
- Implement breadcrumb refresh on fact access
- Wire `knowledge_search` tool (replaces `memory_query`)
- Update Cortex system prompt

### Phase 3: Synthesizer + Deep Search (1-2 sessions)

- Implement Synthesizer (§7)
- Wire into Fact Extractor (inline after each fact insert)
- Wire into Gateway Bridge (inline after article/audio ingestion)
- Implement `knowledge_deep_search` tool (adapt existing `traverseGraph`)
- Weekly orphan audit in Gardener

### Phase 4: Provenance (1 session)

- Implement URI resolvers for each source type
- Implement `knowledge_source` tool
- Ensure all new ingestion paths create `kg_sources` entries
- Register existing Library items as sources

### Phase 5: Polish + Deferred Items (1 session)

- Remove old `cortex_hot_memory` table and code paths
- Remove cold storage tables and code
- Update tests
- File-sourced fact extraction (workspace docs)
- Score decay nightly batch

**Total: 5-7 sessions.**

---

## 11. What We Don't Build

| Feature | Why Not |
|---------|---------|
| **Structured RAG / inverted index** (TypeAgent ref [2]) | Our scale (~1000s of facts) doesn't justify the complexity. Vector search + pop/sink ranking is sufficient. At 50K+ facts, revisit. |
| **BFT consensus validation** (SAGE ref [31]) | Single-user, single-agent system. Consensus validation is for multi-agent trust. Adds complexity without value. |
| **Separate consolidation agent** (Always-On Memory ref [5]) | Inline Synthesizer + Gardener catch-up covers the same ground without the scheduling/orchestration overhead. |
| **L0/L1/L2 tiered context loading** (OpenViking ref [24]) | Interesting pattern but over-engineered for our use case. We already have breadcrumbs (L0), search results (L1), and `knowledge_source` (L2). The hierarchy exists naturally without explicit tier metadata per fact. |
| **Self-improving skills** (ref [40]) | Valuable concept but orthogonal to memory architecture. Skills and memory are separate systems. |
| **Multimodal embeddings** (Gemini Embedding 2 ref [38]) | We use Ollama nomic-embed-text locally. Multimodal embeddings require cloud API. When Ollama supports a good multimodal embedding model, adopt it. |
| **Cognitive Memory feedback distillation** (CrewAI ref [39]) | Our Fact Extractor already extracts learnings from conversations including corrections. No separate feedback-to-lesson pipeline needed. |
| **Knowledge graph visualization** (SAGE CEREBRUM dashboard) | Nice to have. Not architectural. Build when there's time. |
| **Echo chamber mitigation / diversity monitoring** (Library arch) | User is the quality gate. Deferred until automated ingestion exists. |
| **Contradicts/supersedes auto-detection** | The Synthesizer creates `related_to` edges cheaply. Detecting `contradicts` and `supersedes` requires deeper LLM reasoning. Deferred — the edge type field supports it when we're ready. |

---

## 12. Key Decisions with Rationale

### D1: Single database (`bus.sqlite`), not a new `knowledge.sqlite`

**Pros:** Atomic transactions (fact + edges + breadcrumb + source in one write), no cross-DB connection management, existing backup infrastructure works.
**Cons:** bus.sqlite grows larger (currently ~9MB, will grow to ~20-50MB with full KG).
**Decision:** Stay in bus.sqlite. SQLite handles databases up to 281TB. 50MB is nothing.

### D2: Vector similarity thresholds, not LLM-for-everything

The Synthesizer uses vector distance thresholds for high-confidence edges and only calls Haiku for ambiguous cases. This keeps synthesis fast and cheap. TypeAgent (ref [2]) shows that structured indexing beats pure vector retrieval at scale, but at our scale, vector KNN is fast enough.

### D3: Fixed 96h breadcrumb TTL, not token-budgeted

SPEC.md asked whether breadcrumbs should be time-windowed or token-budgeted. **Time-windowed.** Rationale: token budgeting requires counting tokens on every breadcrumb operation. Time-based expiry is a single `WHERE expires_at < datetime('now')` — simpler, cheaper, predictable. The 30-breadcrumb hard cap prevents overflow regardless of timing.

### D4: `relevance_score` with caps, not unbounded `hit_count`

The current system sorts by raw `hit_count DESC` — old popular facts dominate forever. The new formula caps each component: `base_score ≤ 30`, `recency ≤ 15`, `edges ≤ 10`. A new fact with recent access and good connectivity can outscore an old fact with 100 hits but no recent access. This is the core fix for "no working memory."

### D5: No hot/cold storage split

The current system evicts facts from hot memory to cold storage. This creates data movement, stub management, and revival logic. With pop/sink, facts stay in one table — their ranking determines visibility. Simpler code, no data movement, no stubs.

### D6: Library DB stays separate

The Library is a Tier 3 source store with rich structured content (full_text, tags, summaries). Merging it into `kg_sources` would lose the structured query capabilities (`library_search`, `library_get`). The KG stores atomic facts extracted from Library items, linked via `source_ref`. Best of both worlds.

---

*This document is the definitive architecture for the Three-Tier Knowledge system. Implementation follows the pipeline pattern: Phase 1 (schema migration) is task 045a, subsequent phases follow as 045b–045e.*
