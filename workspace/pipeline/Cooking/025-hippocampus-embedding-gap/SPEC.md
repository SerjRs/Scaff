---
id: "025"
title: "Hippocampus Embedding Gap — Backfill + Code Fix + Test Coverage"
created: "2026-03-16"
author: "scaff"
priority: "critical"
status: "cooking"
depends_on: ["023"]
---

# 025 — Hippocampus Embedding Gap

## Problem

**6,655 out of 6,665 hippocampus facts have no embeddings.** Only the 10 most recent facts (from today's live Gardener extraction) have entries in `hippocampus_facts_vec`. Every `memory_query` vector search returns the same 10 results regardless of query — making the entire Hippocampus recall system useless.

### Root Cause

Two code paths insert facts into `hippocampus_facts` **without generating embeddings**:

1. **Backfill script** (`scripts/library-to-graph.ts`) — uses its own local `insertFact()` (line 75) that writes to `hippocampus_facts` but never calls Ollama for embeddings and never writes to `hippocampus_facts_vec`. This function is a copy-paste of the real one, minus the embedding logic.

2. **Library URL ingestion** (`src/cortex/gateway-bridge.ts`, lines 396–441) — calls `hippo.insertFact()` directly instead of `hippo.dedupAndInsertGraphFact()`. Facts and edges are created correctly, but no embeddings are generated.

### What Works

The **Gardener's `runFactExtractor()`** (in `src/cortex/gardener.ts`, line 248) correctly calls `dedupAndInsertGraphFact(db, fact, "conversation", embedFn)` with an `embedFn` parameter. This path generates embeddings via Ollama `nomic-embed-text` and inserts into both `hippocampus_facts` and `hippocampus_facts_vec`. Live conversation facts are properly searchable.

### Evidence

```
=== Vec coverage ===
Facts WITH cold_vector_id: 0
Facts WITHOUT cold_vector_id: 6665
Vec rowids count: 10    ← only today's 10 conversation facts

=== Vec rowids ===
rowid: 6656 through 6665  ← sequential, all from today's Gardener run
```

Every `memory_query` returns: `"Task 011 addresses 4 root causes: async dispatch with no text fallback, sync loop text guard, sync tool dedup, and code_search path hints"` — because it's one of the only 10 facts with an embedding.

### Impact

- Cortex cannot recall any backfilled knowledge (6,655 facts invisible to vector search)
- Library URL ingestion produces unsearchable facts
- `memory_query` tool returns garbage for every query
- Cortex fabricated excuses about "file reads truncating" when it couldn't find answers (behavioral symptom of broken recall)

---

## How This Was Missed

### 1. Spec design gap (017e)

Task **017e** ("Article ingestion to graph") designed the Library → Hippocampus path. The spec explicitly called for `insertFact()` — the raw, low-level function:

> *"Insert each extracted fact into `hippocampus_facts` with `source_type='article'`"*

No mention of `dedupAndInsertGraphFact()`, no mention of embeddings, no mention of `hippocampus_facts_vec`. The spec was written with only graph structure in mind, not search/retrieval.

Meanwhile **017d** (conversation facts) correctly specified `dedupAndInsertGraphFact()` with `embedFn`. The Library path was designed as a simpler "just store the structure" operation without considering that facts need to be *findable*, not just *present*.

### 2. Tests only verify rows, never embeddings (019f)

All 6 Library→Graph tests (Category F in `e2e-hippocampus-full.test.ts`) call `insertFact()` directly and assert:

```typescript
// F1: Article ingestion creates source node + facts + edges
expect(countRows("hippocampus_facts")).toBe(3);  // ← rows exist? ✅
expect(countRows("hippocampus_edges")).toBe(3);   // ← edges exist? ✅
// But NEVER checks: hippocampus_facts_vec has entries? ❌
```

Not a single test checks `hippocampus_facts_vec`. They verify the graph structure exists but never verify the facts are *searchable*. It's like testing that you shelved books but never updating the catalog index.

### 3. E2E tests used mocked LLMs (020d)

- E1/E2: Test system floor (top-N by hit_count — no vec search needed)
- E3: Tests Gardener extraction (conversation path — works correctly)
- E4: Tests `memory_query` — but used mocked `callLLM`, so it never actually ran a vector search against real data with mixed sources

### 4. No end-to-end Library→Search test exists

**187 total tests** and not one exercises the full path: *Library URL → Librarian extraction → fact insertion → embedding → vec index → memory_query → retrieval*. Each layer was tested in isolation. The gap lives in the seam between Library ingestion and Hippocampus search.

### 5. Backfill script has its own `insertFact()` copy

`scripts/library-to-graph.ts` doesn't import from `src/cortex/hippocampus.ts`. It defines its own local `insertFact()` (line 75) that's a simplified copy — same SQL INSERT, but no embedding logic. When the script ran and produced 6,655 facts, they all went in without embeddings.

---

## Fix — Four Parts

### Part A: Backfill embeddings for existing 6,655 facts (batch job)

Write a script that:
1. Queries all `hippocampus_facts` rows that have no corresponding entry in `hippocampus_facts_vec` (LEFT JOIN on rowid, WHERE vec.rowid IS NULL)
2. For each fact, calls Ollama `nomic-embed-text` at `127.0.0.1:11434` to generate a 768-dim embedding
3. Inserts into `hippocampus_facts_vec` with matching rowid
4. Progress logging every 100 facts
5. Retry with backoff on Ollama failure (max 3 retries per fact)
6. Checkpointing: track last processed rowid so script can resume after crash

**Estimated time**: 6,655 facts × ~50ms = ~5.5 minutes

**Script location**: `scripts/backfill-embeddings.ts`

**Important**: `sqlite-vec` extension is only available inside the gateway process. The script must either:
- Run inside the gateway (Gardener task or admin endpoint), OR
- Load `sqlite-vec` manually (check how the gateway does it in `src/cortex/hippocampus.ts`), OR
- Use the existing `hippocampus.ts` functions which handle vec table init

**Verification**:
```sql
-- Before: 10 rows
SELECT count(*) FROM hippocampus_facts_vec_rowids;
-- After: should equal active fact count
SELECT count(*) FROM hippocampus_facts WHERE status = 'active';
```

### Part B: Fix Library ingestion path in gateway-bridge.ts (code fix)

**File**: `src/cortex/gateway-bridge.ts`, lines 396–441

**Current** (broken — no embeddings):
```typescript
// Line 411: direct insertFact, no embedding
const factId = hippo.insertFact(instance.db, {
  factText: f.text.trim(),
  factType: f.type ?? "fact",
  confidence: f.confidence ?? "medium",
  sourceType: "article",
  sourceRef: `library://item/${itemId}`,
});
```

**Fixed** (uses dedupAndInsertGraphFact with embedFn):
```typescript
const { factId } = await hippo.dedupAndInsertGraphFact(
  instance.db,
  { id: f.id, text: f.text.trim(), type: f.type ?? "fact", confidence: f.confidence ?? "medium" },
  "article",
  embedFn,  // Ollama nomic-embed-text — same function used by Gardener
);
```

**Changes required**:
1. The Library ingestion handler block must become `async` (it's inside a sync block currently)
2. Import or construct an `embedFn` — the Gardener already has one, likely constructed in the gateway bridge init. Find how `embedFn` is passed to `runFactExtractor` and reuse the same function.
3. The source article node (`"Article: ${parsed.title}"`) should also get an embedding via `insertFact()` with `embedding` parameter
4. Handle `sourceRef` — `dedupAndInsertGraphFact` doesn't currently accept `sourceRef`. Either:
   - Extend the function signature to accept optional `sourceRef`/`sourceType` overrides, OR
   - Call `insertFact()` with embedding for the source node, `dedupAndInsertGraphFact()` for content facts, then manually update `source_ref` after

### Part C: Fix backfill script for future use

**File**: `scripts/library-to-graph.ts`

- Delete the local `insertFact()` function (line 75)
- Import `dedupAndInsertGraphFact` from `src/cortex/hippocampus.ts`
- Construct an `embedFn` using Ollama (same pattern as Gardener)
- Replace all `insertFact()` calls with `dedupAndInsertGraphFact()` calls
- This ensures any future re-runs produce properly embedded facts

### Part D: Add integration tests that verify embeddings exist after ingestion

**File**: `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — new tests in Category F

