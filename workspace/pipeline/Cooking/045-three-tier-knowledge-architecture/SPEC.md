# 045 — Three-Tier Knowledge Architecture

*Version: 1.0 — 2026-03-19*
*Status: Cooking*
*Author: Serj + Scaff*

---

## 0. What Hippocampus Is

Hippocampus is Cortex's memory system. Its job is to make Cortex smarter over time — not by accumulating tokens, but by distilling everything Cortex experiences (conversations, articles, audio, files) into a searchable, connected knowledge graph that surfaces the right facts at the right time, with provenance back to the original source.

**Hippocampus must be lightweight.** It lives permanently in the LLM's context window — injected into the system floor on every single turn. This means it cannot grow unbounded. The facts that sit in active memory must be few, dense, and relevant. Everything else lives in the deeper graph, retrievable on demand but not burning tokens by default.

**The Small KG (Tier 1) is NOT a separate store — it is a window into the Big KG (Tier 2).** All facts live in the Big KG from the moment they are created. The Small KG is just breadcrumbs — lightweight pointers to Big KG nodes that represent what's recently active. When a fact appears in the Small KG, it means: "this fact is currently relevant, here's a summary and a link to the full node in the Big KG." When a fact falls out of the Small KG (96h expiry, not referenced), it doesn't "migrate" anywhere — it was already in the Big KG. It simply stops appearing in the LLM's active context. The fact is still searchable, still traversable, still there. It just lost its spot in the lightweight window.

**Facts age by losing visibility, not by moving.** A freshly extracted fact gets a breadcrumb in the Small KG — the LLM sees it every turn. If it's referenced, it stays. If it's ignored for 96 hours, the breadcrumb expires and the fact becomes visible only through search or graph traversal in the Big KG. Within the Big KG itself, unused facts sink in search rankings (low relevance_score) — they still exist, but shallow searches won't return them. Only deep search, which walks graph edges regardless of ranking, can resurface them. Facts that get referenced frequently maintain high relevance and keep appearing in search results.

This is a natural lifecycle: **visible (Small KG breadcrumb) → searchable (Big KG, high rank) → deep (Big KG, low rank) → forgotten but never deleted**. The LLM's attention is finite, and Hippocampus respects that by keeping the active footprint small and the knowledge deep.

**The sources are the foundation.** Every fact in the Big KG traces back to a raw source: a URL that was shared, an article the Librarian processed, an audio transcript from a meeting, a conversation shard, a file on disk, a task result from the Router. These raw sources are Tier 3 — the provenance layer. They are not knowledge (that's Tier 2) and not active context (that's Tier 1). They are evidence. When Cortex says "the budget is 2.4M EUR," the graph can answer: "that came from a WhatsApp conversation on March 5th in shard #4872, here are the exact messages." When Cortex says "O-RAN reduces TCO by 30%," the graph can answer: "that came from the Ericsson report at https://..., ingested on March 10th, here's the full article." The sources give Cortex the ability to show its work.

---

## 0.1 Motivation

The current Hippocampus implementation has a flat architecture: one table (`hippocampus_facts`) serves as both working memory and long-term knowledge. The Library (`library.sqlite`) is a separate database with no graph connections. Audio transcripts, conversation shards, articles, and files are disconnected islands — facts extracted from each source sit in the same table but have no cross-source edges.

This produces three concrete failures:
1. **No working memory.** A fact from 6 weeks ago with high hit_count ranks above today's events. The LLM has no "I was just doing X" awareness.
2. **No unified knowledge.** Facts from conversations, articles, and audio don't link to each other. Asking "what do we know about Project X" returns fragments from one source, not a connected picture.
3. **No provenance.** Cortex can trace a fact to `library://item/46` but can't follow that to the actual audio recording, URL, or file. "Where did you learn that?" has no answer.

