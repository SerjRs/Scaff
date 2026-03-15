# 017 — Technical Proposals per Layer

For each component of Hippocampus v2, what the Library articles teach us and what approach fits.

---

## 1. Fact & Relationship Extraction (Write Path)

> The most critical component. Everything downstream depends on the quality of extraction.

### What the articles say

**TypeAgent [2]:** Uses LLMs to extract tree-structured entities and relationships per conversation turn. Short topic sentences + entity trees. Key insight: small fine-tuned models can do this extraction with only minor quality loss vs large models — important for cost at scale.

**Cognee:** 6-step pipeline: classify → check permissions → chunk → extract graph (LLM) → summarize → embed. The graph extraction step uses an LLM to identify entities and relationships, then deduplicates nodes and edges. This is the expensive step.

**Always-On Memory [5]:** IngestAgent extracts structured information (summaries, entities, topics, importance scores) from any input. Uses a cheap model (Gemini Flash-Lite) because for continuous extraction, cost matters more than intelligence.

### Proposal: Two-tier extraction

**Conversation facts (every Fact Extractor run, every 6h):**
- Model: **Local Ollama (llama3.2:3b)** — free, private, fast. Good enough for factual extraction from conversational text where context is clear.
- Prompt: Extract facts as `(subject, predicate, object)` triples + edge types from the 8-type schema. Also extract a confidence score (high/medium/low).
- Fallback: If Ollama extraction quality is poor, upgrade to **Sonnet** via API for extraction. Test both and compare.

**Article facts (on Library ingestion):**
- Model: **Sonnet via API** — articles are denser and more complex than conversation. Worth the cost since ingestion is infrequent (a few articles per week).
- Prompt: Extract entities, claims, relationships. Each fact gets a `sourced_from: library://item/N` edge automatically.
- Input: The Librarian executor already reads the article. Extend its prompt to output facts + edges alongside the existing summary/tags.

### Output format (both tiers):

```json
{
  "facts": [
    { "id": "f1", "text": "O-RAN reduces TCO by 30%", "confidence": "high" },
    { "id": "f2", "text": "Cost savings come from vendor-neutral hardware", "confidence": "medium" }
  ],
  "edges": [
    { "from": "f1", "to": "f2", "type": "because" },
    { "from": "f1", "to": "library://25", "type": "sourced_from" }
  ]
}
```

### Why not TypeAgent's inverted index approach?

TypeAgent's key claim is that inverted index + BM25 beats vector search. For our case:
- We already have vector search (sqlite-vec) working
- Our corpus is small (tens to hundreds of facts, not millions)
- BM25 shines at scale — at our size, the overhead of maintaining a separate index isn't justified
- **But**: if the graph grows past ~1000 active facts, revisit this. BM25 for fact lookup + graph for relationships could be a powerful hybrid.

---

## 2. Knowledge Graph Storage

> Where facts and edges live. The full graph.

### What the articles say

**Cognee:** Triple storage (relational + vector + graph). Uses Kuzu (embedded graph DB) for the graph layer. Supports Cypher queries.

**Always-On Memory [5]:** SQLite is sufficient when the LLM handles synthesis. No graph DB needed at their scale.

**TypeAgent [2]:** Inverted index (term → entity → source). No graph DB — the structure IS the index.

### Proposal: SQLite tables (for now)

Two new tables alongside the existing `cortex_hot_memory`:

