# 046 — Token Monitor: Task Lifecycle — STATE

**Status: DONE**
**Date: 2026-03-25**

## Files Modified

1. **`src/token-monitor/ledger.ts`**
   - Added `"Queued"` to `TokenRowStatus` type
   - Added `STALE_QUEUED_MS = 300_000` (5 min) constant
   - Added stale Queued cleanup in `snapshot()` — rows stuck in Queued for 5+ min get marked Failed

2. **`src/token-monitor/gateway-methods.ts`**
   - Added `record` import from ledger
   - Expanded `mapJobStatus()` to handle `in_queue` → Queued, `pending` → Queued
   - Added pre-execution job query in `syncRouterStatuses()` — queries `in_queue`, `pending`, `evaluating` jobs and creates placeholder ledger entries with `record()`, then sets correct status via `updateStatusBySession()`

3. **`src/token-monitor/cli.ts`**
   - Added `Queued` to sort order (priority 1, between Active and InProgress)
   - Added yellow color rendering for `Queued` status in `colorStatus()`

## What Changed

The token monitor now shows router tasks through their full lifecycle:

- **Before:** Tasks only appeared when the executor made an LLM call (InProgress), or after completion (Finished). Pre-execution states (in_queue, pending) were invisible.
- **After:** `syncRouterStatuses()` queries pre-execution jobs and creates placeholder ledger entries. Tasks appear as "Queued" immediately on next poll cycle, then transition through InProgress → Finished/Failed.

Status transitions:
```
in_queue  → Queued (yellow)
pending   → Queued (yellow)
evaluating → InProgress
in_execution → InProgress
completed → Finished
failed    → Failed
```

Stale Queued rows (no activity for 5 min) auto-transition to Failed for cleanup.

## Test Results

- No existing tests in `src/token-monitor/`
- Type-check: zero errors in token-monitor files (pre-existing errors in `src/audio/__tests__/` are unrelated Buffer type issues)