### References — Current Architecture Documents
- Hippocampus Architecture: `workspace/docs/hipocampus-architecture.md`
- Hippocampus Implementation Plan: `workspace/docs/hipocampus-implementation.md`
- Library Architecture: `workspace/docs/library-architecture.md`
- Foreground Sharding: `workspace/docs/foreground-sharding-architecture.md`
- Cortex Architecture: `workspace/docs/cortex-architecture.md`
- Cortex Subsystem Architecture: `workspace/docs/cortex-subsystem-architecture.md`
- Overall Architecture: `workspace/docs/overall-architecture.md`
- Self-Improvement Architecture: `workspace/docs/self-improvement-architecture.md`

### References — Current Source Code
- Hippocampus module: `src/cortex/hippocampus.ts`
- Context assembly: `src/cortex/context.ts` (loadSystemFloor, assembleContext)
- Gardener (Fact Extractor, Compactor, Evictor): `src/cortex/gardener.ts`
- Library DB + CRUD: `src/library/db.ts`
- Library retrieval: `src/library/retrieval.ts`
- Librarian prompt builder: `src/library/librarian-prompt.ts`
- Gateway bridge (fact ingestion from articles): `src/cortex/gateway-bridge.ts`
- Audio pipeline → Librarian: `src/gateway/server-audio.ts` (onIngest callback)
- Audio worker: `src/audio/worker.ts`
- Cortex session store: `src/cortex/session.ts`
- Cortex shards: `src/cortex/shards.ts`
- Cortex tools (library_get, library_search, memory_query, graph_traverse): `src/cortex/tools.ts`

### References — Databases
- Cortex bus DB (Hippocampus + Session): `cortex/bus.sqlite`
- Library DB: `library/library.sqlite` (note: also exists at `workspace/library/library.sqlite` — the Cortex-managed articles table)
- Audio session DB: `workspace/data/audio/audio.sqlite`
- Audio transcripts: `workspace/data/audio/transcripts/{session-id}.json`

### References — Pipeline Tasks (Done)
- 017a-017i: Hippocampus v2 Knowledge Graph (schema, migration, system floor injection, graph traverse, conversation edges, article ingestion, consolidator, eviction stubs, library migration): `workspace/pipeline/Done/017a-*` through `017i-*`
- 021: Full Memory Backfill: `workspace/pipeline/InProgress/021-hippocampus-full-memory-backfill/`
- 036: Route audio transcripts through Librarian: `workspace/pipeline/Done/036-*/`
- 044: Canary test fix (exposed ingestion bugs): `workspace/pipeline/Done/044-canary-test-fix/`

### References — Pipeline Tasks (Cooking, related)
- 010: Library-Cortex Evolution: `workspace/pipeline/Cooking/010-library-cortex-evolution/`
- 017: Hippocampus v2 Knowledge Graph (parent): `workspace/pipeline/Cooking/017-hippocampus-v2-knowledge-graph/`

---

## 1. The Three Tiers

```
┌───────────────────────────────────────────────────┐
│           TIER 1 — Small KG (Working Memory)      │
│           Last 96 hours. Injected every turn.      │
│           Links ↓ to Tier 2.                       │
├───────────────────────────────────────────────────┤
│           TIER 2 — Big KG (Knowledge Graph)        │
│           All facts. All edges. Cross-source.      │
│           Pop/sink ranking. Shallow + deep search.  │
│           Links ↓ to Tier 3.                       │
├───────────────────────────────────────────────────┤
│           TIER 3 — Raw Sources (Provenance)        │
│           URLs, files, transcripts, shards, docs.  │
│           Never searched directly. Followed via     │
│           links from Tier 2.                       │
└───────────────────────────────────────────────────┘
```

### Tier 1 — Small KG (Working Memory)

**What it is:** A lightweight window into the Big KG showing what's active RIGHT NOW. Not a separate store — a set of breadcrumbs pointing to Big KG nodes. This is the LLM's "I was just doing X" awareness.

