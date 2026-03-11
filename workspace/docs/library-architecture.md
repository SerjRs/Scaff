# Library Architecture — Domain Knowledge for Any Cortex Deployment

> **Status:** Draft v2.3  
> **Author:** Scaff + Serj  
> **Date:** 2026-03-11  
> **Related:** Hippocampus Architecture, Cortex Architecture  
> **Changelog:**  
> v1.0 — Initial design with Night Scholar, echo chamber mitigations  
> v1.1 — Added diversity monitor, novelty checking (SAGE Paper 2 findings)  
> v2.0 — Complete rewrite. Reframed as "domain knowledge layer for any Cortex deployment." Stripped Night Scholar, echo chamber mitigations, diversity monitoring, feedback loops to Future Work.  
> v2.1 — Breadcrumbs + on-demand pull model. Breadcrumbs include teaser. LLM has agency over retrieval depth.  
> v2.2 — Review fixes. Breadcrumb query includes teaser. All links ingested — no intent detection. Failed ingestion stores entry with error status. Add-only DB design.  
> v2.3 — **Shard pollution fix.** Library tool results (library_get, library_search) persist as compressed references (~20 tokens) in cortex_session, not full content (~500 tokens). LLM gets full content in current turn; shard stores only what was referenced. Prevents conversation displacement, stale knowledge, redundant accumulation.

---

## 1. Why the Library Exists

Cortex has two knowledge sources today:

- **SOUL.md** — who the assistant is (static, written once)
- **Hippocampus** — what happened in conversations (reactive, auto-extracted)

This is enough for week 1. Cortex is helpful but shallow. It knows the persona (SOUL.md) and the user's recent context (Hippocampus). But it has zero domain expertise.

The problem: **Hippocampus only learns from conversations.** If the user never talks about a topic, Cortex never learns about it. A telecom engineering manager would have to explain every vendor spec, every regulatory framework, every industry standard through chat for Cortex to absorb it. Nobody does that.

The Library is the channel for **bulk domain knowledge that doesn't fit in conversation.** The user drops links — industry reports, technical docs, vendor specs, competitor analyses, internal documents. The Librarian executor reads, summarizes, and stores them with embeddings. On every subsequent conversation turn, the most relevant Library items are retrieved by semantic similarity and injected into Cortex's context.

**Hippocampus = who the user is and what they're doing** (personal context).  
**Library = what the user's domain looks like** (world knowledge).

Both in context, every turn. That's what makes Cortex grow from a generic assistant into a domain expert.

---

## 2. The Growth Curve

Without the Library, every Cortex deployment hits a ceiling at week 4 — Hippocampus captures personal context but not domain depth. With the Library, Cortex compounds knowledge over time.

```
Week 1:   Fresh install. SOUL.md sets the persona. Cortex is helpful but generic.
          User: "Research competitor X"
          → Cortex web-searches, returns surface-level results. Same as Google.

Week 4:   Hippocampus has ~200 facts from conversations. Cortex knows projects,
          clients, priorities. It connects dots from past discussions.
          User: "Research competitor X"
          → Cortex remembers "you discussed losing client Y to X last week"
            and frames the research around that context.

Week 12:  Library has ~50 curated items. Industry reports, vendor docs, analyses.
          User: "Research competitor X"
          → Cortex pulls Library knowledge about X's recent product launches
            (from an industry report the user fed 3 weeks ago), connects it to
            the client Y situation from Hippocampus, produces an informed
            competitive analysis.

Week 26:  Library has ~200 items. Hippocampus has 1000+ facts.
          The user stops feeding links — Cortex already knows the domain.
          It asks the right questions, anticipates needs, drafts documents
          that sound like the user wrote them. The user reviews and approves.
```

This works for any role:
- **Software architect** → feeds architecture papers, framework docs, RFC specs
- **Business development** → feeds market reports, competitor profiles, industry analyses
- **Telecom engineer** → feeds 3GPP specs, vendor whitepapers, regulatory filings
- **HR manager** → feeds labor law updates, policy templates, industry benchmarks

The Library doesn't know or care about the domain. It processes, stores, embeds, and retrieves. The domain emerges from what the user feeds it.

---

## 3. The Core Loop

Two phases: **ingestion** (user feeds a link) and **retrieval** (LLM pulls what it needs).

### 3.1 Ingestion

