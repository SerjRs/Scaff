---
id: "010a"
title: "Backfill Library embeddings + fix generation reliability"
created: "2026-03-14"
author: "scaff"
priority: "critical"
status: "in_progress"
moved_at: "2026-03-14"
---

# 010a — Backfill Library Embeddings + Fix Generation

## Problem

17/21 Library items have no embeddings. They're invisible to `library_search` and breadcrumbs.

### Root Cause

In `src/cortex/gateway-bridge.ts` (~line 356), embedding generation is fire-and-forget:

```typescript
void libEmbed.generateEmbedding(textToEmbed).then((embedding) => {
    const eDb = libDb.openLibraryDb();
    try { libDb.insertEmbedding(eDb, itemId, embedding); } finally { eDb.close(); }
}).catch((embErr) => {
    params.log.warn(`[library] Embedding failed for item ${itemId}: ...`);
});
```

`generateEmbedding` in `src/library/embeddings.ts` uses a **5-second timeout** (`AbortSignal.timeout(5_000)`). If Ollama is slow (cold start, busy, or large text), it silently fails. The `.catch()` logs a warning but the item is stored without an embedding. No retry.

The 4 items with embeddings were likely ingested when Ollama was warm.

## Fix (two parts)

### Part 1: Backfill script

One-time script to generate embeddings for all 17 items missing them:

```
For each item WHERE id NOT IN (SELECT item_id FROM item_embeddings):
  1. Build text: `${title}. ${summary} ${key_concepts.join(". ")}`
  2. Call Ollama nomic-embed-text (with longer timeout — 30s)
  3. INSERT into item_embeddings
  4. Log success/failure per item
```

Run via: `node scripts/library-backfill-embeddings.mjs`

### Part 2: Fix ingestion pipeline reliability

In `src/cortex/gateway-bridge.ts`:

1. **Increase timeout** from 5s to 15s in the embedding call
2. **Add retry** (1 retry with 2s delay on failure)
3. **Log clearly** on permanent failure so it's visible (not just `.warn`)

In `src/library/embeddings.ts`:
1. Accept optional timeout parameter (default 15s instead of 5s)

### Verification

After backfill:
- `SELECT COUNT(*) FROM item_embeddings` should equal total active items (21)
- `library_search("distributed systems")` should return results from all relevant items
- `library_stats` should show embedding count matching item count

## Files

| File | Change |
|------|--------|
| `scripts/library-backfill-embeddings.mjs` | New — one-time backfill script |
| `src/library/embeddings.ts` | Accept timeout param, default 15s |
| `src/cortex/gateway-bridge.ts` | Increase timeout, add retry on embed failure |