```sql
-- Facts (extends hot_memory concept)
CREATE TABLE IF NOT EXISTS hippocampus_facts (
  id TEXT PRIMARY KEY,
  fact_text TEXT NOT NULL,
  fact_type TEXT DEFAULT 'fact',        -- fact | decision | outcome | correction
  confidence TEXT DEFAULT 'medium',     -- high | medium | low
  status TEXT DEFAULT 'active',         -- active | superseded | evicted
  source_type TEXT,                     -- conversation | article | consolidation
  source_ref TEXT,                      -- shard ID, library item ID, or consolidation run ID
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  cold_vector_id TEXT                   -- set when evicted to cold storage
);

-- Edges (relationships between facts)
CREATE TABLE IF NOT EXISTS hippocampus_edges (
  id TEXT PRIMARY KEY,
  from_fact_id TEXT NOT NULL,
  to_fact_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,              -- because, informed_by, contradicts, etc.
  confidence TEXT DEFAULT 'medium',
  is_stub INTEGER DEFAULT 0,           -- 1 when the target fact is evicted
  stub_topic TEXT,                      -- topic hint for evicted facts
  created_at TEXT NOT NULL,
  FOREIGN KEY (from_fact_id) REFERENCES hippocampus_facts(id),
  FOREIGN KEY (to_fact_id) REFERENCES hippocampus_facts(id)
);

-- Indexes for graph traversal
CREATE INDEX idx_edges_from ON hippocampus_edges(from_fact_id);
CREATE INDEX idx_edges_to ON hippocampus_edges(to_fact_id);
CREATE INDEX idx_facts_status ON hippocampus_facts(status);
CREATE INDEX idx_facts_hot ON hippocampus_facts(hit_count DESC, last_accessed_at DESC);
```

### Why SQLite, not Kuzu?

- **Zero new dependencies.** We already have SQLite everywhere. Adding Kuzu means a C++ native module, build complexity, and another thing to maintain.
- **Our scale doesn't need it.** With hundreds of facts and edges, SQLite joins are fast enough. Graph DBs shine at millions of nodes with complex traversals.
- **Graph queries map to SQL.** 1-hop: `SELECT * FROM edges WHERE from_fact_id = ?`. 2-hop: self-join. N-hop: recursive CTE. Not pretty, but functional at our scale.
- **Migration path exists.** If we outgrow SQLite (>10K facts, complex multi-hop traversals), we can migrate to Kuzu. The fact/edge table schema maps cleanly to property graph nodes/edges.

### Where does this table live?

In `bus.sqlite` alongside `cortex_session`, `cortex_hot_memory`, and `cortex_channel_states`. One database file for all of Cortex's state. Single backup, single WAL.

---

## 3. Hot Memory Graph (System Floor Injection)

> The breadcrumbs. What Cortex is aware of every turn.

### What the articles say

**TypeAgent [2]:** Information density matters. Structured data (entities + relationships) is denser than raw text per token. More relevant information per prompt token.

**OpenClaw Prompts [13]:** Token cost is an engineering problem. Auto-loaded content should contain only what's needed every turn.

### Proposal: Top-N facts with 1-hop edges, compact format

**Selection query:**

```sql
SELECT f.id, f.fact_text, f.fact_type, f.hit_count
FROM hippocampus_facts f
WHERE f.status = 'active'
ORDER BY f.hit_count DESC, f.last_accessed_at DESC
LIMIT 30
```

Then for each selected fact, fetch immediate edges:

```sql
SELECT e.edge_type, f2.fact_text, f2.id
FROM hippocampus_edges e
JOIN hippocampus_facts f2 ON e.to_fact_id = f2.id
WHERE e.from_fact_id = ?
AND e.is_stub = 0
LIMIT 3  -- max 3 edges per fact to control token cost
```

**Injection format (token-optimized):**

```
## Knowledge Graph (Hot Memory)
- Budget is 2.4M [→ constrains: North deployment | → threatened_by: integration costs 500K]
- O-RAN deployment planned for North [→ deadline: Q3 | → informed_by: TCO article (lib:25)]
- Integration costs 500K [→ corrects: article estimate 15-20% | → caused: budget overrun (resolved)]
```

**Token budget:** ~30 facts × ~40 tokens each (fact + 2-3 edge hints) = ~1200 tokens. Well within the 15-20% System Floor budget.

**Edge hints, not full facts:** The edge text is a compressed hint, not the full connected fact. "→ informed_by: TCO article (lib:25)" is 8 tokens, not the full article summary. The LLM can pull more via `graph_traverse` if needed.

### Relevance-boosted selection