```
User drops a link in chat
  │
  ▼
Cortex detects intent → spawns Librarian executor
  │
  ▼
Librarian:
  1. Fetches URL content (web_fetch / pdf-parse / browser)
  2. Summarizes (200-500 words, key ideas, not surface description)
  3. Extracts 3-7 key concepts as atomic statements
  4. Generates tags (kebab-case, specific)
  5. Generates embedding (Ollama nomic-embed-text, 768-dim)
  6. Stores everything in Library DB
  │
  ▼
Cortex confirms: "📚 Stored: '{title}' — tags: [x, y, z]"
```

### 3.2 Retrieval — Breadcrumbs + On-Demand Pull

The Library does NOT dump full summaries into context. It gives the LLM **breadcrumbs** — short hints about what's available. The LLM decides whether to pull more and how deep to go.

```
User asks a question
  │
  ▼
Cortex context assembly (automatic, every turn):
  1. System prompt (SOUL.md)
  2. Hippocampus hot facts (top 50)
  3. ★ Library breadcrumbs: embed the user's message,
     retrieve top-10 relevant items, inject ONLY
     title + tags + one-line teaser (~50 tokens each, ~500 total)
  4. Conversation history (sharded foreground)
  │
  ▼
LLM sees breadcrumbs:
  📚 Library (relevant items available):
    [id:7]  "Ericsson O-RAN Rural Deployment" — o-ran, rural, tco, fronthaul
    [id:12] "3GPP Release 18 Spectrum Sharing" — spectrum, dynamic-sharing, 3gpp-r18
    [id:15] "GSMA Rural Coverage Economics" — rural, economics, coverage-obligation
    [id:23] "Internal: North Region Site Plan" — north, sites, planning
    ...
  │
  ▼
LLM decides:

  Path A — "I have enough context, breadcrumbs are sufficient"
    → Responds directly. Zero additional Library cost.

  Path B — "I need details on specific items"
    → Calls library_get(7) → gets full summary + concepts for Ericsson O-RAN
    → Calls library_get(23) → gets full North Region site plan
    → Responds with deep, informed answer.

  Path C — "I need to search for something the breadcrumbs don't show"
    → Calls library_search("fronthaul investment costs rural sites")
    → Gets different items, maybe not in the top-10 breadcrumbs
    → Reads the ones it needs → responds.

  Path D — "This is a casual question, Library is irrelevant"
    → Ignores breadcrumbs entirely. Responds normally.
```

**Why breadcrumbs, not full injection:**

1. **Token efficiency.** Breadcrumbs cost ~500 tokens per turn. Full summaries cost 2500-5000. For casual questions ("what time is my meeting?"), those tokens are wasted.
2. **LLM agency.** The LLM is smarter than cosine similarity at judging relevance. It understands context, intent, nuance. It picks the right items, not just the most similar ones.
3. **Depth control.** Quick question → breadcrumbs are enough. Deep analysis → multiple `library_get` calls + maybe a `library_search` with a refined query. The LLM scales its research to the question.
4. **Refinement.** Breadcrumbs show top-10 by similarity to the user's message. But the LLM might realize it needs something specific — it calls `library_search("fronthaul costs")` and gets results the breadcrumbs didn't show.
5. **Scales to large libraries.** At 500 items, breadcrumbs show 10 titles. At 5000 items, same 10 titles. No context explosion.

---

## 4. Librarian Executor

**Trigger:** User drops a link in chat with intent: "read this", "store this", "add to library", or any variation the LLM can detect.

**Model:** Sonnet-class (cost-effective, sufficient for summarization).

**How it runs:** Cortex calls `sessions_spawn` with a Librarian prompt. The Router dispatches it like any other task. The executor reads the URL, processes it, writes to the Library DB, and returns a confirmation. Standard task lifecycle — no special infrastructure.

**Librarian prompt:**

```
You are a Librarian. Read the provided content and produce a structured knowledge entry.

Output as JSON:
{
  "title": "...",
  "summary": "200-500 word summary capturing key ideas — what matters, not surface description",
  "key_concepts": ["atomic statement 1", "atomic statement 2", ...],  // 3-7 concepts
  "tags": ["kebab-case-tag-1", "kebab-case-tag-2", ...],             // 3-10 specific tags
  "content_type": "article|documentation|tutorial|research|tool|discussion",
  "source_quality": "high|medium|low"
}

Focus on ACTIONABLE knowledge — what could someone apply, implement, or learn from?
Do not summarize surface-level. Extract the insights that matter.
```

