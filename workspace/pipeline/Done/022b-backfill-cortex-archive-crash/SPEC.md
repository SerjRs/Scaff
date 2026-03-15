---
id: "022b"
title: "Backfill Fix — Cortex Archive Crash (188 chunks)"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: ["021", "022a"]
---

# 022b — Backfill Fix: Cortex Archive Crash

## What Happened

The `cortex_archive` source (`npx tsx scripts/backfill-memory.ts --source cortex_archive`) crashed after ~17 minutes processing `cortex/session-archive-2026-03-09.json` (1.3MB, 188 chunks). Exit code 1 with **no error message** — the process silently died.

The source_ref idempotency did NOT help because no summary was printed — we don't know how many chunks completed before the crash.

## Likely Root Causes (investigate in order)

### 1. Memory exhaustion from large JSON parse
The file is 1.3MB. `JSON.parse()` on the full file is fine, but the script may be holding all 188 chunks + all extracted facts in memory simultaneously. Over 17 minutes of accumulation, this could cause an OOM.

**Check:** Run with `--max-old-space-size=512` to see if it's memory-related:
```bash
node --max-old-space-size=512 node_modules/.bin/tsx scripts/backfill-memory.ts --source cortex_archive
```

### 2. Haiku API rate limit / timeout
188 sequential calls over 17 minutes = ~5.4s per call average. Haiku should respond in <2s per call. If a call hangs or gets rate-limited without proper timeout, the process may get killed by the OS or Node's event loop stalls.

**Fix:** Add a per-call timeout:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
try {
  const result = await complete(prompt, { 
    model: 'claude-haiku-4-5', 
    maxTokens: 4096,
    signal: controller.signal 
  });
} finally {
  clearTimeout(timeout);
}
```

### 3. Uncaught promise rejection
The `complete()` function may throw in a way that bypasses the global error handler. Node exits with code 1 on unhandled rejections.

**Fix:** Add global handlers at script top:
```typescript
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  // Don't exit — let the loop continue
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
```

### 4. Cortex archive JSON format mismatch
The archive may have a different structure than expected. The script's `cortex_archive` parser may silently produce empty/invalid chunks that accumulate errors.

**Check:** Inspect the file structure:
```bash
node -e "const d=require('fs').readFileSync('cortex/session-archive-2026-03-09.json','utf8'); const j=JSON.parse(d); console.log(Object.keys(j)); console.log(typeof j, Array.isArray(j), j.length ?? Object.keys(j).length)"
```

## Fix Required

All fixes from 022a (retry, try/catch, progress logging) MUST be applied first — this spec depends on 022a.

Additional fixes specific to cortex_archive:

### 1. Streaming chunk processing
Don't hold all chunks in memory. Process and discard:
```typescript
for (const chunk of generateChunks(data)) {
  await processChunk(chunk);
  // chunk is GC'd after this iteration
}
```

### 2. Checkpoint file for large sources
For sources with >50 chunks, write a checkpoint file tracking which source_refs have been processed:
```typescript
const checkpointPath = path.join(base, 'tmp', `backfill-checkpoint-${sourceType}.json`);
// Save after each successful chunk
// On restart, skip chunks in checkpoint
```

### 3. Batch size limit
Process at most 50 chunks per run. If more remain, print a message to re-run:
```
Processed 50/188 chunks. Re-run to continue (idempotent).
```
This prevents long-running processes from accumulating memory or hitting rate limits.

### 4. Per-call timeout (30s)
Add timeout to each Haiku call so a hanging request doesn't block forever.

## Verification

After applying 022a + 022b fixes:
```bash
npx tsx scripts/backfill-memory.ts --source cortex_archive --base "C:\Users\Temp User\.openclaw"
```
Should either:
- Complete all 188 chunks successfully, OR
- Complete in batches of 50, requiring 4 re-runs, with clear progress messages

## Constraints
- Depends on 022a being applied first
- Fix is in `scripts/backfill-memory.ts` only
- Must not break existing working sources
- Checkpoint file goes in `<base>/tmp/`