Beyond hit_count and recency, the selection should boost facts that are relevant to the **current conversation topic**. This uses the existing shard context:

1. Take the last 3 messages from the current shard
2. Embed them (Ollama nomic-embed-text)
3. Boost facts whose embeddings are similar to the current conversation

This prevents the hot graph from being purely historical (most-accessed facts) and makes it contextually aware (facts relevant to right now).

---

## 4. Cold Storage & Eviction

> How facts are forgotten and revived.

### What the articles say

**TypeAgent [2]:** "Structured RAG never forgets" — they argue against eviction. But their use case (indexing podcasts for total recall) is different from ours (bounded working memory for an agent).

**Always-On Memory [5]:** Consolidation compresses related information. Old memories that connect to new ones get strengthened, not evicted. Mirrors neuroscience.

### Proposal: Keep existing sqlite-vec cold storage, add edge stubs

**Eviction (Gardener weekly task):**

```sql
SELECT id, fact_text FROM hippocampus_facts
WHERE status = 'active'
AND last_accessed_at < datetime('now', '-14 days')
AND hit_count < 3
```

For each:
1. Generate embedding via Ollama nomic-embed-text
2. Insert into sqlite-vec cold storage table
3. Set `status = 'evicted'`, store `cold_vector_id`
4. For all edges touching this fact: set `is_stub = 1`, store `stub_topic` (first 50 chars of fact_text)

**Revival (on semantic search hit):**

```sql
-- When memory_query hits a cold vector:
UPDATE hippocampus_facts
SET status = 'active', hit_count = 1, last_accessed_at = datetime('now'), cold_vector_id = NULL
WHERE id = ?;

-- Reconnect stubs:
UPDATE hippocampus_edges SET is_stub = 0, stub_topic = NULL
WHERE (from_fact_id = ? OR to_fact_id = ?) AND is_stub = 1;
```

**Stub pruning (monthly):**

```sql
-- Remove stubs where BOTH endpoints are evicted and stub is >90 days old
DELETE FROM hippocampus_edges
WHERE is_stub = 1
AND created_at < datetime('now', '-90 days')
AND from_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'evicted')
AND to_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'evicted');
```

---

## 5. Consolidation (Finding Connections)

> The "sleep consolidation" — finding connections between facts that weren't obvious at ingestion time.

### What the articles say

**Always-On Memory [5]:** ConsolidateAgent runs every 30 minutes. Performs cross-memory analysis: finding connections, generating synthesized insights, compressing related information. Uses a cheap model. This is the key differentiator from passive retrieval.

**Cognee:** `memify` operation — post-cognify enrichment that adds derived nodes and edges to an existing graph. Runs extraction and enrichment tasks over the existing graph without re-ingesting data.

### Proposal: Consolidator as a Gardener task

**Frequency:** Daily (or triggered after article ingestion). Not every 30 min — our volume doesn't justify it.

**Model:** Ollama llama3.2:3b for cost. Upgrade to Sonnet if quality is poor.

**Process:**

1. Gather recent facts (last 24h or since last consolidation)
2. Gather existing facts that share entities or topics with the new facts (keyword overlap or embedding similarity)
3. Prompt the model:

```
Given these new facts:
[list of new facts]

And these existing facts:
[list of potentially related existing facts]

Identify relationships between new and existing facts.
Output as edges: { from, to, type, confidence }
Edge types: because, informed_by, contradicts, updated_by, related_to, part_of, resulted_in, sourced_from
Only output relationships you are confident about. Do not invent connections.
```

4. Insert discovered edges into `hippocampus_edges`
5. Log the consolidation run for auditing

**Finding candidate facts for consolidation:**

Two approaches, use both:

A. **Entity overlap:** Extract key entities (proper nouns, technical terms) from new facts. Find existing facts containing the same entities. This is simple string matching — no LLM needed.

B. **Embedding similarity:** Embed the new fact, find top-5 similar existing facts via sqlite-vec. This catches conceptual connections that entity matching misses.

Feed both sets to the LLM for relationship identification.

---