**Edge cases:**
- PDF → use pdf-parse extraction (proven in our pipeline)
- Paywalled → extract what's available, note `partial: true`
- Complete ingestion failure (Cloudflare 403, anti-bot, unreachable) → store entry with `status: 'failed'` and error details. Report failure back to Cortex. URL is tracked so duplicate attempts are caught.
- Dead links → store with `status: dead`
- Duplicate URLs → update existing entry, increment version

**Cost:** ~$0.01 per link (Sonnet summarization + free local embedding).

---

## 5. Library Database

**Location:** `library/library.sqlite`

Separate from `cortex/bus.sqlite`. The Library is a knowledge store, not a conversation store. It persists across Cortex restarts, context resets, and session cleanups.

**Schema:**

```sql
-- Core items table
CREATE TABLE items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    key_concepts    TEXT NOT NULL,            -- JSON array of atomic statements
    full_text       TEXT,                     -- raw extracted content (for re-processing)
    tags            TEXT NOT NULL,            -- JSON array of kebab-case tags
    content_type    TEXT NOT NULL,            -- article|documentation|tutorial|research|tool|discussion
    source_quality  TEXT DEFAULT 'medium',    -- high|medium|low
    partial         BOOLEAN DEFAULT FALSE,
    status          TEXT DEFAULT 'active',    -- active|dead|failed|archived
    error           TEXT,                     -- error details if status = 'failed'
    version         INTEGER DEFAULT 1,
    ingested_at     TEXT NOT NULL,            -- ISO 8601
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Embeddings for semantic retrieval (sqlite-vec)
CREATE VIRTUAL TABLE item_embeddings USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding float[768]                      -- nomic-embed-text dimension
);

-- Indexes
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_ingested ON items(ingested_at);
```

**That's the whole schema for v1.** No tags table, no categories table, no notes table, no feedback table, no diversity snapshots, no goal snapshots. Tags are a JSON array in the items row. Categories are implicit from the tags. The schema grows when we need it, not before.

**Add-only design.** Items and embeddings are append-only. No updates to existing rows, no deletes, no cascade sync concerns. INSERT into `items` + INSERT into `item_embeddings` on ingestion. Done. If a URL is re-submitted, the existing entry is versioned (increment `version`, update `summary`/`key_concepts`/`tags`), but the old embedding row is replaced with a new one — still a simple write, not a multi-table sync.

**Breadcrumb query (called during Cortex context assembly, every turn):**

```sql
-- Embed the user's message via Ollama, then:
SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
FROM item_embeddings e
JOIN items i ON i.id = e.item_id
WHERE i.status = 'active'
ORDER BY vec_distance_cosine(e.embedding, ?) ASC
LIMIT 10;
```

Returns IDs, titles, tags, and a one-line teaser (~50 tokens per item, ~500 tokens total). The LLM uses `library_get(id)` to pull full details on demand.

**Full item query (called by `library_get` tool):**

```sql
SELECT id, title, summary, key_concepts, tags, content_type, source_quality, ingested_at
FROM items
WHERE id = ?;
```

**Search query (called by `library_search` tool):**

```sql
-- Embed the search query via Ollama, then:
SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
FROM item_embeddings e
JOIN items i ON i.id = e.item_id
WHERE i.status = 'active'
ORDER BY vec_distance_cosine(e.embedding, ?) ASC
LIMIT ?;  -- default 10, max 20
```

Returns breadcrumb-format results with a short teaser. The LLM picks which ones to `library_get`.

---

## 6. Cortex Integration

### 6.1 Ingestion (All Links)

Every link the user shares gets ingested into the Library. No intent detection, no filtering, no "is this a learning link?" heuristics. The user IS the quality gate — if they shared it, they want Cortex to learn it.

Cortex system prompt:

```
When the user shares a URL, always spawn a Librarian task to process and store it 
in the Library. Every link the user shares is domain knowledge worth retaining.
Use sessions_spawn with the Librarian prompt and the URL.
```

This is simpler and more reliable than intent detection. No false negatives ("I shared a link but Cortex ignored it"), no false positives ("Cortex tried to ingest a link I just wanted it to open"). Every link goes to the Library. The Library retrieval handles relevance — irrelevant items simply don't appear in breadcrumbs.

### 6.2 Retrieval — Breadcrumbs (Automatic)

On every Cortex turn, during context assembly in `context.ts`:

1. Take the user's current message
2. Generate embedding via Ollama nomic-embed-text
3. Query `item_embeddings` for top-10 similar items
4. Format as breadcrumbs — title + tags only, with item IDs:

```
📚 Library (relevant items available — use library_get(id) for details, library_search(query) to explore):
  [id:7]  "Ericsson O-RAN Rural Deployment" — o-ran, rural, tco, fronthaul
  [id:12] "3GPP Release 18 Spectrum Sharing" — spectrum, dynamic-sharing, 3gpp-r18
  [id:15] "GSMA Rural Coverage Economics" — rural, economics, coverage-obligation
  [id:23] "Internal: North Region Site Plan" — north, sites, planning
```

5. Inject this section into the system prompt, after Hippocampus hot facts. ~500 tokens.

The breadcrumbs tell the LLM what knowledge exists. The LLM decides whether to pull it.

### 6.3 Retrieval — Library Tools (LLM-Initiated)

Two sync tools, executed within the same LLM turn (like `code_search` and `get_task_status`):

**`library_get(item_id)`** — Retrieve full details of a specific Library item.

```typescript
const LIBRARY_GET_TOOL = {
  name: "library_get",
  description: `Get the full summary, key concepts, and metadata of a Library item by ID. 
Use when you see a relevant item in the Library breadcrumbs and need its details 
to answer the user's question.`,
  parameters: {
    type: "object",
    properties: {
      item_id: {
        type: "number",
        description: "Item ID from the Library breadcrumbs",
      },
    },
    required: ["item_id"],
  },
};
```

Returns: title, full summary (200-500 words), key concepts, tags, content type, source quality, ingestion date.

**`library_search(query)`** — Semantic search across the Library.

```typescript
const LIBRARY_SEARCH_TOOL = {
  name: "library_search",
  description: `Search the Library for items matching a query. Use when you need knowledge 
that the breadcrumbs don't show, or when you want to explore a specific angle 
that differs from the user's original question. Returns titles, tags, and short 
teasers — use library_get(id) to read the full item.`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      limit: {
        type: "number",
        description: "Max results (default: 10, max: 20)",
      },
    },
    required: ["query"],
  },
};
```

Returns: list of items with id, title, tags, one-line teaser — same format as breadcrumbs. The LLM can then `library_get` the ones it wants.

**Both tools are sync** — they execute within the same LLM turn, just like `code_search`. No Router task, no executor, no async wait. Direct DB query, instant result.

**Context budget:** Breadcrumbs (~500 tokens) are injected into the system prompt alongside Hippocampus hot facts — cheap and fixed. `library_get` and `library_search` results are tool responses consumed by the LLM in the current turn only.

**Shard persistence — reference, not content:** When `library_get` returns a full 500-word summary as a tool_result, the LLM uses it for the current turn. But what gets stored in `cortex_session` is a compressed reference only:

```
📚 Referenced: [id:7] "Ericsson O-RAN Rural Deployment" — o-ran, rural, tco, fronthaul
```

~20 tokens instead of ~500. The full content was consumed by the LLM but does not persist in the shard. This prevents **shard pollution** — library summaries are reference material, not conversation. They shouldn't displace conversation messages, go stale across turns, or accumulate redundantly. If the LLM needs the same item again in a later turn, it calls `library_get` again — the Library DB is the source of truth, not the shard.

Same for `library_search` — results are used in the current turn but only a one-line `"📚 Searched: 'fronthaul costs' — 4 results"` persists in the shard.

### 6.4 How It Plays Out

**Scenario 1 — Deep question, Library is critical:**

```
User: "What's our best option for the North region rollout?"

LLM sees breadcrumbs: items about O-RAN, spectrum sharing, rural economics, site plan.
LLM calls: library_get(7)   → full Ericsson O-RAN analysis
LLM calls: library_get(23)  → full North Region site plan details
LLM combines with Hippocampus facts (budget 2.4M, Nokia contract Q3)
LLM: "Based on the Ericsson analysis, O-RAN reduces TCO by 30% but needs fronthaul.
      Your 120 North sites at 20K each leaves no room for fronthaul within 2.4M..."
```

**Scenario 2 — Quick question, Library adds a nudge:**

```
User: "Remind me about the Nokia renewal timeline"

LLM sees breadcrumbs: [id:31] "Nokia RAN Portfolio 2026" — nokia, pricing, 5g
Hippocampus already has: "Nokia contract renewal Q3 2026"
LLM: "Q3 2026. By the way, your Library has Nokia's latest portfolio doc if you
      want me to pull their current pricing for the negotiation."
```

**Scenario 3 — Casual question, Library irrelevant:**

```
User: "What time is it in Tokyo?"