**Critical design point:** Tier 1 does NOT contain facts. It contains **references to facts that live in Tier 2.** When a new fact is extracted from a conversation or audio transcript, it goes directly into the Big KG (Tier 2). Simultaneously, a breadcrumb is created in Tier 1 pointing to that fact. The breadcrumb has a 96h TTL. When it expires, the breadcrumb is deleted — but the fact stays in Tier 2 forever.

**What it contains:**
- Breadcrumbs: short summaries + links to Big KG fact nodes
- Scoped to the last 96 hours of activity
- Recent task completions, decisions, events, active project context
- Each breadcrumb points to one or more Tier 2 nodes

**How it's populated:**
- When the Gardener's Fact Extractor creates a new fact in Tier 2, it also creates a breadcrumb in Tier 1
- When a Librarian ingests an article or audio transcript into Tier 2, breadcrumbs are created for the key facts
- When the LLM references a Tier 2 fact (via search), a breadcrumb can be re-created to bring it back to active memory
- Breadcrumbs expire after 96h of not being refreshed

**How the LLM sees it:**
- Injected into the System Floor on EVERY turn (same as current hot memory injection)
- Format: short fact text + links to Big KG: `- Serj tested live audio capture at 3:01 PM [→ kg:audio-pipeline-test, → kg:project-025]`
- Budget: ~15% of system floor tokens (~20 breadcrumbs with richer context than current 30 flat facts)

**Key difference from current design:**
- Current: `hippocampus_facts` sorted by `hit_count DESC` — old popular facts dominate the window
- New: strictly time-windowed breadcrumbs. Recency-first. A 6-week-old fact with high hits does NOT appear here unless the LLM actively referenced it recently. It appears in Tier 2 search results instead.

**Schema:**
```sql
CREATE TABLE working_memory (
  id               TEXT PRIMARY KEY,
  kg_fact_id       TEXT NOT NULL,            -- points to kg_facts.id (Tier 2)
  summary_text     TEXT NOT NULL,            -- short breadcrumb text for system floor injection
  source_type      TEXT,                     -- conversation, audio, system, task_result
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,            -- created_at + 96h, hard expiry
  refreshed_at     TEXT                      -- reset when LLM references it, extends visibility
);

CREATE INDEX idx_wm_expires ON working_memory(expires_at);
CREATE INDEX idx_wm_created ON working_memory(created_at DESC);
CREATE INDEX idx_wm_kg_fact ON working_memory(kg_fact_id);
```

**Lifecycle:**
```
New fact extracted from shard/audio/task
  → INSERT into kg_facts (Tier 2, permanent)
  → INSERT breadcrumb into working_memory (Tier 1, 96h TTL)
  → Synthesizer creates cross-source edges in Tier 2
  → After 96h without refresh: DELETE breadcrumb from working_memory
  → Fact remains in Tier 2, searchable, traversable, forever
```

---

### Tier 2 — Big KG (Knowledge Graph)

**What it is:** The unified, permanent knowledge graph. ALL facts from ALL sources, connected by typed edges. This is Cortex's long-term memory — everything it has ever learned.

**What it contains:**
- Every fact ever extracted (from conversations, articles, audio, files, tasks)
- Typed edges connecting facts across sources (related_to, caused_by, sourced_from, contradicts, supersedes, etc.)
- Source references linking every fact to its Tier 3 provenance
- Vector embeddings for semantic search
- Pop/sink scores for search ranking

**How it's organized:**

Every fact is a node. Every connection is an edge. Sources are special nodes (type: "source") that represent a Tier 3 raw source.

```
[fact: "Budget is 2.4M EUR"]
    ──sourced_from──→ [source: conversation shard #4872]
    ──related_to──→ [fact: "Nokia contract renewal Q3 2026"]
    ──related_to──→ [fact: "North region rollout planning"]

[fact: "O-RAN reduces TCO by 30%"]
    ──sourced_from──→ [source: library://item/7 (Ericsson O-RAN report)]
    ──contradicts──→ [fact: "Vendor lock-in reduces long-term costs"]

[fact: "Meeting at 3:01 PM tested audio pipeline"]
    ──sourced_from──→ [source: audio-capture://b55b299d]
    ──related_to──→ [fact: "Audio pipeline bugs fixed: channel null, status ordering"]
    ──resulted_in──→ [fact: "Full E2E audio pipeline verified working"]
```

