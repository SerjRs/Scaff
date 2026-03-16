---
id: "025b"
title: "Fix Library ingestion + backfill script to generate embeddings"
created: "2026-03-16"
author: "scaff"
priority: "critical"
status: "cooking"
parent: "025"
depends_on: ["025a"]
---

# 025b — Fix Library Ingestion Embeddings

## Problem

When a URL is ingested via the Library tool, the Librarian extracts facts and the gateway-bridge writes them to `hippocampus_facts` — but **without embeddings**. The code calls `hippo.insertFact()` directly (the low-level function) instead of `hippo.dedupAndInsertGraphFact()` (the high-level function that generates embeddings and deduplicates).

This means every Library-ingested article produces facts that exist in the graph but are **invisible to vector search** via `memory_query`.

## Root Cause

`src/cortex/gateway-bridge.ts` lines 396–441 — the Library task completion handler:

```typescript
// Line 396: imports hippocampus
const hippo = require("./hippocampus.js");

// Line 403: source article node — no embedding
const sourceFactId = hippo.insertFact(instance.db, {
  factText: `Article: ${parsed.title}`,
  factType: "source",
  confidence: "high",
  sourceType: "article",
  sourceRef: `library://item/${itemId}`,
});

// Line 411: content facts — no embedding
for (const f of parsedFacts) {
  const factId = hippo.insertFact(instance.db, {
    factText: f.text.trim(),
    factType: f.type ?? "fact",
    confidence: f.confidence ?? "medium",
    sourceType: "article",
    sourceRef: `library://item/${itemId}`,
  });
  // ...edges are created correctly
}
```

Should use `dedupAndInsertGraphFact()` which:
1. Generates embedding via Ollama `nomic-embed-text`
2. Checks for near-duplicates in the vec index
3. Inserts into both `hippocampus_facts` AND `hippocampus_facts_vec`

## Fix

### 1. Extend `dedupAndInsertGraphFact` to accept `sourceRef`

**File**: `src/cortex/gardener.ts` (line 470)

**Current signature**:
```typescript
export async function dedupAndInsertGraphFact(
  db: DatabaseSync,
  fact: ExtractedFact,  // { id, text, type?, confidence? }
  sourceType: string,
  embedFn?: EmbedFunction,
): Promise<{ factId: string; inserted: boolean }>
```

**New signature**:
```typescript
export async function dedupAndInsertGraphFact(
  db: DatabaseSync,
  fact: ExtractedFact,
  sourceType: string,
  embedFn?: EmbedFunction,
  sourceRef?: string,    // ← NEW: optional source reference (e.g. "library://item/123")
): Promise<{ factId: string; inserted: boolean }>
```

Then pass `sourceRef` through to all `insertFact()` calls inside the function. There are 4 `insertFact()` call sites inside `dedupAndInsertGraphFact` (lines 485, 500, 515, 549) — all need `sourceRef` added.

### 2. Fix gateway-bridge.ts Library handler

**File**: `src/cortex/gateway-bridge.ts` (lines 396–441)

**Changes**:

a) Get the `embedFn` — find how Gardener gets its `embedFn` in the gateway context. Look at where `runFactExtractor` is called in the gateway bridge or cortex init. The embed function is likely constructed from Ollama:

```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json();
  return new Float32Array(json.embedding);
}
```

Or import the existing one from wherever the Gardener constructs it.

b) Replace source article node insertion:
```typescript
// Before:
const sourceFactId = hippo.insertFact(instance.db, { ... });

// After:
const sourceEmbedding = await embedFn(`Article: ${parsed.title}`);
const sourceFactId = hippo.insertFact(instance.db, {
  factText: `Article: ${parsed.title}`,
  factType: "source",
  confidence: "high",
  sourceType: "article",
  sourceRef: `library://item/${itemId}`,
  embedding: sourceEmbedding,
});
```

c) Replace content fact insertions:
```typescript
// Before:
const factId = hippo.insertFact(instance.db, { ... });

