---
id: "022a"
title: "Backfill Fix — Architecture Docs Crash Resilience"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: ["021"]
---

# 022a — Backfill Fix: Architecture Docs Crash Resilience

## What Happened

The `architecture_doc` source (`npx tsx scripts/backfill-memory.ts --source architecture_doc`) crashed on the first run with exit code 1 during processing of `openclaw-architecture-review.md` (chunk ~75 of 108). No error message was printed — the process just died.

A re-run succeeded because the script's `source_ref` idempotency skipped the 75 already-processed chunks and continued with the remaining 33. **Data was not lost**, but the crash indicates missing error handling.

## Root Cause

The script has no try/catch around individual Haiku API calls. A single API error (timeout, rate limit, malformed response) kills the entire process. The `complete()` function from `src/llm/simple-complete.ts` throws on HTTP errors.

## Fix Required

Modify `scripts/backfill-memory.ts` to add per-chunk error resilience:

### 1. Wrap each chunk's extraction in try/catch
```typescript
for (const chunk of chunks) {
  try {
    const extraction = await extractFacts(chunk.text);
    // ... insert facts/edges ...
  } catch (err) {
    console.error(`  ❌ Error on chunk ${chunk.sourceRef}: ${err.message}`);
    stats.errors++;
    continue; // Don't crash — move to next chunk
  }
}
```

### 2. Add retry with exponential backoff for rate limits
```typescript
async function callWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('rate');
      const delay = isRateLimit ? 5000 * (attempt + 1) : 1000 * (attempt + 1);
      console.log(`  ⚠️ Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

### 3. Increase inter-chunk delay from 200ms to 500ms
188 chunks at 200ms = aggressive for Haiku. Increase to 500ms for safety.

### 4. Add progress logging every 10 chunks
```typescript
if (chunkIndex % 10 === 0) {
  console.log(`  Progress: ${chunkIndex}/${chunks.length} chunks, ${stats.factsInserted} facts so far`);
}
```

## Verification

After fix, re-run:
```bash
npx tsx scripts/backfill-memory.ts --source architecture_doc --base "C:\Users\Temp User\.openclaw"
```
Should complete with 0 new facts (all already imported) and 0 errors.

## Constraints
- Fix is in `scripts/backfill-memory.ts` only
- Must not break existing working sources
- All changes apply globally (benefit all source types, not just architecture_doc)