**Pop/Sink mechanism:**

Every fact has a `relevance_score` that determines search ranking:
```
relevance_score = (hit_count × 2) + recency_bonus + edge_count_bonus
```
- `hit_count`: incremented every time the fact is accessed (search result, LLM reference, edge traversal)
- `recency_bonus`: decays over time (e.g., `max(0, 10 - days_since_last_access / 7)`)
- `edge_count_bonus`: facts with more connections are more central to the graph (`min(5, edge_count)`)

High-scoring facts float up in search results. Low-scoring facts sink. But they are NEVER deleted — they remain in the graph, reachable by deep search or edge traversal.

**Two search modes:**

1. **Shallow search (default):** Vector KNN + relevance_score ranking. Returns top-N results. Fast. Sunk facts won't appear because their relevance_score is too low. This is what the LLM calls 90% of the time.

2. **Deep search:** Graph traversal. Starts from seed facts (shallow search results or specific IDs) and walks edges outward, following connections regardless of relevance_score. Discovers old, forgotten, sunk facts that are still connected to the query topic. Slow but thorough. The "dig into the archives" mode. Returns a subgraph, not just a flat list.

**Schema (evolves current `hippocampus_facts` + `hippocampus_edges`):**
```sql
-- Facts table (extends current hippocampus_facts)
CREATE TABLE kg_facts (
  id               TEXT PRIMARY KEY,
  fact_text        TEXT NOT NULL,
  fact_type        TEXT DEFAULT 'fact',      -- fact, decision, event, source, concept
  confidence       TEXT DEFAULT 'medium',
  status           TEXT DEFAULT 'active',    -- active, disputed, superseded, archived
  source_type      TEXT,                     -- conversation, article, audio, file, task, system
  source_ref       TEXT,                     -- Tier 3 URI (see below)
  relevance_score  REAL DEFAULT 0.0,
  hit_count        INTEGER DEFAULT 0,
  edge_count       INTEGER DEFAULT 0,        -- denormalized for fast ranking
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Edges table (extends current hippocampus_edges)
CREATE TABLE kg_edges (
  id             TEXT PRIMARY KEY,
  from_fact_id   TEXT NOT NULL REFERENCES kg_facts(id),
  to_fact_id     TEXT NOT NULL REFERENCES kg_facts(id),
  edge_type      TEXT NOT NULL,              -- sourced_from, related_to, caused_by, contradicts,
                                             -- supersedes, resulted_in, informed_by, part_of
  confidence     TEXT DEFAULT 'medium',
  weight         REAL DEFAULT 1.0,           -- edge strength (for traversal ranking)
  created_at     TEXT NOT NULL,
  created_by     TEXT                        -- 'extractor', 'synthesizer', 'librarian', 'user'
);

-- Vector index for semantic search
CREATE VIRTUAL TABLE kg_facts_vec USING vec0(
  embedding float[768]
);

-- Indexes for ranking
CREATE INDEX idx_kg_relevance ON kg_facts(relevance_score DESC);
CREATE INDEX idx_kg_status ON kg_facts(status);
CREATE INDEX idx_kg_source_ref ON kg_facts(source_ref);
CREATE INDEX idx_kg_edges_from ON kg_edges(from_fact_id);
CREATE INDEX idx_kg_edges_to ON kg_edges(to_fact_id);
```

---

### Tier 3 — Raw Sources (Provenance Layer)

**What it is:** The foundation of the knowledge system. The actual evidence — the raw material from which all Tier 2 facts are extracted. Not a knowledge store and not searchable directly. Every Tier 2 fact links down to its Tier 3 source via `source_ref`. This is how Cortex answers "where did you learn that?"

