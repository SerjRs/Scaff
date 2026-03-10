# Hippocampus Fact Dedup — Embedding-Based Implementation

*Created: 2026-03-10*
*Status: Implemented*
*Issue: #22 in ACTIVE-ISSUES.md*
*Ref: `src/cortex/gardener.ts`, `src/cortex/hippocampus.ts`, `src/cortex/tools.ts`*

---

## Problem

When the Gardener extracts facts from conversation and stores them in hot memory, it checks for duplicates using **exact string match**:

```typescript
// gardener.ts lines 208-209 (shard path) and lines 249-250 (fallback path)
const existing = db.prepare(
  `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`
).get(factText.trim());
```

Near-duplicates pass through:
- `"Serj lives in Bucharest"` → inserted
- `"Serj lives in Bucharest, Romania"` → inserted (different string)
- `"User's location is Bucharest"` → inserted (different string)

All three are the same knowledge. They waste slots in the top-50 facts injected into Cortex's system prompt (`getTopHotFacts(db, 50)` in `context.ts` line 396).

---

## Available Infrastructure

Everything needed already exists in the codebase:

| Component | Location | Status |
|-----------|----------|--------|
| `EmbedFunction` type | `src/cortex/tools.ts:123` | ✅ Exists |
| `embedViaOllama()` | `src/cortex/tools.ts:126` | ✅ Exists — calls Ollama `nomic-embed-text` at `127.0.0.1:11434` |
| `sqlite-vec` extension | `src/memory/sqlite-vec.ts` | ✅ Exists — loaded for cold storage |
| Cold storage vector search | `hippocampus.ts:searchColdFacts()` | ✅ Exists — KNN search with `MATCH` and distance |
| Vector Evictor (embeds facts) | `gardener.ts:runVectorEvictor()` | ✅ Exists — embeds hot facts before moving to cold |
| `cortex_cold_memory_vec` table | `hippocampus.ts:initColdStorage()` | ✅ Exists — `vec0(embedding float[768])` |
| Ollama server | `127.0.0.1:11434` | ✅ Running — serves `nomic-embed-text` |

**What's missing:** A vector table for hot memory embeddings, and the similarity check at insert time.

---

## Implementation

### Step 1: Add embedding column to hot memory

The current `cortex_hot_memory` table has no embeddings. We need a companion vec table (same pattern as cold storage):

**File:** `src/cortex/hippocampus.ts`, function `initHotMemoryTable()`

```typescript
// After the existing CREATE TABLE for cortex_hot_memory, add:
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS cortex_hot_memory_vec
  USING vec0(embedding float[768])
`);
```

This requires `sqlite-vec` to be loaded first. Add `loadSqliteVecExtension()` call if not already done for hot memory init.

**Test:**
- `test_hot_memory_vec_table_created`: After `initHotMemoryTable()`, verify `cortex_hot_memory_vec` table exists
- `test_hot_memory_vec_table_idempotent`: Call `initHotMemoryTable()` twice, no error

---

### Step 2: Embed facts on insert

**File:** `src/cortex/hippocampus.ts`, function `insertHotFact()`

Current signature:
```typescript
export function insertHotFact(db, fact: { id?: string; factText: string }): string
```

New signature:
```typescript
export function insertHotFact(db, fact: { id?: string; factText: string; embedding?: Float32Array }): string
```

After inserting into `cortex_hot_memory`, also insert into `cortex_hot_memory_vec`:

```typescript
if (fact.embedding) {
  const rowidNum = Number(
    (db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number | bigint }).id
  );
  db.prepare(`
    INSERT INTO cortex_hot_memory_vec (rowid, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `).run(rowidNum, new Uint8Array(fact.embedding.buffer));
}
```

Note: `insertHotFact` uses a UUID `id` (TEXT PRIMARY KEY), not an INTEGER rowid. The vec table needs INTEGER rowids. Use a mapping approach:
- Option A: Add an `INTEGER` rowid alias to `cortex_hot_memory` (SQLite has implicit rowid)
- Option B: Store a separate mapping `hot_fact_id TEXT → vec_rowid INTEGER`
- **Recommendation:** Option A — SQLite tables already have an implicit `rowid`. Use it for the vec table. Query with `SELECT rowid, * FROM cortex_hot_memory WHERE id = ?`.

**Test:**
- `test_insert_hot_fact_with_embedding`: Insert fact with embedding, verify both tables populated
- `test_insert_hot_fact_without_embedding`: Insert fact without embedding (backward compat), verify only main table populated

---

### Step 3: Similarity check before insert in Gardener

**File:** `src/cortex/gardener.ts`, both insert sites (lines ~208 and ~249)

Replace:
```typescript
const existing = db.prepare(
  `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`
).get(factText.trim());