// After:
const { factId } = await gardener.dedupAndInsertGraphFact(
  instance.db,
  { id: f.id, text: f.text.trim(), type: f.type ?? "fact", confidence: f.confidence ?? "medium" },
  "article",
  embedFn,
  `library://item/${itemId}`,  // sourceRef
);
```

d) The enclosing block needs to be `async` — check if the Library handler is inside a sync callback. If so, wrap in an async IIFE or refactor the handler.

### 3. Import cleanup

The Library handler currently does `const hippo = require("./hippocampus.js")`. It also needs access to `dedupAndInsertGraphFact` from `gardener.ts` (or move the function to `hippocampus.ts` where it arguably belongs — it's a hippocampus operation, not a gardener operation).

**Preferred approach**: Import `dedupAndInsertGraphFact` from wherever it lives. If the `require()` pattern is used throughout gateway-bridge, follow the same pattern.

## Tests

### New tests in `e2e-hippocampus-full.test.ts`

**F7. Article facts get embeddings and are searchable**:
```typescript
it("F7. article facts are searchable via vector similarity", async () => {
  // Insert a fact with embedding (simulating the fixed Library path)
  const embedding = await embedFn("SQLite uses B-tree indexes for storage");
  insertFact(db, {
    factText: "SQLite uses B-tree indexes for storage",
    sourceType: "article",
    sourceRef: "library://item/test-f7",
    embedding,
  });

  // Vector search should find it
  const query = await embedFn("B-tree index database storage");
  const results = searchGraphFacts(db, query, 5);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].fact_text).toContain("B-tree");
});
```

**F8. dedupAndInsertGraphFact passes sourceRef through**:
```typescript
it("F8. dedupAndInsertGraphFact stores sourceRef", async () => {
  const { factId } = await dedupAndInsertGraphFact(
    db,
    { id: "f1", text: "Test fact with source ref", type: "fact", confidence: "high" },
    "article",
    embedFn,
    "library://item/test-f8",
  );
  
  const row = db.prepare("SELECT source_ref FROM hippocampus_facts WHERE id = ?").get(factId);
  expect(row.source_ref).toBe("library://item/test-f8");
  
  // Also verify it has a vec entry
  const factRow = db.prepare("SELECT rowid FROM hippocampus_facts WHERE id = ?").get(factId);
  const vecRow = db.prepare("SELECT rowid FROM hippocampus_facts_vec_rowids WHERE rowid = ?").get(factRow.rowid);
  expect(vecRow).toBeDefined();
});
```

**I5. memory_query finds facts from all source types**:
```typescript
it("I5. memory_query returns facts from multiple source types", async () => {
  // Insert conversation fact + article fact, both with embeddings
  // Run searchGraphFacts with a relevant query
  // Verify results include both source types
});
```

### 4. Fix backfill script (`scripts/library-to-graph.ts`)

The backfill script has its own copy-paste `insertFact()` at line 75 that bypasses hippocampus.ts entirely — no embeddings, no dedup. If this script is ever re-run, it produces the same invisible facts.

**Changes**:

a) Delete the local `insertFact()` function (line 75) and the local `insertEdge()` function (line 91)

b) Import from the real modules:
```typescript
import { insertFact, insertEdge } from "../src/cortex/hippocampus.js";
import { dedupAndInsertGraphFact } from "../src/cortex/gardener.js";
```

c) Construct an `embedFn` using Ollama (same pattern as the gateway-bridge fix):
```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json();
  return new Float32Array(json.embedding);
}
```

d) Replace all `insertFact()` calls (lines 205, 217) with `dedupAndInsertGraphFact()` calls, passing `embedFn` and the appropriate `sourceRef`.

e) The script must load `sqlite-vec` extension — check how hippocampus.ts does it, replicate the same setup.

## Files Changed

| File | Change |
|---|---|
| `src/cortex/gardener.ts` | Add `sourceRef?` param to `dedupAndInsertGraphFact`, pass through to all `insertFact` calls |
| `src/cortex/gateway-bridge.ts` | Replace `insertFact()` with `dedupAndInsertGraphFact()` + `embedFn` in Library handler |
| `scripts/library-to-graph.ts` | Delete local `insertFact`/`insertEdge`, import from hippocampus.ts, use `dedupAndInsertGraphFact` with `embedFn` |
| `src/cortex/__tests__/e2e-hippocampus-full.test.ts` | Add tests F7, F8, I5 |

## Verification

1. Ingest a new Library URL via Cortex
2. Check `hippocampus_facts_vec_rowids` — new rows should appear for the article's facts
3. Run `memory_query` with a query related to the article — facts should be returned
4. All existing tests still pass (the `sourceRef` parameter is optional, backward compatible)

## Notes

- The `embedFn` in gateway-bridge should be the same Ollama function used everywhere else
- If embedding fails for a fact, the function should still insert the fact (without embedding) — graceful degradation, matching existing behavior in `dedupAndInsertGraphFact`
- Consider moving `dedupAndInsertGraphFact` from `gardener.ts` to `hippocampus.ts` in a future cleanup — it's a hippocampus operation