**What it contains:**

Every piece of information that has ever entered the system, in its original form:

- **URLs** — web articles, GitHub repos, documentation pages, blog posts, research papers. The user shared a link, the Librarian fetched and processed it. The original URL and fetched content are the source.
- **Library articles** — the Librarian's structured output: title, summary, key concepts, tags, full text. These are derived from URLs or audio transcripts but represent a processed, enriched form of the raw content.
- **Audio transcripts** — speaker-attributed text with timestamps, produced by Whisper from captured audio. Includes the raw WAV files on disk. This is the proof that a conversation happened and what was said.
- **Conversation shards** — the actual messages exchanged between the user and Cortex on any channel (WhatsApp, webchat, etc.). Grouped by topic via the sharding system. The verbatim record of what was discussed.
- **Files on disk** — documents, configs, code, architecture specs, daily logs, memory files. Anything the system has read from the workspace.
- **Task results** — outputs from Router executor jobs. When Cortex delegated a research task or coding task and got a result back, that result is a source.
- **Backfilled sources** — historical data imported during the initial Hippocampus backfill: old daily logs, session archives, curated memory files, pipeline task specs. These predate the live extraction system but were retroactively indexed.

**How it's organized:**

A unified `sources` table that registers every raw source with a resolvable URI:

```sql
CREATE TABLE kg_sources (
  id           TEXT PRIMARY KEY,              -- UUID
  uri          TEXT NOT NULL UNIQUE,           -- resolvable identifier
  source_type  TEXT NOT NULL,                 -- url, library_item, audio_transcript,
                                              -- conversation_shard, file, task_result
  title        TEXT,                          -- human-readable label
  metadata     TEXT,                          -- JSON: author, date, duration, path, etc.
  content_hash TEXT,                          -- SHA-256 of raw content (dedup)
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,                          -- last time the URI was successfully resolved
  status       TEXT DEFAULT 'active'          -- active, dead, moved, archived
);

CREATE INDEX idx_sources_uri ON kg_sources(uri);
CREATE INDEX idx_sources_type ON kg_sources(source_type);
```

**URI scheme:**
```
url://https://example.com/article           → web URL
library://item/46                           → Library article
audio://b55b299d-9c9b-4d54-9550-...         → audio transcript + WAV files
shard://whatsapp/4872                       → conversation shard
file://workspace/docs/cortex-architecture.md → local file
task://c0857f28-1d5e-4578-a1c7-...          → Router task result
backfill://daily_log/workspace/memory/...    → backfilled source
```

**Resolution:** Each URI scheme has a resolver that can fetch the raw content:
- `url://` → web_fetch
- `library://` → query library.sqlite items table
- `audio://` → read `workspace/data/audio/transcripts/{session-id}.json` + WAV files at `workspace/data/audio/processed/{session-id}/`
- `shard://` → query cortex_session filtered by shard_id
- `file://` → read from disk
- `task://` → query cortex_task_dispatch for result

**How it links to Tier 2:**
Every `kg_facts.source_ref` is a URI from the `kg_sources` table. To trace provenance:
```
kg_facts.source_ref → kg_sources.uri → resolve to raw content
```

The LLM can follow this chain: "This fact came from an audio recording on March 19 at 3:01 PM. Here's the transcript."

---

## 2. The Synthesizer (New Component)

The biggest architectural gap today: nobody connects facts across sources. The Synthesizer fills this role.

**What it does:**
When new facts enter Tier 2 (either promoted from Tier 1 or directly from Librarian/article ingestion), the Synthesizer:
1. Takes each new fact
2. Runs a vector similarity search against existing Tier 2 facts
3. For each match above a similarity threshold, creates an edge (related_to, contradicts, supersedes, etc.)
4. Uses a lightweight LLM (Haiku) to classify the edge type if the similarity is ambiguous