if (!existing) {
  insertHotFact(db, { factText: factText.trim() });
  result.processed++;
}
```

With:
```typescript
// 1. Exact match first (fast, no embedding needed)
const exactMatch = db.prepare(
  `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`
).get(factText.trim());

if (exactMatch) continue; // Skip exact duplicate

// 2. Embed the new fact
const embedding = await embedFn(factText.trim());

// 3. Search hot memory vec for similar facts (cosine similarity > 0.85)
const similar = searchHotFacts(db, embedding, 1); // top-1 nearest

if (similar.length > 0 && similar[0].distance < SIMILARITY_THRESHOLD) {
  // Near-duplicate found — replace if newer is longer/more specific, else skip
  console.log(`[gardener] Dedup: "${factText.trim().slice(0, 60)}..." similar to existing (dist=${similar[0].distance.toFixed(3)})`);
  
  // Option: update the existing fact if the new one is more detailed
  if (factText.trim().length > similar[0].factText.length) {
    updateHotFact(db, similar[0].id, factText.trim(), embedding);
    result.processed++;
  }
  // else: skip — existing fact is good enough
} else {
  // New unique fact
  insertHotFact(db, { factText: factText.trim(), embedding });
  result.processed++;
}
```

**Constants:**
```typescript
// sqlite-vec returns L2 distance, not cosine similarity
// For normalized nomic-embed-text vectors:
//   cosine_similarity ≈ 1 - (distance² / 2)
//   similarity > 0.85 ≈ distance < 0.55
const SIMILARITY_THRESHOLD = 0.55; // L2 distance — tune after testing
```

**Note on distance metric:** `sqlite-vec` `vec0` uses L2 (Euclidean) distance by default. `nomic-embed-text` outputs normalized vectors, so L2 distance and cosine similarity are related: `cosine_sim = 1 - (L2_dist² / 2)`. Threshold needs empirical tuning.

**Test:**
- `test_dedup_exact_match_skipped`: Insert "Serj lives in Bucharest" twice, verify only 1 row
- `test_dedup_near_duplicate_skipped`: Insert "Serj lives in Bucharest" then "Serj lives in Bucharest Romania", verify only 1 row (or replaced if longer)
- `test_dedup_different_facts_both_inserted`: Insert "Serj lives in Bucharest" then "Gateway runs on port 18789", verify 2 rows
- `test_dedup_replacement_keeps_longer`: Insert short fact, then longer near-duplicate, verify the longer one replaces the shorter

---

### Step 4: Add `searchHotFacts()` function

**File:** `src/cortex/hippocampus.ts`

New function, mirrors `searchColdFacts()`:

```typescript
/** Search hot memory by vector similarity (KNN) */
export function searchHotFacts(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit = 5,
): (HotFact & { distance: number })[] {
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, m.id, m.fact_text, m.created_at, m.last_accessed_at, m.hit_count
    FROM cortex_hot_memory_vec v
    JOIN cortex_hot_memory m ON m.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(new Uint8Array(queryEmbedding.buffer), limit);

  return rows.map((row) => ({
    id: row.id as string,
    factText: row.fact_text as string,
    createdAt: row.created_at as string,
    lastAccessedAt: row.last_accessed_at as string,
    hitCount: row.hit_count as number,
    distance: row.distance as number,
  }));
}
```

**Test:**
- `test_search_hot_facts_returns_nearest`: Insert 3 facts with embeddings, search with one, verify correct nearest returned
- `test_search_hot_facts_empty_table`: Search empty table, verify returns empty array

---

### Step 5: Add `updateHotFact()` function

**File:** `src/cortex/hippocampus.ts`

```typescript
/** Update an existing hot fact's text and embedding (for dedup replacement) */
export function updateHotFact(
  db: DatabaseSync,
  id: string,
  newFactText: string,
  newEmbedding: Float32Array,
): void {
  // Update text
  db.prepare(`
    UPDATE cortex_hot_memory
    SET fact_text = ?, last_accessed_at = ?
    WHERE id = ?
  `).run(newFactText, new Date().toISOString(), id);

  // Update embedding — need the rowid
  const row = db.prepare(`SELECT rowid FROM cortex_hot_memory WHERE id = ?`).get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare(`DELETE FROM cortex_hot_memory_vec WHERE rowid = ?`).run(row.rowid);
    db.prepare(`
      INSERT INTO cortex_hot_memory_vec (rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `).run(row.rowid, new Uint8Array(newEmbedding.buffer));
  }
}
```

**Test:**
- `test_update_hot_fact_changes_text`: Insert fact, update it, verify new text stored
- `test_update_hot_fact_changes_embedding`: Insert fact with embedding, update, verify new embedding in vec table

---

### Step 6: Pass `embedFn` to Gardener extractor

**File:** `src/cortex/gardener.ts`, function `runFactExtractor()`

Current signature has `embedFn` but only uses it for the Vector Evictor. The extractor insert loop needs it too.

Add `embedFn` to the extractor's insert loop. It's already available in scope (passed to `runGardenerCycle()` which calls `runFactExtractor()`).

**Verify:** `embedFn` is in scope at lines 208 and 249 where facts are inserted. If not, thread it through from `runGardenerCycle()`.

**Test:**
- `test_extractor_calls_embed_on_insert`: Mock `embedFn`, verify it's called for each new fact
- `test_extractor_graceful_on_embed_failure`: Mock `embedFn` to throw, verify fact is still inserted (without embedding) and error is logged

---

### Step 7: Backfill existing hot facts

Existing facts in `cortex_hot_memory` have no embeddings. Write a one-time migration script:

**File:** `scripts/backfill-hot-embeddings.mjs`

```javascript
// 1. Load all hot facts without embeddings
// 2. For each: call Ollama nomic-embed-text
// 3. Insert into cortex_hot_memory_vec
// 4. Report progress
```

Batch in groups of 50 with a 100ms delay between batches (Ollama can handle it but avoid overwhelming).

**Test:**
- Run manually, verify all hot facts have corresponding vec entries
- Verify `searchHotFacts()` returns results after backfill

---

## Files to Change

| File | Step | Change |
|------|------|--------|
| `src/cortex/hippocampus.ts` | 1 | `initHotMemoryTable()` — create `cortex_hot_memory_vec` table |
| `src/cortex/hippocampus.ts` | 2 | `insertHotFact()` — accept optional embedding, insert into vec table |
| `src/cortex/hippocampus.ts` | 4 | `searchHotFacts()` — new function, KNN search on hot memory |
| `src/cortex/hippocampus.ts` | 5 | `updateHotFact()` — new function, replace fact text + embedding |
| `src/cortex/gardener.ts` | 3, 6 | Extractor insert loop — embed + similarity check before insert |
| `scripts/backfill-hot-embeddings.mjs` | 7 | New script — one-time migration for existing facts |

## Test Summary

| Test | Step |
|------|------|
| `test_hot_memory_vec_table_created` | 1 |
| `test_hot_memory_vec_table_idempotent` | 1 |
| `test_insert_hot_fact_with_embedding` | 2 |
| `test_insert_hot_fact_without_embedding` | 2 |
| `test_dedup_exact_match_skipped` | 3 |
| `test_dedup_near_duplicate_skipped` | 3 |
| `test_dedup_different_facts_both_inserted` | 3 |
| `test_dedup_replacement_keeps_longer` | 3 |
| `test_search_hot_facts_returns_nearest` | 4 |
| `test_search_hot_facts_empty_table` | 4 |
| `test_update_hot_fact_changes_text` | 5 |
| `test_update_hot_fact_changes_embedding` | 5 |
| `test_extractor_calls_embed_on_insert` | 6 |
| `test_extractor_graceful_on_embed_failure` | 6 |

**Total: 14 tests across 7 steps.**

---

## Tuning

The `SIMILARITY_THRESHOLD` (L2 distance) needs empirical tuning:

1. Take 10-20 known near-duplicate pairs from existing hot facts
2. Embed both, compute L2 distance
3. Take 10-20 known distinct fact pairs
4. Embed both, compute L2 distance
5. Find the threshold that separates the two groups

A script `scripts/tune-dedup-threshold.mjs` can automate this:
- Pull all hot facts
- Embed all via Ollama
- Compute pairwise distances
- Output a distance matrix / histogram
- Suggest threshold

---

## Rollout

1. **Step 1-2:** Schema + insert changes (backward compatible — embedding is optional)
2. **Step 4-5:** New functions (no behavior change until Step 3)
3. **Step 7:** Backfill existing facts
4. **Step 3 + 6:** Enable dedup in Gardener extractor (the actual behavior change)
5. **Monitor:** Watch Gardener logs for dedup hits, verify fact count stabilizes
