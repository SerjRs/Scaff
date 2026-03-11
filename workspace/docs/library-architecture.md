# Library Architecture — Supervised Continuous Learning for Cortex

> **Status:** Draft v1.1  
> **Author:** Scaff + Serj  
> **Date:** 2026-03-10  
> **Related:** Hippocampus Architecture, Executor Architecture v2, SAGE Papers 2–4  
> **Changelog:** v1.1 — Added echo chamber mitigations (§8), diversity monitor, novelty checking on ingestion. Informed by SAGE Paper 2 (Consensus-Validated Memory) echo chamber findings.

---

## 1. Problem Statement

Cortex currently learns only from conversations. The Hippocampus extracts facts from dialogue — reactive, episodic memory derived from what the user and agent discuss. If a topic never comes up in conversation, Cortex never learns about it.

This creates a fundamental gap: **Cortex cannot learn from the external world proactively.** It cannot read a blog post about a new OpenClaw capability, study an architecture pattern, or absorb knowledge from documentation — unless the user manually pastes content into the chat.

The SAGE Paper 4 (Kannabhiran, 2026) demonstrated that agents with institutional memory improve performance over time (Spearman ρ=0.716, p=0.020), while agents without memory show zero learning trend regardless of prompt sophistication. Critically, the paper also showed that **knowledge quality and domain tagging** are essential — 44 misclassified entries caused catastrophic regression to baseline, and knowledge without proper routing renders memory inert.

