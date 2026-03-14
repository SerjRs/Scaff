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

Hippocampus is how Scaff remembers. Not a database to search — a brain that knows.

It governs how information flows from the immediate ("we just said this") through working knowledge ("I know this matters right now") into deep memory ("I learned this weeks ago and it's still true") — and how connections between all of it surface the right thing at the right time.

---

## The Problem We're Solving

Scaff wakes up blank every session. The conversation from 30 minutes ago is compacted away. An article ingested last week sits in a separate database with no connection to the decision it informed. A mistake we made Tuesday has no link to the reasoning that caused it.

Three separate systems exist today:
- **Hippocampus** — extracts flat facts from conversations. No relationships. "Budget is 2.4M" is stored, but not why, or what it connects to.
- **Library** — 21 article summaries with vector embeddings. Isolated blobs. Can't tell you how Article 7 relates to Article 12 or to Tuesday's decision.
- **MEMORY.md** — manually curated text file. The closest thing to actual continuity, and it's edited by hand during heartbeats.

None of these talk to each other. None of them build connections. None of them learn from mistakes.

**The fix isn't a new system. It's completing the one we designed.**

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

## Library Becomes an Ingestion Pipeline, Not a Separate Store

Articles stop living in a separate database. When the Librarian processes a URL:

1. **Extract facts** — not just a summary blob. Individual claims, entities, relationships.
2. **Create nodes** — each fact becomes a node in the Hippocampus graph.
3. **Create edges** — facts from the same article are connected (`part_of` → article). Cross-article connections are found during consolidation.
4. **Provenance** — every fact traces back to its source (URL, article title, ingestion date).

The Library database may still exist as a staging area (raw content, full_text for re-processing), but the *knowledge* lives in Hippocampus. One graph. One system.

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

## What Gets Retired

- **MEMORY.md** — replaced by hot memory graph. No more manual curation during heartbeats.
- **Library as a separate knowledge store** — becomes an ingestion pipeline into Hippocampus. The `library.sqlite` may persist for raw content storage / re-processing, but knowledge facts live in Hippocampus.
- **memory/*.md daily files** — replaced by the Fact Extractor writing to the graph. Raw session logs (JSONL) remain as the source of truth for replay.

---

## What Stays

- **4-layer model** — unchanged. System Floor, Foreground, Background, Archived.
- **Shard-based context management** — unchanged. Topic boundaries, not arbitrary cuts.
- **Hot memory with hit count + recency** — unchanged. Facts still compete for the top-N slots.
- **Vector cold storage** — unchanged. Evicted facts are embedded for semantic search.
- **Gardener** — expanded with the Consolidator task, but same cron-based architecture.
- **Session JSONL backups** — unchanged. Always the source of truth for conversation replay.

---

## Success Criteria

1. **Never lose the thread** — within a session, the LLM knows what was discussed 30 minutes ago (Foreground shards). Across sessions, the hot memory graph carries forward the key facts and their connections.

2. **Articles feed the same brain** — ingesting a URL produces facts + edges in Hippocampus, not an isolated blob in Library. The article's knowledge is connected to conversation knowledge.

3. **Mistakes update the graph** — when we learn something was wrong, the graph shows the chain: old assumption → what happened → correction → what we know now. Not just a new fact replacing an old one.

4. **Breadcrumbs lead somewhere** — the hot memory graph in Layer 1 shows threads the LLM can pull. Each thread leads to deeper knowledge (cold storage, articles, conversations). The LLM can navigate, not just search.

5. **One system** — no more Hippocampus + Library + MEMORY.md. One knowledge brain with layers (hot/cold), connections (edges), and sources (conversations, articles, corrections).

---

## Open Questions (for next phase: technology selection)

- **Storage**: Extend `cortex_hot_memory` with an edges table in SQLite? Or add a lightweight embedded graph DB (Kuzu)?
- **Entity extraction model**: Local Ollama (free, private) vs API call (better extraction, costs money)?
- **Edge type schema**: Start with the 8 types above, or let them emerge organically from extraction?
- **Consolidation frequency**: Daily? Every 6h alongside Fact Extractor? Triggered by article ingestion?
- **Graph traversal in context**: How many hops deep for breadcrumbs? 1-hop (immediate connections) or 2-hop (connections of connections)?
- **Migration**: How to convert existing Library items + MEMORY.md into graph nodes?

These decisions come after we review the Library articles for technology patterns. The architecture comes first. The tools serve the architecture.