**When it runs:**
- After every Tier 1 → Tier 2 promotion (batch, every 96h for expired working memory)
- After every Librarian ingestion (inline, when article facts are inserted)
- After every audio transcript ingestion (inline)
- As a periodic Gardener task (daily) for catch-up synthesis

**Cost control:**
- Vector similarity is free (local Ollama embeddings + sqlite-vec)
- Edge classification uses Haiku (~$0.001 per fact)
- Only new facts trigger synthesis — existing facts are not re-processed

**Schema integration:** The Synthesizer writes to `kg_edges` with `created_by = 'synthesizer'`.

---

## 3. Search API

### 3.1 Shallow Search (Tool: `knowledge_search`)

Single entry point that replaces the current `memory_query` + `library_search` split.

```
knowledge_search(query, limit=10)
```

1. Embed query via Ollama nomic-embed-text
2. Vector KNN on `kg_facts_vec` → candidate facts
3. Rank by: `vec_distance × 0.6 + relevance_score × 0.4`
4. Return top-N with fact text, type, source_ref, edge hints
5. Bump `hit_count` and `last_accessed_at` on returned facts

Sunk facts (low relevance_score) naturally fall below the cutoff. Fast, token-efficient.

### 3.2 Deep Search (Tool: `knowledge_deep_search`)

Graph traversal from seed nodes.

```
knowledge_deep_search(query_or_fact_ids, depth=3, max_nodes=50)
```

1. If query string: run shallow search to get seed fact IDs
2. BFS/DFS from seeds, following all edges up to `depth` hops
3. Return subgraph: facts + edges + source_refs
4. No relevance filtering — walks the full graph, including sunk facts
5. Bump `hit_count` on all traversed facts (they just became relevant again)

This is the "dig into the archives" mode. Expensive but thorough. Used when the LLM needs to reconstruct full context around a topic.

### 3.3 Provenance Resolution (Tool: `knowledge_source`)

Follow a source_ref to its raw content.

```
knowledge_source(source_ref_or_fact_id)
```

1. If fact_id: look up `kg_facts.source_ref`
2. Resolve the URI via the appropriate resolver
3. Return raw content (transcript text, article summary, shard messages, file content)

This is the "show me where you learned that" tool.

---

## 4. Migration Path

### Phase 1: Schema Migration
- Rename `hippocampus_facts` → `kg_facts` (add `relevance_score`, `edge_count`)
- Rename `hippocampus_edges` → `kg_edges` (add `weight`, `created_by`)
- Create `working_memory` table
- Create `kg_sources` table
- Backfill `kg_sources` from existing `source_ref` values in `kg_facts`
- Backfill `kg_facts.relevance_score` from existing `hit_count` + `last_accessed_at`

### Phase 2: Working Memory (Tier 1)
- Modify Gardener Fact Extractor to: create fact in `kg_facts` (Tier 2) + create breadcrumb in `working_memory` (Tier 1)
- Implement 96h breadcrumb expiry (delete breadcrumb, fact stays in Tier 2)
- Modify `loadSystemFloor()` in `context.ts` to read breadcrumbs from `working_memory` (joined with `kg_facts` for full text)
- Keep Tier 2 top-N injection as a secondary section (reduced from 30 to 10 facts)

### Phase 3: Synthesizer
- Implement cross-source edge creation
- Wire into Librarian ingestion path (when article facts are created in Tier 2)
- Wire into audio transcript ingestion path
- Wire into Gardener fact extraction (when new facts are created in Tier 2)
- Add daily Gardener task for catch-up synthesis

### Phase 4: Unified Search
- Implement `knowledge_search` (replaces `memory_query` + `library_search`)
- Implement `knowledge_deep_search` (new)
- Implement `knowledge_source` (new)
- Wire tools into Cortex tool list
- Deprecate old tools

### Phase 5: Provenance
- Register all existing sources in `kg_sources`
- Implement URI resolvers for each scheme
- Ensure every new ingestion creates a `kg_sources` entry
- Wire `knowledge_source` tool to resolvers

---

## 5. What Changes for Cortex