SAGE Paper 2 (Kannabhiran, 2026) provides the controlled statistical evidence: 40% lower calibration error (Cohen's d = −0.824, LARGE), 100% quality consistency (std 0.0 vs 13.1), and variance collapse as the signature of institutional learning. It also documents a critical failure mode: **echo chambers** — when memory converges to a single dominant pattern through positive feedback loops, agents stop exploring alternatives regardless of prompt quality. Knowledge diversity outweighs prompt detail (40-line guided prompt + homogeneous memory performed worse than 8-line minimal prompt + diverse memory).

SAGE Paper 3 (Kannabhiran, 2026) frames the philosophical foundation: prompt engineering is a transitional practice. When institutional memory exists, prompts shrink to organizational identity — who you are, where you work, what you're evaluated on. The knowledge layer handles the rest. Prompts are CPU registers (ephemeral); institutional memory is distributed storage (persistent, governed).

The Library architecture addresses these findings by creating a **human-curated, async knowledge ingestion pipeline** with goal-aware retrieval, nightly integration, and explicit diversity controls.

---

## 2. Design Principles

1. **Human curation over automated scraping.** The user decides what Cortex should learn. This is the quality gate that prevents the knowledge pollution documented in SAGE Paper 4.

2. **Async processing, zero conversational cost.** Link ingestion happens in background executors. Cortex stays lean and present for conversation. No token burn on the main session.

3. **Goal-aware retrieval over flat storage.** Items in the Library are not retrieved by recency or hit count. The Night Scholar connects items to current goals, milestones, and open issues. What matters is what's relevant *now*.

4. **Learning notes over raw summaries.** The Night Scholar doesn't produce "Article X is about Y." It produces "Article X describes pattern Y, which connects to our open issue #31 because Z." Notes bridge external knowledge to internal context.

5. **Relevance decays, utility promotes.** Library items are re-ranked as goals change. Items that Cortex actually references in decisions get promoted. Items that sit untouched get deprioritized.

6. **Separation of concerns.** The Librarian executor processes content. The Library DB stores it. The Night Scholar evaluates relevance. Cortex consumes the output. Each component has a single responsibility.

7. **Knowledge diversity over knowledge volume.** Echo chambers form when memory converges to a single dominant pattern (SAGE Paper 2, §4.5.3). The Library actively monitors category distribution and novelty. Redundant knowledge is flagged, under-represented categories are surfaced, and the Night Scholar deprioritizes over-saturated domains. Diverse knowledge with minimal prompts outperforms detailed prompts with homogeneous knowledge.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER (Serj)                             │
│                  Drops links into chat                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CORTEX                                  │
│  Detects link intent → spawns Librarian executor                │
│  Receives learning briefs from Night Scholar                    │
│  References library items in conversations (feedback signal)    │
└───────────┬───────────────────────────────────┬─────────────────┘
            │                                   ▲
            ▼                                   │
┌───────────────────────┐         ┌─────────────────────────────┐
│   LIBRARIAN EXECUTOR  │         │       NIGHT SCHOLAR         │
│                       │         │       (Nightly Cron)        │
│  • Fetches URL        │         │                             │
│  • Extracts content   │         │  • Reads unprocessed items  │
│  • Summarizes         │         │  • Reads goals/milestones   │
│  • Categorizes        │         │  • Produces learning notes  │
│  • Tags               │         │  • Ranks relevance          │
│  • Stores in Library  │         │  • Pushes brief to Cortex   │
└───────────┬───────────┘         └──────────────┬──────────────┘
            │                                    │
            ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LIBRARY DATABASE                           │
│                    (library/library.sqlite)                      │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  items   │  │   tags   │  │  notes   │  │  categories   │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────────┐  │
│  │ embeddings│ │ feedback │  │  goals (snapshot from        │  │
│  │(sqlite-vec)│ │         │  │  ACTIVE-ISSUES / roadmap)    │  │
│  └──────────┘  └──────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Three-Layer Knowledge Architecture

| Layer | Source | Timing | Purpose |
|-------|--------|--------|---------|
| **Hippocampus** | Conversations | Real-time (sync) | What happened — episodic memory |
| **Library** | External links (user-curated) | Async (executor) | What exists — world knowledge |
| **Night Scholar** | Library × Goals | Nightly (cron) | What matters now — relevant knowledge |

The Hippocampus answers "what did we discuss?" The Library answers "what knowledge is available?" The Night Scholar answers "given what I know and what I'm working on, what should I pay attention to?"

---

## 4. Components

### 4.1 Librarian Executor

**Trigger:** User drops a link in chat, or explicitly says "read this", "store this", "add to library."

**Model:** Sonnet-class (cost-effective, sufficient for summarization and categorization).

**Process:**

1. Cortex detects link/intent → spawns Librarian executor via `sessions_spawn`
2. Executor fetches URL content (web_fetch or browser for JS-heavy pages)
3. Executor processes content:
   - **Title extraction** — from page metadata or content
   - **Summary** — 200-500 word distillation of key points
   - **Key concepts** — 3-7 atomic concepts extracted from the content
   - **Category assignment** — maps to system-relevant categories (see §5.2)
   - **Tag generation** — specific tags for retrieval (see §5.3)
   - **Content type classification** — article, documentation, tutorial, research, tool, skill, discussion
   - **Embedding generation** — via Ollama nomic-embed-text for semantic search
4. **Novelty check** (see §8.2) — compare embedding against existing items. If cosine similarity > 0.80 with any existing item, flag as potentially redundant.
5. Executor stores all fields in Library DB (with `novelty_score`)
6. Executor returns confirmation to Cortex:
   - Normal: "Stored: '{title}' — category: {cat}, tags: [{tags}]"
   - Redundant: "Stored: '{title}' — ⚠️ similar to existing item '{existing_title}' (similarity: {score}). Covers related ground in {category}."

**Executor Prompt (core):**

```
You are a Librarian. Your job is to read, understand, and catalog knowledge for a multi-agent system called Cortex.

Given a URL and its content:
1. Extract the title
2. Write a 200-500 word summary capturing the key ideas, not surface description
3. Extract 3-7 key concepts as atomic statements
4. Assign ONE primary category from: [architecture, tooling, skills, research, patterns, openclaw, operations, security]
5. Generate 3-10 specific tags (kebab-case)
6. Classify content type: article | documentation | tutorial | research | tool | skill | discussion
7. Rate source quality: high | medium | low (based on depth, citations, author credibility)

Focus on ACTIONABLE knowledge — what could Cortex apply, implement, or learn from?
```

**Edge Cases:**
- Paywalled content → extract what's available, flag as `partial: true`
- PDF → use pdf-parse extraction (already proven in our pipeline)
- Video/audio → extract metadata + transcript if available, flag as `media: true`
- Dead links → store with `status: dead`, retry on next Night Scholar pass
- Duplicate URLs → update existing entry, increment `version`, preserve history

### 4.2 Library Database

**Location:** `library/library.sqlite`

**Schema:**

```sql
-- Core items table
CREATE TABLE items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    key_concepts    TEXT NOT NULL,           -- JSON array of strings
    full_text       TEXT,                    -- raw extracted content (optional, for re-processing)
    category        TEXT NOT NULL,           -- primary category
    content_type    TEXT NOT NULL,           -- article|documentation|tutorial|research|tool|skill|discussion
    source_quality  TEXT DEFAULT 'medium',   -- high|medium|low
    partial         BOOLEAN DEFAULT FALSE,   -- incomplete extraction
    media           BOOLEAN DEFAULT FALSE,   -- non-text source
    status          TEXT DEFAULT 'active',   -- active|dead|archived
    version         INTEGER DEFAULT 1,       -- incremented on re-processing
    submitted_by    TEXT DEFAULT 'user',     -- who submitted: user|night-scholar|auto
    ingested_at     TEXT NOT NULL,           -- ISO 8601
    processed_at    TEXT,                    -- when Librarian finished
    last_scholar_at TEXT,                    -- last Night Scholar evaluation
    relevance_score REAL DEFAULT 0.0,        -- current relevance to goals (0.0-1.0)
    utility_score   REAL DEFAULT 0.0,        -- how often referenced/used (0.0-1.0)
    novelty_score   REAL DEFAULT 1.0,        -- 1.0 = fully novel, 0.0 = duplicate (1 - max_cosine_sim)
    most_similar_id INTEGER,                 -- id of most similar existing item (NULL if novel)
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Tags (many-to-many)
CREATE TABLE tags (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE             -- kebab-case tag
);

CREATE TABLE item_tags (
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

-- Categories (enumerated, system-aligned)
CREATE TABLE categories (
    name        TEXT PRIMARY KEY,            -- architecture|tooling|skills|research|patterns|openclaw|operations|security
    description TEXT,
    goal_refs   TEXT                         -- JSON array of related goal/issue IDs
);

-- Night Scholar learning notes
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,
    goal_ref    TEXT,                        -- which goal/issue this connects to (e.g., "#31", "executor-reliability")
    note_type   TEXT NOT NULL,               -- insight|action|pattern|warning|reference
    content     TEXT NOT NULL,               -- the learning note itself
    confidence  REAL DEFAULT 0.5,            -- scholar's confidence in relevance (0.0-1.0)
    produced_at TEXT NOT NULL,               -- when Night Scholar created this
    consumed    BOOLEAN DEFAULT FALSE,       -- has Cortex seen this?
    consumed_at TEXT                         -- when Cortex consumed it
);

-- Feedback from Cortex usage
CREATE TABLE feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,
    note_id     INTEGER REFERENCES notes(id),
    event_type  TEXT NOT NULL,               -- referenced|applied|dismissed|corrected
    context     TEXT,                        -- how it was used (brief)
    created_at  TEXT DEFAULT (datetime('now'))
);

-- Embeddings for semantic search (sqlite-vec)
CREATE VIRTUAL TABLE item_embeddings USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding float[768]                     -- nomic-embed-text dimension
);

-- Goal snapshots (Night Scholar reads these)
CREATE TABLE goal_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_at TEXT NOT NULL,
    goals       TEXT NOT NULL,               -- JSON: extracted from ACTIVE-ISSUES.md + roadmap
    milestones  TEXT                         -- JSON: current milestones/priorities
);

-- Diversity snapshots (Night Scholar produces these — §8)
CREATE TABLE diversity_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_at     TEXT NOT NULL,
    total_items     INTEGER NOT NULL,
    category_dist   TEXT NOT NULL,            -- JSON: {"architecture": 12, "tooling": 3, ...}
    tag_entropy     REAL,                     -- Shannon entropy of tag distribution (higher = more diverse)
    dominant_pct    REAL,                     -- % of items in the largest category
    gap_categories  TEXT,                     -- JSON: categories with < 5% representation
    alert           BOOLEAN DEFAULT FALSE,   -- TRUE if dominant_pct > 60% or tag_entropy below threshold
    notes           TEXT                      -- Scholar's diversity assessment
);
```

**Indexes:**

```sql
CREATE INDEX idx_items_category ON items(category);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_relevance ON items(relevance_score DESC);
CREATE INDEX idx_items_ingested ON items(ingested_at);
CREATE INDEX idx_notes_consumed ON notes(consumed);
CREATE INDEX idx_notes_goal ON notes(goal_ref);
CREATE INDEX idx_feedback_item ON feedback(item_id);
```

### 4.3 Night Scholar

**Trigger:** Nightly cron (3:30 AM, after code index rebuild at 3:00 AM).

**Model:** Sonnet-class. Smart enough to connect dots across domains, cheap enough to run nightly.

**Process:**

```
Phase 1: Ingest Context
  → Read ACTIVE-ISSUES.md (current open issues, priorities)
  → Read PURPOSE.md (system goals)
  → Read recent memory/YYYY-MM-DD.md (last 3 days — what's active)
  → Snapshot goals into goal_snapshots table

Phase 2: Evaluate Library Items
  → Query items WHERE:
     last_scholar_at IS NULL                     (never evaluated)
     OR last_scholar_at < date('now', '-7 days') (stale evaluation)
     OR relevance_score > 0.5                    (high-relevance items get re-evaluated more often)
  → For each item:
     a. Read summary + key_concepts + tags
     b. Score relevance against current goals (0.0-1.0)
     c. Update relevance_score
     d. Update last_scholar_at

Phase 3: Produce Learning Notes
  → For items with relevance_score >= 0.4:
     a. Generate learning note connecting item to specific goal/issue
     b. Classify note type: insight|action|pattern|warning|reference
     c. Rate confidence (0.0-1.0)
     d. Store in notes table

Phase 4: Produce Daily Brief
  → Collect all new notes (consumed = FALSE)
  → Group by goal/issue
  → Produce brief:
     "Overnight study: {n} items reviewed, {m} relevant to current work.
      
      ## {goal_1}
      - [{item_title}]: {note_content} (confidence: {x})
      
      ## {goal_2}
      - [{item_title}]: {note_content} (confidence: {x})
      
      No action needed: {k} items archived (relevance dropped below threshold)."
  → Deliver brief via cron system event to Cortex session

Phase 5: Diversity Audit (see §8)
  → Compute category distribution across all active items
  → Calculate Shannon entropy of tag distribution
  → Compute dominant_pct (% of items in largest category)
  → Identify gap_categories (categories with < 5% representation)
  → Store diversity_snapshot
  → If dominant_pct > 60% OR tag_entropy below threshold:
     alert = TRUE → include diversity warning in brief:
     "⚠️ Knowledge imbalance: {dominant_pct}% of Library is {category}. 
      Under-represented: [{gap_categories}]. Consider curating links in these areas."

Phase 6: Maintenance
  → Items with relevance_score < 0.1 for 30+ days → status = 'archived'
  → Dead links → retry fetch, update status
  → Utility decay: utility_score *= 0.95 (weekly decay if unreferenced)
```

**Scholar Prompt (core):**

```
You are the Night Scholar. You connect external knowledge to internal goals.

Given:
- A library item (summary, concepts, tags, category)
- Current system goals and open issues
- Recent activity (last 3 days of memory)

Your job:
1. Score this item's relevance to current goals (0.0-1.0)
2. If relevant (≥0.4), write a learning note that:
   - Names the specific goal or issue it connects to
   - Explains WHY it's relevant (not just THAT it's relevant)
   - Extracts the actionable insight
   - Notes any caveats or limitations
3. Classify the note: insight (new understanding), action (something to do), 
   pattern (reusable approach), warning (pitfall to avoid), reference (useful to keep)

Be precise. "This might be useful" is not a learning note.
"This describes one-for-all supervisor restart strategies, which addresses the open 
question in issue #31 about what happens when executor A fails mid-task while executor B 
depends on A's output" IS a learning note.
```

### 4.4 Cortex Integration

**Ingestion (link detection):**

Cortex needs a lightweight mechanism to detect when the user shares a link with learning intent. Not every URL should go to the Library — only those the user intends as learning material.

Detection heuristics:
- Explicit: "read this", "store this", "add to library", "learn from this", "check this out"
- Contextual: link shared during discussion about architecture, tooling, or capabilities
- Ambiguous: bare link without context → ask "Should I add this to the Library?"

**Consumption (learning briefs):**

When Cortex starts a new session and unconsumed notes exist:
1. Query `notes WHERE consumed = FALSE ORDER BY confidence DESC LIMIT 10`
2. Inject as system context: "📚 Library update: {brief}"
3. Mark consumed notes as `consumed = TRUE, consumed_at = now()`

This is analogous to how Hippocampus facts appear in system prompt — but these are curated, goal-linked insights rather than raw conversation extracts.

**Feedback (usage tracking):**

When Cortex references a library item in conversation (mentions it, applies an insight, or cites it):
1. Log a `feedback` entry with `event_type = 'referenced'` or `'applied'`
2. Increment the item's `utility_score`
3. Items with high utility get re-evaluated more frequently by the Night Scholar

When Cortex or user explicitly dismisses an item ("that's not relevant"):
1. Log `feedback` with `event_type = 'dismissed'`
2. Decrease `relevance_score` and `utility_score`

---

## 5. Taxonomy

### 5.1 Content Types

| Type | Description | Example |
|------|-------------|---------|
| `article` | Blog post, essay, opinion piece | "Why Erlang's Supervisor Trees Matter" |
| `documentation` | Official docs, API references | OpenClaw plugin development guide |
| `tutorial` | Step-by-step guide | "Building a Custom Skill for OpenClaw" |
| `research` | Academic paper, formal study | SAGE Paper 4 (Longitudinal Learning) |
| `tool` | Software tool, library, package | "sqlite-vec: Vector Search for SQLite" |
| `skill` | OpenClaw skill, ClawHub package | "librariant skill on ClawHub" |
| `discussion` | Forum thread, GitHub issue, conversation | "Discussion: BFT consensus in multi-agent systems" |

### 5.2 Categories (System-Aligned)

Categories map to the system's domains, not generic topics. Each category has goal references that link to ACTIVE-ISSUES.md entries or roadmap milestones.

| Category | Scope | Example Goal Refs |
|----------|-------|-------------------|
| `architecture` | System design, patterns, distributed systems | #31 (executor isolation), executor-architecture-v2 |
| `tooling` | Developer tools, CLI, debugging, monitoring | #32 (token monitor), code-search |
| `skills` | OpenClaw skills, ClawHub ecosystem, capabilities | Skill development, ClawHub publishing |
| `research` | Papers, studies, formal analysis | SAGE papers, multi-agent research |
| `patterns` | Reusable design patterns, best practices | Actor model, supervision trees, event sourcing |
| `openclaw` | OpenClaw-specific: plugins, gateway, cortex, router | Cortex context fixes, channel routing |
| `operations` | Deployment, monitoring, backup, infrastructure | Gateway stability, backup automation |
| `security` | Auth, encryption, access control, threat models | #7 (DNA patch), #10 (Immune System) |

### 5.3 Tag Conventions

Tags are kebab-case, specific, and composable:

```
# Good tags (specific, searchable):
process-isolation, erlang-supervisors, bft-consensus, sqlite-vec,
embedding-dedup, context-window, token-optimization, fault-tolerance,
actor-model, ipc-protocol, knowledge-retrieval, prompt-engineering

# Bad tags (too generic):
ai, programming, systems, good-article
```

Tags are reusable across items. The Night Scholar can query by tag to find related items across categories.

---

## 6. Data Flow Examples

### 6.1 User Drops a Link

```
User: "Check this out — https://example.com/erlang-supervisor-patterns"

Cortex: "Adding to the Library. I'll have the Librarian process it."
  → sessions_spawn(executor=librarian, task="Process URL: https://...")

[Background, 15-30 seconds]
Librarian:
  → web_fetch(url)
  → Summarizes: "Comprehensive guide to Erlang OTP supervisor strategies..."
  → Concepts: ["one-for-one restart", "one-for-all restart", "rest-for-one", "supervision tree depth"]
  → Category: architecture
  → Tags: [erlang-supervisors, fault-tolerance, actor-model, process-isolation, restart-strategies]
  → Content type: article
  → Quality: high
  → INSERT INTO items(...)
  → Generate embedding → INSERT INTO item_embeddings(...)

Cortex: "📚 Stored: 'Erlang OTP Supervisor Patterns' — architecture, 
         tagged: erlang-supervisors, fault-tolerance, actor-model"
```

### 6.2 Night Scholar Evaluation

```
[3:30 AM Cron]
Night Scholar wakes up:
  → Reads ACTIVE-ISSUES.md:
     #31 (process-isolated executors) — HIGH priority
     #22 (fact dedup) — MEDIUM
     #6 (image attachments) — LOW

  → Reads recent memory: 2026-03-08, 09, 10
     Active work: executor architecture v2, cortex context fixes

  → Evaluates 'Erlang OTP Supervisor Patterns' (ingested yesterday):
     relevance_score = 0.85 (directly connects to #31)

  → Produces learning note:
     goal_ref: "#31"
     note_type: "pattern"
     content: "Erlang's 'rest-for-one' strategy restarts the failed child and all 
              children started AFTER it. This is relevant to executor-architecture-v2 
              §3.2 (supervision): if executor B was spawned to handle a sub-task of 
              executor A's work, and A crashes, B's work is orphaned. A rest-for-one 
              strategy would automatically clean up B. Current design uses one-for-one 
              (only restart the failed executor), which doesn't handle this dependency case."
     confidence: 0.82

  → Produces brief:
     "📚 Overnight study: 4 items reviewed, 2 relevant.
      
      ## #31 — Process-Isolated Executors
      - [Erlang OTP Supervisor Patterns]: rest-for-one restart strategy 
        addresses executor dependency chains. Consider for §3.2. (confidence: 0.82)
      
      ## #22 — Fact Dedup
      - [Vector Similarity in Practice]: cosine vs dot-product for 
        nomic-embed-text embeddings. Cosine is standard but dot-product 
        may be faster for normalized vectors. (confidence: 0.61)"

  → Delivers brief via system event to Cortex
```

### 6.3 Cortex References Library Item

```
[Next day conversation]
User: "For the executor supervision, should we use one-for-one or something else?"

Cortex: "The Library has a relevant item on this. Erlang's OTP defines three 
         strategies: one-for-one (restart only the crashed child), one-for-all 
         (restart all children), and rest-for-one (restart the crashed child and 
         everything started after it). For our executors, rest-for-one makes sense 
         when executor B depends on A's output — if A dies, B's work is orphaned anyway."

  → Feedback logged: event_type='applied', item_id=<erlang article>, 
    context="Used in executor supervision design decision"
  → utility_score += 0.2
```

---

## 7. Integration with Existing Systems

### 7.1 Hippocampus

The Library and Hippocampus are complementary, not competing:

- **Hippocampus** extracts facts from conversations (reactive, episodic)
- **Library** stores curated external knowledge (proactive, semantic)

They share infrastructure:
- Both use `nomic-embed-text` for embeddings
- Both use `sqlite-vec` for vector search
- Both feed into Cortex's system context

They differ in lifecycle:
- Hippocampus facts are auto-extracted, high volume, short-lived (Gardener prunes)
- Library items are human-curated, lower volume, long-lived (Night Scholar re-evaluates)

### 7.2 Hot Memory

Hot memory currently serves top-50 facts by hit count/recency. Library learning notes are a separate channel — they don't compete with hot memory slots. They appear as a distinct "📚 Library" section in Cortex context, after hot memory facts.

### 7.3 Code Search

The Night Scholar can use `code_search` to validate whether a library item's concepts are already implemented in the codebase. Example: if a library item describes "embedding dedup with cosine similarity," the Scholar can check if this pattern already exists in the code, adjusting the relevance score accordingly.

### 7.4 ACTIVE-ISSUES.md

The Night Scholar reads ACTIVE-ISSUES.md as its goal source. When issues are moved to DONE, associated library items lose their goal reference and their relevance score decays naturally. New issues create new goal targets for the Scholar to match against.

---

## 8. Echo Chamber Mitigations

SAGE Paper 2 (§4.5.3) documented a critical failure mode: when all observations in institutional memory describe the same approach, agents stop exploring alternatives. All 20 sequential SAGE runs generated Padding Oracle variants because the memory only contained Padding Oracle observations — a positive feedback loop where past behavior amplifies itself. A 40-line guided prompt with echo-chamber memory performed *worse* than an 8-line minimal prompt with the same bad memory (gap 0.49 vs 0.43).

Their mitigations (knowledge seeding + novelty-aware summarization) apply directly to our Library. We implement three complementary defenses.

### 8.1 Diversity Monitor

The Night Scholar tracks the distribution of knowledge across categories and tags on every nightly pass.

**Metrics:**

| Metric | Formula | Alert Threshold |
|--------|---------|-----------------|
| Dominant category % | `max(category_count) / total_items` | > 60% |
| Tag entropy | Shannon entropy of tag frequency distribution | < 2.0 bits |
| Gap categories | Categories with < 5% representation | Any system-relevant category missing |
| Novelty rate | % of items ingested in last 30 days with `novelty_score > 0.5` | < 30% (too much redundancy) |

**Shannon entropy** measures the evenness of tag distribution. A Library where all items share the same 3 tags has low entropy (echo chamber). A Library with diverse, spread-out tags has high entropy (healthy diversity). Formula: `H = -Σ p(tag) × log₂(p(tag))` where `p(tag)` is the frequency of each tag across all items.

**When alerts trigger:**

The Night Scholar includes a diversity warning in its brief to Cortex:

```
⚠️ Knowledge imbalance detected:
- 67% of Library items are in 'architecture' (threshold: 60%)
- Under-represented categories: security (2%), operations (0%)
- Tag entropy: 1.8 bits (threshold: 2.0)
- Suggestion: consider curating links in security, operations, and patterns
```

This is a nudge to the user, not an automatic fix. The human quality gate (user chooses what links to submit) is the primary diversity mechanism. The monitor makes the imbalance visible.

### 8.2 Novelty Checking on Ingestion

The Librarian executor computes a **novelty score** for every new item before storage.

**Process:**

1. Generate embedding for the new item (nomic-embed-text, 768-dim)
2. Query `item_embeddings` for the top-3 most similar existing items (cosine similarity)
3. Compute `novelty_score = 1.0 - max_cosine_similarity`
4. Store `most_similar_id` — the ID of the most similar existing item

**Novelty thresholds:**

| novelty_score | Interpretation | Action |
|---------------|----------------|--------|
| > 0.5 | Fully novel | Store normally |
| 0.2 – 0.5 | Related to existing | Store + inform: "Similar to '{existing_title}'" |
| < 0.2 | Near-duplicate | Store + warn: "⚠️ Very similar to '{existing_title}' — covers same ground" |

**Key design decision:** We always store, never reject. The user decided this link is worth reading — we respect that. But we surface the redundancy so the user and Night Scholar can make informed decisions. Items with `novelty_score < 0.2` get lower priority in Night Scholar evaluation.

**Example:**

```
User drops: https://example.com/more-erlang-supervisor-patterns

Librarian: "📚 Stored: 'Advanced Erlang Supervisor Strategies'
           — architecture, tags: erlang-supervisors, fault-tolerance, otp
           ⚠️ Similar to existing item 'Erlang OTP Supervisor Patterns' (similarity: 0.84)
           Covers related ground. The new item adds: hot code loading during supervision."
```

The Librarian should note what the NEW item adds beyond the existing one — the delta, not just the overlap. This prevents the Library from becoming a collection of redundant summaries.

### 8.3 Night Scholar Diversity Weighting

The Night Scholar adjusts its relevance scoring based on Library diversity:

**Over-represented categories get penalized:**

```
adjusted_relevance = base_relevance × diversity_factor

Where:
  diversity_factor = 1.0                    if category_pct < 30%
  diversity_factor = 0.8                    if category_pct 30-50%
  diversity_factor = 0.6                    if category_pct 50-70%
  diversity_factor = 0.4                    if category_pct > 70%
```

This means if 65% of the Library is "architecture" items, an architecture item needs a base relevance of 0.67 to reach the 0.4 threshold for learning note generation — while a "security" item (5% of Library) would need only 0.4. This naturally pushes the Night Scholar toward under-represented but relevant knowledge.

**Under-represented categories get boosted in briefs:**

When the Night Scholar produces learning notes for items in gap categories (< 5% representation), it adds a marker:

```
## #10 — Immune System
- [🔍 UNDEREXPLORED] [Security Hardening Patterns]: This item covers threat modeling 
  approaches that connect to the Immune System design. The Library has minimal security 
  coverage — this is one of only 2 items in the security category. (confidence: 0.55)
```

The `🔍 UNDEREXPLORED` marker signals to both Cortex and the user that this is a knowledge gap worth filling.

### 8.4 Connection to SAGE Findings

| SAGE Paper 2 Finding | Our Mitigation |
|---|---|
| Echo chamber: all 20 runs generated Padding Oracle | Diversity monitor alerts when any category > 60% |
| Knowledge diversity > prompt detail | Novelty checking ensures new items add genuine delta |
| Knowledge seeding breaks echo chambers | User curation is our primary seeding mechanism; gap category surfacing encourages diverse seeding |
| Novelty-aware summarization prevents redundant observations | Librarian computes novelty_score, surfaces overlap to user |
| BFT consensus filters cross-domain contamination | Category assignment + Night Scholar diversity weighting serves as lightweight equivalent |

**Our natural advantage:** SAGE's echo chamber formed because agents automatically submitted observations — no human filter. Our Library has a human quality gate (user selects links). The diversity monitor and novelty checking are safety nets for the scenario where the user's interests naturally cluster (e.g., reading 10 articles about executors during an executor implementation sprint). That clustering is appropriate in the short term but harmful if it persists — the monitor makes it visible before it becomes an echo chamber.

---

## 9. Feedback & Learning Dynamics

### 8.1 Relevance Score

The relevance score (0.0-1.0) reflects how connected an item is to current goals. It's dynamic — recalculated by the Night Scholar on each evaluation pass.

```
relevance_score = f(goal_match, recency, utility_history)

Where:
  goal_match   = semantic similarity between item concepts and current goals
  recency      = time decay (newer items start higher)
  utility_history = cumulative feedback signal
```

### 8.2 Utility Score

The utility score (0.0-1.0) reflects how much Cortex actually uses an item. It's driven entirely by feedback events.

```
Events:
  referenced → +0.1
  applied    → +0.2
  dismissed  → -0.3
  corrected  → -0.1 (item had errors, still somewhat useful)

Decay:
  utility_score *= 0.95 (weekly, if no new events)
```

### 8.3 Promotion & Archival

- Items with `utility_score > 0.5` are promoted: Night Scholar re-evaluates them weekly instead of monthly
- Items with `relevance_score < 0.1` for 30+ consecutive days are archived
- Archived items remain in the DB but are excluded from Night Scholar passes and Cortex briefs
- Archived items can be resurrected if a new goal matches their tags/concepts

### 8.4 The Learning Loop

```
        ┌──────────────┐
        │  User curates │ ← Human quality gate
        │  (drops link) │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  Librarian    │ ← Processes & stores
        │  (executor)   │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  Library DB   │ ← Structured knowledge
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ Night Scholar │ ← Connects to goals
        │  (nightly)    │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │   Cortex      │ ← Consumes & applies
        │  (learning    │
        │   briefs)     │
        └──────┬───────┘
               │
               ▼
        ┌──────────────┐
        │  Feedback     │ ← Usage signal
        │  (referenced/ │
        │   applied/    │
        │   dismissed)  │
        └──────┬───────┘
               │
               └──────────► Back to Night Scholar
                            (utility scores updated,
                             relevance re-evaluated)
```

This is a **closed-loop supervised learning system**:
1. The teacher (user) selects the curriculum (links)
2. The student (Cortex) studies the material (via Librarian + Night Scholar)
3. The student applies knowledge in practice (conversations, decisions)
4. Application generates feedback (referenced/applied/dismissed)
5. Feedback refines what the student studies next (relevance re-ranking)

---

## 10. Implementation Phases

### Phase 1: Foundation (Library DB + Librarian Executor)
**Effort:** 2-3 sessions

- [ ] Create `library/library.sqlite` with schema from §4.2
- [ ] Create Librarian executor prompt
- [ ] Implement link detection in Cortex (simple keyword matching initially)
- [ ] Wire Cortex → `sessions_spawn` → Librarian executor → Library DB
- [ ] Return confirmation to Cortex after storage
- [ ] Generate embeddings via Ollama nomic-embed-text on ingestion
- [ ] Implement novelty checking on ingestion (§8.2) — cosine similarity against existing items

**Deliverable:** User can drop a link, Cortex spawns Librarian, item appears in DB with summary, tags, category, and novelty score.

### Phase 2: Night Scholar (Nightly Evaluation + Learning Notes)
**Effort:** 2-3 sessions

- [ ] Create Night Scholar cron job (3:30 AM, after code index)
- [ ] Implement goal snapshot from ACTIVE-ISSUES.md
- [ ] Implement item evaluation loop (relevance scoring)
- [ ] Implement learning note generation
- [ ] Implement diversity audit (§8.1) — category distribution, tag entropy, gap categories
- [ ] Implement diversity weighting in relevance scoring (§8.3)
- [ ] Implement daily brief production (including diversity warnings when triggered)
- [ ] Deliver brief via system event to Cortex

**Deliverable:** Night Scholar runs nightly, produces learning notes with diversity awareness, delivers brief to Cortex.

### Phase 3: Cortex Consumption (Briefs in Context)
**Effort:** 1-2 sessions

- [ ] Add Library brief injection to Cortex context builder
- [ ] Unconsumed notes appear as "📚 Library" section
- [ ] Mark notes as consumed after Cortex sees them
- [ ] Limit to top-10 notes per session (by confidence × relevance)

**Deliverable:** Cortex wakes up with Library insights in its context.

### Phase 4: Feedback Loop (Usage Tracking)
**Effort:** 1-2 sessions

- [ ] Detect when Cortex references library items in responses
- [ ] Log feedback events (referenced/applied/dismissed)
- [ ] Update utility scores based on feedback
- [ ] Night Scholar uses utility in relevance calculation

**Deliverable:** Closed-loop learning — items that Cortex uses get promoted.

### Phase 5: Maintenance & Polish
**Effort:** 1 session

- [ ] Implement relevance decay and archival
- [ ] Dead link retry logic
- [ ] Duplicate URL handling (update, not duplicate)
- [ ] Library CLI for manual queries (`library search "supervisor patterns"`)
- [ ] Dashboard/stats for library health

**Deliverable:** Self-maintaining library with lifecycle management.

---

## 11. Cost Estimates

### Per-Link Ingestion (Librarian Executor)
- web_fetch: free
- Sonnet summarization: ~2K input + ~1K output = ~$0.01
- Embedding + novelty check (sqlite-vec cosine query): free (local Ollama + local DB)
- **Total: ~$0.01 per link**

### Nightly Scholar Run
- Goal context: ~2K tokens
- Per-item evaluation: ~1K input + ~500 output
- Diversity audit: ~1K tokens (computed from DB, minimal LLM use)
- 20 items/night average: ~30K input + ~10K output = ~$0.15
- **Monthly: ~$4.50**

### Cortex Context Addition
- 10 learning notes ≈ 2K additional tokens in system prompt
- Marginal cost increase per Cortex turn: negligible

### Total Estimated Monthly Cost
- 30 links/month × $0.01 = $0.30 (ingestion)
- 30 nights × $0.15 = $4.50 (scholar)
- **~$5/month** for continuous learning pipeline

---

## 12. References

### Direct Inspirations

1. **SAGE Paper 2** — Kannabhiran, D.A. (2026). "Consensus-Validated Memory Improves Agent Performance on Complex Tasks." DOI: 10.5281/zenodo.18856774. Repository: github.com/l33tdawg/sage
   - Key finding: 40% lower calibration error (Cohen's d = −0.824, LARGE); 100% quality consistency; variance collapse as institutional learning signature. **Critical:** documents echo chamber failure mode — memory converges to single dominant pattern without diversity controls. Knowledge diversity outweighs prompt detail. 18-line onboarding prompt + diverse seeded memory achieved only perfect calibration (gap = 0.0) across all experiments.

2. **SAGE Paper 3** — Kannabhiran, D.A. (2026). "Institutional Memory as Organizational Knowledge: AI Agents That Learn Their Jobs from Experience, Not Instructions." DOI: 10.5281/zenodo.18856845. Repository: github.com/l33tdawg/sage
   - Key finding: Prompt engineering is a transitional practice. 11 agents with 3-line prompts + institutional memory produced 93.0/100 quality, closed feedback loop (design → exploitation → learning), zero human intervention. Knowledge as infrastructure, not configuration. Maps to Nonaka's SECI organizational knowledge cycle.

3. **SAGE Paper 4** — Kannabhiran, D.A. (2026). "Longitudinal Learning in Governed Multi-Agent Systems: How Institutional Memory Improves Agent Performance Over Time." DOI: 10.5281/zenodo.18888597. Repository: github.com/l33tdawg/sage
   - Key finding: BFT-consensus institutional memory enables longitudinal learning (ρ=0.716); knowledge quality and domain tagging are critical; misclassified entries cause catastrophic regression.

4. **Zettelkasten Method** — Luhmann, N. (1981). "Kommunikation mit Zettelkästen."
   - Atomic notes, tagged, linked. The Library is the slip box; the Night Scholar performs the linking step. See also: Ahrens, S. (2017). "How to Take Smart Notes."
   - Reference: https://zettelkasten.de/introduction/

5. **Spaced Repetition / Leitner System** — Leitner, S. (1972). "So lernt man lernen."
   - Relevant items resurface based on utility and relevance, not just recency. High-utility items are reviewed more frequently.

### Architectural Patterns

6. **Actor Model with Supervision** — Hewitt, C., Bishop, P., Steiger, R. (1973). "A Universal Modular ACTOR Formalism for Artificial Intelligence." + Armstrong, J. (2003). "Making Reliable Distributed Systems in the Presence of Software Errors" (Erlang OTP thesis).
   - The Night Scholar is a supervisor of knowledge — it monitors, evaluates, and promotes/demotes items based on their health (relevance).

7. **Curriculum Learning** — Bengio, Y., Louradour, J., Collobert, R., Weston, J. (2009). "Curriculum Learning." ICML.
   - Training on progressively more complex examples improves learning. The user curates the curriculum; the system controls pacing via relevance scoring.

8. **Retrieval-Augmented Generation (RAG)** — Lewis, P. et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks."
   - The Library is a structured RAG store with human curation and goal-aware retrieval, rather than naive similarity search.

9. **Nonaka's SECI Model** — Nonaka, I. (1994). "A Dynamic Theory of Organizational Knowledge Creation." Organization Science 5.1.
   - Socialization → Externalization → Combination → Internalization. The Library implements this cycle: user reads (socialization), Librarian processes (externalization), Library stores (combination), Night Scholar feeds Cortex (internalization). Referenced extensively in SAGE Paper 3.

10. **Ostrom's Commons Governance** — Ostrom, E. (1990). "Governing the Commons: The Evolution of Institutions for Collective Action." Cambridge University Press.
    - Institutional rules for managing shared resources. The Library is a governed knowledge commons — the Night Scholar and diversity monitor serve as the institutional rules that prevent tragedy of the commons (echo chambers, knowledge pollution).

11. **Filter Bubble Effect** — Pariser, E. (2011). "The Filter Bubble: What the Internet Is Hiding from You." Penguin Press.
    - The echo chamber in SAGE Paper 2 is a filter bubble: agents query memory → get dominant pattern → generate same pattern → reinforce dominant pattern. Our diversity monitor (§8.1) and novelty checking (§8.2) are anti-filter-bubble mechanisms.

### System Design

12. **Hippocampus Architecture** — Internal document (`docs/hipocampus-architecture.md`).
    - Existing memory system that the Library complements. Shares embedding infrastructure.

13. **Executor Architecture v2** — Internal document (`docs/executor-architecture-v2.md`).
    - The Librarian runs as an executor. Process isolation, IPC protocol, and supervision patterns apply.

14. **ACTIVE-ISSUES.md** — Internal document (`docs/working/ACTIVE-ISSUES.md`).
    - Goal source for the Night Scholar. Issues and priorities drive relevance scoring.

---

## 13. Open Questions

1. **Should the Night Scholar have write access to ACTIVE-ISSUES.md?** It could suggest new issues based on library items (e.g., "This article describes a vulnerability pattern that isn't in our threat model"). Or it should only read, and suggestions go through the brief.

2. **Should Cortex be able to self-submit links?** When Cortex encounters a relevant URL during conversation (user shares it casually, or it appears in search results), should it auto-submit to Library without explicit user intent?

3. **Multi-modal items.** The schema supports `media: true` but the Librarian prompt is text-focused. Video tutorials, podcasts, and diagrams need different processing strategies.

4. **Library sharing.** If multiple OpenClaw instances exist (or multiple users), should the Library be shareable? A team library where one person's curation benefits everyone.

5. **Goal evolution tracking.** The goal_snapshots table captures point-in-time goals, but doesn't track how goals evolved. Should the Night Scholar observe goal trajectories (new issues, closed issues, priority changes) and adjust its learning strategy accordingly?

---

*This document is a living specification. It will evolve as implementation progresses and real usage patterns emerge.*
