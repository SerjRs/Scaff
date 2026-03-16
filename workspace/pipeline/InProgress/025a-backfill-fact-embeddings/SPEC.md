---
id: "025a"
title: "Backfill embeddings for 6,655 hippocampus facts"
created: "2026-03-16"
author: "scaff"
priority: "critical"
status: "cooking"
parent: "025"
depends_on: []
---

# 025a — Backfill Fact Embeddings

## Problem

6,655 hippocampus facts exist in `hippocampus_facts` but have no corresponding entry in `hippocampus_facts_vec`. Only 10 facts (from today's live Gardener run) have embeddings. This makes `searchGraphFacts()` useless — every `memory_query` returns the same 10 results.

## Goal

Generate embeddings for all facts missing them and insert into `hippocampus_facts_vec`. After completion, the vec index should cover all active facts.

## Script: `scripts/backfill-embeddings.ts`

### Algorithm

```
1. Query facts missing vec entries:
   SELECT f.rowid, f.id, f.fact_text
   FROM hippocampus_facts f
   LEFT JOIN hippocampus_facts_vec_rowids v ON v.rowid = f.rowid
   WHERE v.rowid IS NULL AND f.status = 'active'
   ORDER BY f.rowid ASC

2. For each fact:
   a. Call Ollama nomic-embed-text to get 768-dim Float32Array
   b. INSERT INTO hippocampus_facts_vec (rowid, embedding) VALUES (?, ?)
   c. Log progress every 100 facts
   d. On failure: retry up to 3 times with 1s/2s/4s backoff
   e. On permanent failure: log and skip (don't block other facts)

3. After completion: log summary (total, success, failed, duration)
```

### Embedding Function

```typescript
async function embed(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json();
  return new Float32Array(json.embedding);  // 768 dimensions
}
```

### sqlite-vec Constraint

The `hippocampus_facts_vec` table is a `sqlite-vec` virtual table. This extension is loaded at runtime. The script must load it the same way the gateway does.

**How the gateway loads it** (check `src/cortex/hippocampus.ts` around the `CREATE VIRTUAL TABLE` statement):
- The extension is loaded via `db.loadExtension()` or it's bundled with the sqlite build
- The script needs access to the same sqlite-vec binary

**Approach options** (in order of preference):
1. **Use `tsx` with the same imports** — import `DatabaseSync` from `node:sqlite`, load the vec extension the same way `hippocampus.ts` does. Look at how `initHippocampusTables()` sets up the vec table.
2. **Run as a Gardener task** — add a one-shot task to the Gardener that calls `insertFact()` with embeddings for facts missing them. This runs inside the gateway process where sqlite-vec is already loaded.
3. **Standalone with manual extension load** — find the sqlite-vec binary on disk, `db.loadExtension(path)`.

### Checkpointing

Track progress in a simple file `tmp/backfill-embeddings-checkpoint.txt` containing the last successfully processed rowid. On restart, read this file and skip already-processed rows.

### Rate Limiting

Ollama is local, so throughput is limited by inference speed (~20-50ms per embedding). No explicit rate limit needed, but add a 10ms delay between calls to avoid starving other Ollama users.

## Verification

```sql
-- Before
SELECT count(*) FROM hippocampus_facts_vec_rowids;
-- Expected: 10

-- After  
SELECT count(*) FROM hippocampus_facts_vec_rowids;
-- Expected: ≈ count of active facts

SELECT count(*) FROM hippocampus_facts WHERE status = 'active';
-- Should match vec count (minus any embedding failures)
```

### Functional verification

After backfill, test `searchGraphFacts()` with queries that should hit backfilled facts:

```typescript
const results = searchGraphFacts(db, await embed("Scaff birthday creation date"), 5);
// Should return facts about Scaff's creation, NOT "Task 011 addresses 4 root causes"

const results2 = searchGraphFacts(db, await embed("DNA contract alignment agreement"), 5);
// Should return facts about the DNA/contract
```

## Estimated Runtime

- 6,655 facts × ~30-50ms per embedding = **3-6 minutes**
- Plus DB writes: negligible
- Total: **under 10 minutes**

## Files

| File | Action |
|---|---|
| `scripts/backfill-embeddings.ts` | Create — the backfill script |
| `cortex/bus.sqlite` | Modified — `hippocampus_facts_vec` gets ~6,655 new rows |

## Notes

- Do NOT modify `hippocampus_facts` rows — only INSERT into `hippocampus_facts_vec`
- Do NOT re-embed the 10 facts that already have vec entries (the LEFT JOIN filter handles this)
- The script should be idempotent — safe to run multiple times
- `cold_vector_id` column on `hippocampus_facts` is vestigial (always NULL) — ignore it