## 6. Graph Traversal (Read Path)

> How Cortex navigates the graph beyond hot memory.

### What the articles say

**Cognee:** Multiple search modes — vector, graph traversal, hybrid. Graph-aware completion finds relevant graph triplets using vector hints, resolves them into context, then asks the LLM to answer grounded in that context.

**TypeAgent [2]:** Hybrid query expressions combining relational queries, scope expressions, and tree-pattern expressions. High specificity.

**QMD [7]:** BM25 + semantic hybrid. Deterministic full-text search combined with embedding-based search.

### Proposal: Three retrieval tools

**Tool A: `memory_query(query)` — Semantic recall (exists today)**
- Embeds query → searches cold storage via sqlite-vec
- Returns matching facts + their edges
- On hit: updates hit_count, revives evicted facts
- **Enhancement:** Also search active facts by embedding similarity, not just cold storage. This makes it useful even when facts haven't been evicted.

**Tool B: `fetch_chat_history(channel, limit, before)` — Chronological replay (exists today)**
- Direct SQL query on cortex_session
- Returns verbatim conversation history
- No change needed.

**Tool C: `graph_traverse(fact_id, depth, direction)` — NEW. Graph walking.**
- Starts at a fact node, walks edges to N hops
- Returns the subgraph as structured text
- Parameters:
  - `fact_id`: starting node (from hot memory breadcrumb)
  - `depth`: how many hops (default 2, max 4)
  - `direction`: "outgoing" | "incoming" | "both" (default "both")

```sql
-- 1-hop traversal
SELECT f2.fact_text, e.edge_type, f2.fact_type, f2.status
FROM hippocampus_edges e
JOIN hippocampus_facts f2 ON (
  CASE WHEN e.from_fact_id = :start THEN e.to_fact_id ELSE e.from_fact_id END = f2.id
)
WHERE e.from_fact_id = :start OR e.to_fact_id = :start;

-- 2-hop: recursive CTE
WITH RECURSIVE traverse AS (
  SELECT :start AS fact_id, 0 AS depth
  UNION ALL
  SELECT
    CASE WHEN e.from_fact_id = t.fact_id THEN e.to_fact_id ELSE e.from_fact_id END,
    t.depth + 1
  FROM traverse t
  JOIN hippocampus_edges e ON (e.from_fact_id = t.fact_id OR e.to_fact_id = t.fact_id)
  WHERE t.depth < :max_depth
)
SELECT DISTINCT f.id, f.fact_text, f.fact_type, f.status
FROM traverse t
JOIN hippocampus_facts f ON f.id = t.fact_id;
```

**Output format:**

```
Subgraph from "Budget is 2.4M" (depth=2):

Budget is 2.4M
  → constrains: O-RAN deployment North
    → deadline: Q3
    → informed_by: O-RAN TCO article (lib:25)
  → part: hardware 1.8M (renegotiated)
    → resulted_from: vendor-neutral argument
  → part: integration 500K
    → corrects: article estimate 15-20% [SUPERSEDED]
  → status: within budget [resolved overrun]
```

---

## 7. Article Ingestion Pipeline

> How Library articles become graph knowledge.

### Current flow:
```
User drops URL → Cortex calls library_ingest → Router spawns Librarian executor
→ Librarian reads article, produces JSON (title, summary, tags, key_concepts)
→ gateway-bridge stores in library.sqlite → embedding generated
```

### Proposed flow:
```
User drops URL → Cortex calls library_ingest → Router spawns Librarian executor
→ Librarian reads article, produces JSON:
  {
    title, summary, tags, key_concepts,     ← existing
    full_text,                               ← added by 010b
    facts: [...],                            ← NEW: extracted claims/entities
    edges: [...]                             ← NEW: relationships between facts
  }
→ gateway-bridge:
  1. Stores raw content in library.sqlite (URL, title, full_text)
  2. Inserts facts into hippocampus_facts with source_ref = library://item/N
  3. Inserts edges into hippocampus_edges
  4. Generates embeddings for each fact (for future cold storage eviction)
  5. Triggers Consolidator to find cross-connections with existing graph
```

