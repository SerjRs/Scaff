---
id: "017"
title: "Hippocampus v2 — Complete the Knowledge Brain"
created: "2026-03-14"
author: "scaff"
priority: "critical"
status: "cooking"
moved_at: "2026-03-14"
---

# 017 — Hippocampus v2: Complete the Knowledge Brain

---

## What Hippocampus Is

Hippocampus is how Cortex remembers. Not a database to search — a brain that knows.

It governs how information flows from the immediate ("we just said this") through working knowledge ("I know this matters right now") into deep memory ("I learned this weeks ago and it's still true") — and how connections between all of it surface the right thing at the right time.

---

## The Problem We're Solving

Cortex loses context between turns as the conversation window slides. An article ingested last week sits in a separate database with no connection to the decision it informed. A mistake from Tuesday has no link to the reasoning that caused it.

Two separate knowledge systems exist in Cortex today:
- **Hippocampus (cortex_hot_memory)** — extracts flat facts from conversations. No relationships. "Budget is 2.4M" is stored, but not why, or what it connects to. Facts are isolated rows in a table.
- **Library (library.sqlite)** — article summaries with vector embeddings. Isolated blobs in a separate database. Can't tell you how Article 7 relates to Article 12 or to Tuesday's decision. Breadcrumbs surface titles but not connections.

These two systems don't talk to each other. Neither builds connections. Neither learns from mistakes.

**The fix isn't a new system. It's completing the one we designed.**

> **Scope note:** This spec covers Cortex's memory architecture only. The main agent (Scaff) has its own memory system (MEMORY.md, daily files, session backups) which is separate and unaffected by this work.

---

## Architecture: The 4 Layers (unchanged from v1)

The layer model is right. We keep it.

### Layer 1: System Floor — Identity + Hot Memory
Always loaded. Fixed token budget (<15-20% of context).

Contains:
- Identity files (SOUL.md, USER.md, IDENTITY.md)
- Pending operations (tasks in flight)
- **Hot Memory graph** — the top facts by relevance, WITH their connections

### Layer 2: Foreground — Active Conversation
The raw, verbatim conversation on the current channel. Full fidelity. Bounded by shard-based token caps — cuts happen at topic boundaries, never mid-thought. The active shard is always fully included.

This is "never losing the thread." The current discussion stays raw and complete.

### Layer 3: Background — Peripheral Awareness
One-line compressed summaries of other active channels. Very low token cost. Dropped after 24h idle.

### Layer 4: Archived — Cold Memory
Zero token cost. Never auto-injected. Searchable via `memory_query` (semantic) or `fetch_chat_history` (chronological). This is where evicted facts and old conversation chunks live.

---

## What Changes: The Knowledge Graph

### Facts become nodes. Connections become edges.

Today, hot memory is a flat table:

```
| fact_text                          | hit_count | last_accessed |
|------------------------------------|-----------|---------------|
| Budget is 2.4M                     | 12        | 2026-03-14    |
| Serj migrated DB to Postgres       | 5         | 2026-03-12    |
| O-RAN reduces TCO by 30%          | 3         | 2026-03-10    |
```

No fact knows about any other fact. "Budget is 2.4M" doesn't know it came from the O-RAN cost analysis. "Migrated to Postgres" doesn't know it was because MySQL couldn't handle the event load.

**v2 adds edges:**

```
[Budget is 2.4M] --sourced_from--> [O-RAN cost analysis article]
[Budget is 2.4M] --constrains--> [North region deployment plan]
[Migrated to Postgres] --because--> [MySQL couldn't handle event throughput]
[Migrated to Postgres] --informed_by--> [Distributed systems article #7]
[Migrated to Postgres] --resulted_in--> [Event processing 3x faster]
```

Each fact is a node. Each edge is typed and directional. The graph is what connects conversation to articles to decisions to outcomes.

### Edge types (initial set, will grow organically)

| Edge Type | Meaning | Example |
|-----------|---------|---------|
| `because` | Causal reasoning | decided X *because* Y |
| `informed_by` | Knowledge source | decision *informed_by* article |
| `resulted_in` | Outcome | action *resulted_in* effect |
| `contradicts` | Conflict | fact A *contradicts* fact B |
| `updated_by` | Superseded | old fact *updated_by* new fact |
| `related_to` | General association | topic A *related_to* topic B |
| `sourced_from` | Provenance | fact *sourced_from* article/conversation |
| `part_of` | Hierarchy | detail *part_of* broader concept |

### Hot memory becomes a subgraph

The System Floor still injects the top-N facts. But now it also injects the edges between them. When fact A is in hot memory and it has 3 connections, those connections are breadcrumbs — visible threads the LLM can pull.