### System Floor (every turn)
**Before:**
```
## Knowledge Graph (Hot Memory)
- Budget is 2.4M EUR [→ sourced_from: Nokia Q3 discussion]
- ... (30 facts sorted by hit_count)
```

**After:**
```
## Working Memory (last 96h)
- Fixed 3 audio pipeline bugs: channel null, status ordering, error propagation [→ kg:audio-pipeline, → kg:044-canary-fix]
- Serj tested live audio capture at 3:01 PM — full E2E verified [→ kg:audio-test-march19]
- All test rewrite tasks complete (030-043), 114 tests passing [→ kg:test-rewrite-project]
... (up to 20 recent facts)

## Long-Term Knowledge (top 10)
- Budget is 2.4M EUR [→ kg:project-budget]
- Nokia contract renewal Q3 2026 [→ kg:nokia-contract]
... (10 highest relevance_score facts from Tier 2)
```

### Tools
**Before:** `memory_query`, `library_search`, `library_get`, `graph_traverse`
**After:** `knowledge_search`, `knowledge_deep_search`, `knowledge_source`, `library_get` (kept for backward compat)

### Library Integration
The Library DB (`library.sqlite`) remains as-is — it's a Tier 3 raw source store. But every Library item also gets registered in `kg_sources`, and the Librarian's fact extraction writes directly to `kg_facts` with `source_ref = library://item/{id}`. Library breadcrumbs in the system prompt can be replaced by Tier 2 facts that happen to have `source_type = 'article'`.

---

## 6. What We Keep

- Foreground sharding ✅ (untouched, already working)
- Gardener workers ✅ (Compactor, Extractor adapted for Tier 1, Evictor replaced by pop/sink)
- Library DB schema ✅ (Tier 3 source, not a knowledge store)
- Audio pipeline ✅ (chunks → Whisper → Librarian → facts, now routed to Tier 1/2/3)
- Conversation session store ✅ (`cortex_session` stays, shards are Tier 3 sources)
- Vector embeddings via Ollama nomic-embed-text ✅ (same infra, applied to `kg_facts_vec`)

## 7. What We Remove

- `cortex_hot_memory` table (replaced by `working_memory` + `kg_facts` ranking)
- `cortex_cold_memory` / cold storage vector table (merged into `kg_facts_vec` — no hot/cold split, just pop/sink ranking)
- Separate Library breadcrumbs in system prompt (replaced by Tier 2 article-sourced facts)
- `memory_query` tool (replaced by `knowledge_search`)
- Hot/cold eviction cycle (replaced by continuous pop/sink scoring)

---

## 8. Open Questions

1. **Database consolidation.** Should `kg_facts`, `kg_sources`, and `working_memory` live in `cortex/bus.sqlite` (current) or a new dedicated `knowledge.sqlite`? Arguments for separate: isolation, backups, size. Arguments for same: fewer connections, simpler transactions when creating facts + edges + sources atomically.

2. **Synthesizer LLM calls.** For cross-source edge classification, Haiku is cheap but adds latency to every ingestion. Alternative: use vector similarity threshold alone (>0.85 = related_to, no LLM). Only invoke LLM for ambiguous cases (0.6–0.85 range).

3. **Working memory size.** 96h is a starting point. Should this be configurable? Should it be token-budgeted rather than time-windowed? (e.g., "keep up to 2000 tokens of working memory")

4. **Backward compatibility.** The migration renames core tables. Existing tools, tests, and the Gardener all reference `hippocampus_facts` directly. The migration needs to be atomic or use views for backward compat during transition.

5. **Library breadcrumbs.** Currently the Library injects top-10 breadcrumbs by embedding similarity every turn (~500 tokens). With Tier 2, article-sourced facts are already in the Big KG. Do we still need separate breadcrumbs, or does `knowledge_search` replace them entirely?

---

*This document describes the target architecture. Implementation will be broken into sub-tasks (045a, 045b, ...) following the established pipeline pattern.*