Add tests that verify the full path including vec index:

```typescript
// F7. Article facts are searchable via vector similarity
it("F7. article facts are searchable via vec", async () => {
  // Insert fact WITH embedding (using real Ollama)
  const embedding = await embedFn("SQLite is an embedded database");
  insertFact(db, {
    factText: "SQLite is an embedded database",
    sourceType: "article",
    sourceRef: "library://item/test1",
    embedding,  // ← this is what was missing
  });

  // Search should find it
  const results = searchGraphFacts(db, await embedFn("embedded database engine"), 5);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].fact_text).toContain("SQLite");
});

// F8. Memory query finds library-ingested facts
it("F8. memory_query returns library facts", async () => {
  // Insert fact with embedding
  // Run memory_query
  // Verify library fact appears in results
});
```

Also add to Category I (Memory Query):

```typescript
// I5. memory_query finds facts from all source types
it("I5. memory_query returns facts from conversation + article + backfill sources", async () => {
  // Insert facts from 3 different source_types, all with embeddings
  // Run memory_query
  // Verify results include facts from all sources
});
```

---

## Data Model Reference

```sql
-- Facts table
hippocampus_facts (
  id TEXT PRIMARY KEY,
  fact_text TEXT NOT NULL,
  fact_type TEXT DEFAULT 'fact',      -- fact, decision, outcome, correction, source
  confidence TEXT DEFAULT 'medium',   -- low, medium, high
  status TEXT DEFAULT 'active',       -- active, evicted
  source_type TEXT,                   -- conversation, article, daily_log, curated_memory, etc.
  source_ref TEXT,                    -- e.g. library://item/123
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  cold_vector_id INTEGER             -- vestigial, always NULL
)

-- Vec table (sqlite-vec virtual table, 768 dimensions)
hippocampus_facts_vec (
  rowid INTEGER,                      -- matches hippocampus_facts.rowid
  embedding FLOAT[768]                -- nomic-embed-text output
)

-- Embedding function
-- Ollama nomic-embed-text at 127.0.0.1:11434
-- Input: text string → Output: Float32Array (768 dimensions)
-- API: POST http://127.0.0.1:11434/api/embeddings { model: "nomic-embed-text", prompt: text }
```