### Librarian prompt extension:

Add to the existing Librarian prompt:

```
In addition to summary and tags, extract individual factual claims from the article.
For each fact, identify:
- The claim itself (one sentence, specific and self-contained)
- Confidence: high (stated explicitly), medium (implied), low (speculative)
- Relationships to other extracted facts: because, contradicts, part_of, qualifies

Output format:
"facts": [
  { "id": "f1", "text": "...", "confidence": "high" },
  ...
],
"edges": [
  { "from": "f1", "to": "f2", "type": "because" },
  ...
]
```

---

## 8. Conversation Fact Extraction

> How conversations become graph knowledge.

### Current: Gardener Fact Extractor (every 6h)
- Scans cortex_session
- Extracts flat facts via LLM
- Stores in cortex_hot_memory

### Proposed: Enhanced Fact Extractor

Same schedule (every 6h). Enhanced output.

**Model choice:**

| Approach | Model | Cost | Quality | Latency |
|----------|-------|------|---------|---------|
| A. Local | Ollama llama3.2:3b | Free | Acceptable for conversation (clear context) | ~2s per batch |
| B. API | Sonnet | ~$0.01 per extraction | High | ~3s per batch |
| C. Hybrid | Ollama first, Sonnet for low-confidence extractions | ~$0.003 avg | High where it matters | ~2-4s |

**Recommendation: Option C (hybrid).** Use Ollama for initial extraction. If any fact has confidence "low" or the extraction looks thin, re-run that segment through Sonnet. This keeps costs near zero for routine conversations and uses API only when quality demands it.

**Extraction prompt:**

```
From this conversation segment, extract:
1. Facts: specific claims, decisions, or observations (not greetings or filler)
2. Decisions: explicit choices made ("we decided to...", "let's go with...")
3. Outcomes: results of actions ("it worked", "it failed", "we learned...")
4. Corrections: things that were wrong ("actually it's...", "that was incorrect...")

For each, identify relationships:
- What caused this? (because)
- What does this inform? (informs)
- What does this contradict? (contradicts)
- What does this update? (updates/corrects)

Mark decisions and corrections with fact_type "decision" and "correction".
These are high-value for the learning graph.

Output JSON: { facts: [...], edges: [...] }
```

---

## Summary: Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Fact storage | SQLite table (`hippocampus_facts`) in bus.sqlite | Zero new deps, sufficient at our scale |
| Edge storage | SQLite table (`hippocampus_edges`) in bus.sqlite | Same file, indexed for traversal |
| Cold storage | sqlite-vec in bus.sqlite | Already working, proven |
| Conversation extraction | Ollama llama3.2:3b (hybrid with Sonnet fallback) | Free for routine, quality where needed |
| Article extraction | Sonnet via API | Articles are dense, worth the cost |
| Consolidation | Ollama llama3.2:3b (daily) | Connection-finding is simpler than extraction |
| Hot memory injection | SQL query + compact text format | Same approach as v1, extended with edges |
| Graph traversal | Recursive CTEs in SQLite | Functional at our scale, no graph DB needed |
| Article content | library.sqlite (unchanged) | Raw text archive, linked by sourced_from edges |
| Embeddings | Ollama nomic-embed-text (unchanged) | Local, free, 768-dim, proven |

### What we DON'T need (yet)

| Technology | Why not now | When to revisit |
|------------|-----------|-----------------|
| Kuzu / graph DB | <1000 facts, SQLite recursive CTEs work fine | >10K facts, complex multi-hop queries |
| BM25 / inverted index | Small corpus, vector + SQL covers it | >5K facts, need deterministic keyword search |
| External embedding API | Ollama nomic-embed-text works, free, private | If embedding quality becomes a bottleneck |
| Ontology grounding (Cognee) | No canonical vocabulary needed for personal knowledge | Domain-specific deployments (medical, legal) |
| Multiple vector DBs | sqlite-vec handles our volume | >100K vectors, need sharding |