LLM sees breadcrumbs: all about telecom. Irrelevant.
LLM: "It's 3:47 AM in Tokyo (JST, UTC+9)."
Zero Library tool calls. Only cost: 500 tokens for breadcrumbs.
```

**Scenario 4 — LLM needs a different angle:**

```
User: "How are competitors handling coverage obligations?"

LLM sees breadcrumbs: [id:15] "GSMA Rural Coverage Economics" — relevant but broad.
LLM thinks: "I need specifically about regulatory obligations, not just economics."
LLM calls: library_search("coverage obligation regulatory compliance spectrum license")
  → Gets different items the breadcrumbs didn't show
LLM calls: library_get on the most relevant result
LLM: informed response about regulatory approaches
```

### 6.3 What About the Executor Writing to the DB?

The Librarian executor needs to write to `library/library.sqlite`. Current executors return text results — they don't write to databases. Two options:

**Option A: Executor returns JSON, Cortex loop writes to DB.**  
The Librarian executor returns the structured JSON (title, summary, concepts, tags). The ops-trigger handler in the Cortex loop (or a dedicated handler) parses the JSON and writes to the Library DB + generates embedding. This keeps the executor stateless and the DB write in the gateway process.

**Option B: Executor has direct DB access.** - **NO - this is Serj's answer **
The Librarian executor writes to `library/library.sqlite` directly. This requires giving the executor access to the DB path. Simpler executor logic but breaks the stateless executor model.

**Recommendation: Option A.** The executor is just an LLM that reads a URL and produces structured output. The gateway handles storage. This is cleaner and works with process-isolated executors (the child process doesn't need DB access).

---

## 7. Hippocampus vs Library — Clear Boundaries

| | Hippocampus | Library |
|---|---|---|
| **Source** | Conversations (auto-extracted) | External links (user-curated) |
| **Trigger** | Every conversation turn (Gardener) | User drops a link explicitly |
| **Content** | Short facts: "Budget is 2.4M EUR" | Rich summaries: 200-500 words + concepts |
| **Volume** | High (dozens of facts per day) | Low (1-5 links per day) |
| **Quality gate** | Gardener extraction (Haiku) | User curation + Librarian (Sonnet) |
| **Retrieval** | Top-50 by hit count / recency | Top-5 by embedding similarity to current message |
| **In context as** | Flat fact list | Structured summaries with concepts |
| **Lifecycle** | Auto-pruned, compacted, evicted | Persistent until archived |
| **DB** | `cortex/bus.sqlite` (cortex_hot_memory) | `library/library.sqlite` |

They are complementary layers, not competing stores:
- Hippocampus answers: "What do I know about THIS USER's situation?"
- Library answers: "What do I know about THIS DOMAIN's landscape?"

Both feed into every LLM turn. The LLM connects them.

---

## 8. Role-Agnostic Design

The Library doesn't contain any domain-specific logic. It doesn't know telecom from HR from software architecture. The domain emerges entirely from what the user feeds it.

This means the Library works identically for any Cortex deployment:

| Deployment | User feeds | Library becomes |
|---|---|---|
| Software Architect | Architecture papers, framework docs, RFCs | Software engineering knowledge base |
| Business Development | Market reports, competitor profiles, pitch decks | Business intelligence store |
| Telecom Engineer | 3GPP specs, vendor whitepapers, coverage analyses | Telecom domain knowledge |
| HR Manager | Labor law updates, policy templates, benchmarks | HR compliance + practices KB |
| Research Scientist | Papers, datasets, experiment notes | Research literature review |

**No code changes between deployments.** Same Librarian prompt, same DB schema, same retrieval query. The user's curation IS the configuration.

**The Librarian prompt is deliberately generic:**
- "Extract key ideas" — not "extract architectural patterns" or "extract regulatory requirements"
- "Focus on actionable knowledge" — universal
- "Rate source quality" — universal

A domain-specific Librarian prompt could improve quality (e.g., "For telecom content, extract relevant 3GPP references and spectrum bands"). But the generic version works for v1. Domain-specific prompts are a configuration option, not a code change — stored in SOUL.md or a `library/config.json`.

---

## 9. Implementation Plan

### Phase 1: Library DB + Librarian Executor (MVP)
**Effort:** 2 sessions

- [ ] Create `library/library.sqlite` with schema from §5
- [ ] Write Librarian executor prompt (§4)
- [ ] Add to Cortex system prompt: link detection guidance (§6.1)
- [ ] Implement ops-trigger handler: parse Librarian JSON result → write to Library DB → generate embedding
- [ ] Return confirmation to user after storage

**Deliverable:** User drops a link → Cortex spawns Librarian → item stored with summary, concepts, tags, embedding.

### Phase 2: Retrieval Integration (the critical piece)
**Effort:** 1-2 sessions

- [ ] In `context.ts`: embed user's current message via Ollama
- [ ] Query `item_embeddings` for top-10 similar items (breadcrumbs only: id, title, tags)
- [ ] Format as "📚 Library" breadcrumbs section (~500 tokens)
- [ ] Inject into Cortex system prompt after Hippocampus facts
- [ ] Implement `library_get(item_id)` sync tool — returns full summary + concepts
- [ ] Implement `library_search(query)` sync tool — semantic search, returns breadcrumbs + teasers
- [ ] Add both tools to `CORTEX_TOOLS`
- [ ] Add to system prompt: "Use library_get to pull details, library_search to explore"
- [ ] Verify: LLM sees breadcrumbs, decides to pull or skip, Library knowledge appears in responses when relevant

**Deliverable:** LLM-driven retrieval — Cortex sees what's available, decides how deep to go. Domain expertise grows with every link fed.

### Phase 3: Polish
**Effort:** 1 session

- [ ] Handle PDFs (pdf-parse, already proven)
- [ ] Handle dead links gracefully
- [ ] Duplicate URL detection (update existing, don't duplicate)
- [ ] Basic stats: item count, recent ingestions, tag distribution
- [ ] Test with 20+ items: verify breadcrumb relevance, library_get quality, library_search refinement

**Deliverable:** Robust ingestion pipeline, validated retrieval at scale.

**Total: 4-5 sessions for a working Library.**

---

## 10. What's Deferred (Future Work) **THIS IS DEFFERED, DO NOT IMPLEMENT NOW**

The v1.0 document included extensive features that are valuable but not needed for the core loop. These are deferred, not deleted:

| Feature | Why deferred | When to add |
|---|---|---|
| **Night Scholar** | The LLM already connects Library items to context on every turn. A nightly batch adds value only when the Library has 100+ items and the user wants proactive "overnight study" briefs. | When Library has 100+ items |
| **Echo chamber mitigations** | The user IS the diversity mechanism — they choose what to feed. Echo chambers are a risk when ingestion is automated. Ours is human-curated. | When/if automated ingestion is added |
| **Diversity monitoring** | Shannon entropy, category distribution — useful at scale, noise at 20 items. | When Library has 100+ items |
| **Feedback loop** | Tracking which items Cortex references is useful for long-term optimization. Not needed for the core retrieve-and-inject loop. | When measuring Library effectiveness |
| **Relevance/utility scoring** | Embedding similarity to the current message IS the relevance score. Goal-based scoring adds value when the Library is large enough that top-5 isn't specific enough. | When Library has 200+ items |
| **Novelty checking** | Cosine similarity between new and existing items catches redundancy. Useful but not critical — a few redundant items don't hurt retrieval. | Phase 3 or later |
| **Subsystem architecture** | Running the Librarian as a formal subsystem with its own result handler. Not needed when Cortex's existing sessions_spawn + ops-trigger path works fine. | When subsystem infrastructure exists |

**The principle: build what delivers value now. Add optimization when scale demands it.**


---

## 11. References

1. **SAGE Paper 2** — Kannabhiran, D.A. (2026). "Consensus-Validated Memory Improves Agent Performance on Complex Tasks." DOI: 10.5281/zenodo.18856774.
   - Key finding: Knowledge diversity > prompt detail. Echo chambers form without diversity controls. Informs future work (deferred).

2. **SAGE Paper 3** — Kannabhiran, D.A. (2026). "Institutional Memory as Organizational Knowledge." DOI: 10.5281/zenodo.18856845.
   - Key finding: Prompt engineering is transitional. Knowledge-as-infrastructure enables agents to learn their jobs from experience.

3. **SAGE Paper 4** — Kannabhiran, D.A. (2026). "Longitudinal Learning in Governed Multi-Agent Systems." DOI: 10.5281/zenodo.18888597.
   - Key finding: BFT-consensus memory enables longitudinal learning (ρ=0.716). Knowledge quality and domain tagging are critical.

4. **Retrieval-Augmented Generation (RAG)** — Lewis, P. et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks."
   - The Library is a human-curated RAG store with semantic retrieval.

5. **Hippocampus Architecture** — Internal document (`docs/hipocampus-architecture.md`).
   - Existing memory system that the Library complements.

---

*This document describes the minimal Library that makes Cortex deployable as a domain expert for any role. Build this first. Optimize when scale demands it.*