## Ingestion Path Summary

| Path | Facts ✅ | Edges ✅ | Embeddings | Searchable | Fix |
|---|---|---|---|---|---|
| Live conversation → Gardener | ✅ | ✅ | ✅ | ✅ | None needed |
| Library URL → gateway-bridge | ✅ | ✅ | ❌ | ❌ | Part B |
| Backfill script (library-to-graph.ts) | ✅ | ✅ | ❌ | ❌ | Part C |
| Existing 6,655 facts in DB | ✅ | ✅ | ❌ | ❌ | Part A |

## Key Code Locations

| File | Function | What it does |
|---|---|---|
| `src/cortex/hippocampus.ts:400` | `insertFact()` | Low-level: inserts fact row + optional embedding |
| `src/cortex/gardener.ts:470` | `dedupAndInsertGraphFact()` | High-level: embeds → dedup → insert fact + vec |
| `src/cortex/gardener.ts:248` | `runFactExtractor()` | Conversation extraction — calls dedupAndInsertGraphFact ✅ |
| `src/cortex/gateway-bridge.ts:411` | Library handler | Article ingestion — calls insertFact() directly ❌ |
| `scripts/library-to-graph.ts:75` | Local `insertFact()` | Copy-paste, no embeddings ❌ |
| `src/cortex/hippocampus.ts:465` | `searchGraphFacts()` | KNN search on hippocampus_facts_vec |

## Execution Order

1. **Part A first** — backfill embeddings. Immediate impact: Cortex recall becomes functional.
2. **Part B second** — fix Library ingestion. Prevents future library items from being invisible.
3. **Part D third** — add tests. Prevents regression.
4. **Part C last** — fix backfill script. Low priority, script is rarely rerun.

## Test Verification Plan

After all parts complete:

1. **Recall test**: Ask Cortex via WhatsApp "what's your birthday?" → should find `Scaff was created/born on February 3, 2026` instead of Task 011 noise
2. **Identity test**: Ask "why are you called Scaff?" → should find facts about scaffolds, growing together
3. **Contract test**: Ask "what's our agreement?" → should find DNA/contract facts
4. **Vec count**: `SELECT count(*) FROM hippocampus_facts_vec_rowids` ≈ 6,665
5. **Library ingest**: Add a new URL, verify its facts appear in vec index
6. **Automated**: New F7/F8/I5 tests pass in CI