```
## Hot Memory
- Budget is 2.4M [→ sourced_from: O-RAN cost analysis | → constrains: North deployment]
- O-RAN reduces TCO by 30% [→ sourced_from: Article #14 | → contradicts: vendor Q3 estimate]
- Migrated to Postgres [→ because: MySQL event throughput | → resulted_in: 3x faster processing]
```

Each bracket is a pull-cord. The LLM sees the connections and can decide to pull deeper — fetch the article, recall the conversation, trace the reasoning chain. The breadcrumbs don't consume extra tokens because they're compact. But they make the LLM *aware* of what it could know.

---

## Library Becomes a Content Store, Hippocampus Holds the Knowledge

Library and Hippocampus have distinct roles:

- **Library** = what we read. Raw content store. Holds URLs, titles, full_text, ingestion dates. The archive of source material. Cortex can always pull the original article when needed.
- **Hippocampus** = what we know. The knowledge graph. Holds facts, entities, edges, reasoning chains — extracted from articles AND conversations.
- **The link between them** = `sourced_from` edges. Every fact extracted from an article traces back to its Library item. "Where did I learn this?" is always answerable.

```
[Hippocampus Graph]
  fact: "O-RAN reduces TCO by 30%"
    → sourced_from: library://item/14
    → related_to: "North region budget"
    → contradicts: "Vendor Q3 estimate"

[Library]
  item/14: { url, title, full_text, ingested_at }
```

When the Librarian processes a URL:

1. **Store raw content** in Library — URL, title, full_text. This is the permanent source record.
2. **Extract facts** — not a summary blob. Individual claims, entities, relationships.
3. **Create nodes** in Hippocampus — each fact becomes a node in the knowledge graph.
4. **Create edges** — facts from the same article connect to each other (`part_of`). Each fact connects back to the Library item (`sourced_from`). Cross-article connections are found during consolidation.

Library stays as `library.sqlite`. Hippocampus stays in `bus.sqlite` (or wherever the graph tables live). They're separate databases with different purposes, linked by `sourced_from` edges. Not merged — complementary.

---

## Conversation Learning Gets Deeper

### Today's Fact Extractor
Runs every 6h. Scans `cortex_session`. Extracts flat facts like "Serj's project uses Postgres." Stores in `cortex_hot_memory`.

### v2 Fact Extractor
Same schedule, but now extracts:

1. **Facts** (same as today) — "Budget is 2.4M"
2. **Relationships** — "Budget is 2.4M *because* the O-RAN analysis showed 30% TCO reduction"
3. **Decisions** — "We decided to use Postgres" (tagged as decision node)
4. **Outcomes** — "The migration resulted in 3x faster processing" (linked to the decision)
5. **Corrections** — "We thought X but it turned out Y" → creates an `updated_by` edge, marks old fact as superseded

This is how we learn from mistakes. Not by storing "that was wrong" as a new fact, but by connecting the wrong assumption → what happened → what we learned. The reasoning chain is preserved.

---

## Consolidation: Finding Connections Over Time

New Gardener task (runs daily or on schedule):

**The Consolidator** scans recent facts and looks for connections to existing facts:
- New article about O-RAN → does it connect to the budget discussion from last week?
- New conversation about deployment → does it relate to the architecture article we ingested?
- A fact was corrected → what other facts depended on the old one?

This is the "sleep consolidation" from the Always-On Memory Agent research — but integrated into Hippocampus's existing Gardener, not a separate system. A cheap model (local Ollama or Sonnet) does the connection-finding. The connections are stored as edges.

Over time, the graph gets denser. Not because we add more facts, but because we find more connections between existing ones. The breadcrumbs get richer. The pull-cords lead deeper.

---

## The Read Path: How Breadcrumbs Work

When assembling context for an LLM turn:

1. **Layer 1 (System Floor)** — inject hot memory facts with their immediate edges (1-hop neighbors). This is the breadcrumb graph. Compact. ~20-30 facts with ~2-3 edges each.

2. **The LLM sees threads** — "Budget is 2.4M → sourced_from: O-RAN cost analysis." If the current conversation is about budgets, the LLM knows there's an O-RAN article backing this up. It can pull it.

3. **Pull-cord tools:**
   - `memory_query(query)` — semantic search across cold storage. Returns facts + their edges.
   - `fetch_chat_history(channel, before)` — raw conversation replay.
   - `graph_traverse(fact_id, depth)` — NEW. Walk the graph from a fact, N hops deep. "Show me everything connected to the O-RAN decision."

4. **The graph is the map, not the territory.** Breadcrumbs don't replace reading the article or replaying the conversation. They tell the LLM *what exists* and *how it connects*, so it can fetch the right thing instead of guessing.

---

## What Gets Retired (Cortex-side only)

- **Library as a knowledge store** — Library keeps raw content (URLs, full_text) but stops being where Cortex looks for knowledge. Knowledge (facts, entities, edges) is extracted into Hippocampus during ingestion. Library becomes the archive; Hippocampus becomes the brain.
- **Flat `cortex_hot_memory`** — replaced by the hot memory graph (facts + edges). Same table, extended with relationships.
- **Library breadcrumbs in system prompt** — replaced by hot memory graph breadcrumbs. Instead of injecting article titles, Cortex sees facts with their connections. The facts link back to Library items via `sourced_from` edges when Cortex needs the source.

> **Not affected:** The main agent's MEMORY.md, memory/*.md daily files, and session JSONL backups are a separate system and are not part of this spec.

---

## Fact Eviction: How the Graph Forgets Without Losing

The knowledge graph grows continuously — every conversation, every article adds facts and edges. Unbounded growth kills performance and pollutes the hot memory selection. Facts need to fade.

### Three tiers of memory

```
Hot graph (System Floor)     →  top-N facts + edges, injected every turn
Full knowledge graph (DB)    →  all active facts + edges, zero token cost
Cold storage (vectors)       →  evicted facts, searchable but disconnected from graph
```

### How eviction works

The Gardener's **Vector Evictor** (weekly) scans the full knowledge graph:

```
SELECT * FROM facts
WHERE last_accessed_at < datetime('now', '-14 days')
AND hit_count < 3
```

For each stale fact:
1. **Embed** the fact text into cold vector storage (sqlite-vec)
2. **Remove the fact node** from the knowledge graph (content gone)
3. **Keep edge stubs** — lightweight pointers remain: `{ from: stub, to: connected_fact, type: "because" }`. The stub records the evicted fact's ID, a topic hint, and its cold storage vector ID. No content, just skeleton.

Edge stubs are tiny (two IDs + a type + a topic hint). They preserve the graph's structure even as fact content comes and goes.

### How revival works

When a semantic search (`memory_query`) hits an evicted fact in cold storage:
1. **Re-insert** the fact into the knowledge graph as an active node
2. **Reconnect** using the edge stubs — the connections are already there, just reattach
3. **Reset** hit_count and last_accessed_at — the fact is alive again

This is how forgetting works in a brain: you don't lose the memory, you lose instant access. A trigger (relevant conversation, related article) brings it back, fully connected.

### Graph size stays bounded

- Active facts in the full graph: bounded by eviction policy (e.g., facts accessed in the last 14 days OR with hit_count ≥ 3)
- Edge stubs: tiny, grow slowly, can be pruned if both endpoints are evicted and the stub is >90 days old
- Cold vectors: grow forever but cost nothing (no graph traversal, no token injection)

---

## What Stays

- **4-layer model** — unchanged. System Floor, Foreground, Background, Archived.
- **Shard-based context management** — unchanged. Topic boundaries, not arbitrary cuts.
- **Hot memory with hit count + recency** — unchanged. Facts still compete for the top-N slots.
- **Vector cold storage** — unchanged. Evicted facts are embedded for semantic search.
- **Gardener** — expanded with the Consolidator task, but same cron-based architecture.
- **cortex_session** — unchanged. Conversation history per channel/shard.
- **cortex_channel_states** — unchanged. Background summaries of other channels.

---

## Success Criteria

1. **Never lose the thread** — within a conversation, Cortex knows what was discussed 30 minutes ago (Foreground shards). Across conversations, the hot memory graph carries forward the key facts and their connections.

2. **Articles feed the same brain** — ingesting a URL produces facts + edges in Hippocampus, not an isolated blob in Library. The article's knowledge is connected to conversation knowledge.

3. **Mistakes update the graph** — when we learn something was wrong, the graph shows the chain: old assumption → what happened → correction → what we know now. Not just a new fact replacing an old one.

4. **Breadcrumbs lead somewhere** — the hot memory graph in Layer 1 shows threads the LLM can pull. Each thread leads to deeper knowledge (cold storage, articles, conversations). The LLM can navigate, not just search.

5. **One system** — no more separate Hippocampus + Library stores. One knowledge brain for Cortex with layers (hot/cold), connections (edges), and sources (conversations, articles, corrections).

---

## Open Questions (for next phase: technology selection)

- **Storage**: Extend `cortex_hot_memory` with an edges table in SQLite? Or add a lightweight embedded graph DB (Kuzu)?
- **Entity extraction model**: Local Ollama (free, private) vs API call (better extraction, costs money)?
- **Edge type schema**: Start with the 8 types above, or let them emerge organically from extraction?
- **Consolidation frequency**: Daily? Every 6h alongside Fact Extractor? Triggered by article ingestion?
- **Graph traversal in context**: How many hops deep for breadcrumbs? 1-hop (immediate connections) or 2-hop (connections of connections)?
- **Migration**: How to convert existing Library items + MEMORY.md into graph nodes?

These decisions come after we review the Library articles for technology patterns. The architecture comes first. The tools serve the architecture.
