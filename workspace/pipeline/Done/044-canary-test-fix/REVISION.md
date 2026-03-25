# 044 — Canary Test Fix: Revision Report

**Date:** 2026-03-19
**Scope:** Root cause analysis of production ingestion failure + canary test gap audit
**Trigger:** Live audio capture session `089187ab-b4ea-45bc-8272-594abc889e10` produced a transcript on disk, but nothing landed in Hippocampus. The canary test (8 seconds, green) did not detect this.

---

## Section 1: Production Failure Root Cause Analysis

### The Chain of Events

Session `089187ab` completed successfully:
- **Status:** `done` (audio.sqlite, 5 chunks received)
- **Transcript:** Written to `workspace/data/audio/transcripts/089187ab-...json` (recognizable speech: "Hi, Scott. This is the final test...")
- **Hippocampus facts from audio-capture:** **ZERO**
- **Dispatch entries for this session:** **ZERO**
- **Library pending tasks:** **ZERO**

The pipeline ran correctly through step 9 of `worker.ts` (transcription complete, status set to "done"). It failed at step 10 — the `onIngest` callback.

### Failure Mode 1: Cortex/Router Singletons Not Available

**File: `src/gateway/server-audio.ts:76-89`**

The production `onIngest` callback does lazy imports of Cortex and Router singletons:

```
line 79: const { getGatewayCortex } = require("../cortex/gateway-bridge.js");
line 80: const { getGatewayRouter } = require("../router/gateway-integration.js");
...
line 85: const cortex = getGatewayCortex();
line 86: const router = getGatewayRouter();
line 87: if (!cortex?.instance?.db || !router) {
line 88:   opts.log.warn(`[audio] Librarian ingestion skipped for session ${sessionId} — Cortex or Router not available`);
line 89:   return;
```

`getGatewayCortex()` (`src/cortex/gateway-bridge.ts:642-644`) returns a module-scoped `handle` variable. This is set only by `initGatewayCortex()` (`gateway-bridge.ts:78`), which is called at `src/gateway/server-startup.ts:190`.

`getGatewayRouter()` (`src/router/gateway-integration.ts:445-447`) returns `globalThis.__openclaw_router_instance__`. This is set only by `initGatewayRouter()` (`gateway-integration.ts:193`), which is called at `src/gateway/server-startup.ts:178`.

**Startup order in `server.impl.ts`:**
1. Line 366: `initGatewayAudioCapture()` — creates handler + `onIngest` closure
2. Line 178 (via `startGatewaySidecars`): `initGatewayRouter()` — sets Router singleton
3. Line 190 (via `startGatewaySidecars`): `initGatewayCortex()` — sets Cortex singleton

Audio capture is initialized BEFORE Cortex/Router. This is by design — the `onIngest` callback uses lazy `require()` to resolve singletons at call time, not at init time. But if Cortex or Router fails to start (error caught at `server-startup.ts:195-197`) or is disabled, the singletons remain null.

**Why it was silent:** The early return at line 88-89 only emits a `log.warn()`. No error thrown, no status change, no session update. The session is already marked "done" (worker.ts:147, before onIngest at line 150). From every external perspective — status API, transcript file, session DB — the pipeline succeeded.

### Failure Mode 2: NOT NULL Constraint Violation (Latent Bug)

**Even if Cortex and Router were both available, ingestion would STILL fail.**

`src/gateway/server-audio.ts:97-102`:
```
storeDispatch(cortexDb, {
  taskId,
  channel: null,          // <--- HERE
  taskSummary: librarianPrompt.slice(0, 200),
  priority: "normal",
});
```

`src/cortex/session.ts:370-374` — the INSERT:
```sql
INSERT INTO cortex_task_dispatch
  (task_id, channel, channel_context, counterpart_id, counterpart_name,
   shard_id, task_summary, dispatched_at, priority, executor, issuer)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

**The `cortex_task_dispatch` schema** (confirmed from bus.sqlite):
```sql
channel TEXT NOT NULL
```

Passing `null` to a `NOT NULL` column throws: `NOT NULL constraint failed: cortex_task_dispatch.channel`. This error is caught by the try/catch at `server-audio.ts:112-114`:

```
} catch (err) {
  opts.log.warn(`[audio] Librarian ingestion failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Result:** The entire onIngest body — `storeDispatch`, `storeLibraryTaskMeta`, `router.enqueue` — runs inside a single try/catch. The SQL constraint error at `storeDispatch` aborts the entire block. No Library task meta stored, no Router job enqueued. The error is logged as a warning and silently swallowed.

**This means the audio ingestion path has NEVER successfully completed.** Both failure modes produce only warnings that are invisible in normal operation.

### Full Failure Chain Summary

```
worker.ts:150  — deps.onIngest(prompt, sessionId)
                 ↓
server-audio.ts:76 — onIngest callback fires
                 ↓
server-audio.ts:85-86 — getGatewayCortex() → null? getGatewayRouter() → null?
                 ↓ (if null)                    ↓ (if both available)
server-audio.ts:87-89                    server-audio.ts:97-102
  → log.warn, return silently              → storeDispatch(cortexDb, { channel: null })
  → NOTHING happens                        → NOT NULL constraint failed
                                            → caught by try/catch at line 112
                                            → log.warn, swallowed silently
                                            → NOTHING happens
```

Both branches lead to silent failure. The canary tests none of this.

---

## Section 2: Canary Test Gaps

### What the Canary Tests

**File: `src/audio/__tests__/canary.test.ts`**

The canary proves: chunk upload → Whisper → transcript on disk → "a callback fires."

### What the Canary Substitutes

**Line 102:** The fake onIngest:
```ts
onIngest: async (prompt, sid) => { ingestCalls.push({ prompt, sessionId: sid }); },
```

This replaces 40 lines of production code (`server-audio.ts:76-115`) that:
- Lazy-imports `getGatewayCortex`, `getGatewayRouter`, `storeDispatch`, `storeLibraryTaskMeta`, `getCortexSessionKey`
- Checks singleton availability
- Stores a dispatch record in cortex_task_dispatch
- Stores library task metadata in library_pending_tasks
- Enqueues a Router job via `router.enqueue()`
- Logs success

The spy does none of this. It pushes to an array.

**Line 105:** Uses `createGatewayAudioHandler()` instead of `initGatewayAudioCapture()`:
```ts
const handler = createGatewayAudioHandler({
  db: sessionDb,
  config: { ... },
  workerDeps,  // <-- hand-constructed with spy
  log: { ... },
});
```

Production uses `initGatewayAudioCapture()` (`server-audio.ts:37`), which constructs `workerDeps` internally with the real `onIngest` closure. The canary bypasses this entirely.

**Lines 169-171:** The assertion:
```ts
const call = ingestCalls.find((c) => c.sessionId === sessionId);
expect(call).toBeDefined();
expect(call!.prompt).toContain(`audio-capture://${sessionId}`);
```

This proves the spy was called. It proves nothing about downstream side effects (dispatch stored, library task meta created, Router job enqueued). A spy that always succeeds can never detect a downstream failure.

### What the Canary SHOULD Have Tested

1. The REAL `onIngest` from `initGatewayAudioCapture()` fires
2. A dispatch row exists in `cortex_task_dispatch` for the session
3. A `library_pending_tasks` row exists for the session
4. A Router job was enqueued (or at minimum, `router.enqueue` was called with correct args)
5. If Cortex/Router are unavailable, the test FAILS (not silently passes)

### Comparison: real-e2e.test.ts Has the Same Blind Spot

**Suite 1** (`real-e2e.test.ts:242-465`): Uses `initGatewayAudioCapture()` (line 253) — the correct production init path. But it NEVER checks onIngest behavior. Tests 1-4 verify chunks → Whisper → transcript → file lifecycle. Test 5 checks that the handle exists. None verify ingestion.

Because Cortex/Router aren't running in the test environment, the real `onIngest` fires but silently skips (line 87-89). The test doesn't assert on ingestion, so it passes.

**Suite 2** (`real-e2e.test.ts:474-574`): Explicitly uses a spy (line 499):
```ts
onIngest: async (prompt, sid) => {
  ingestCalls.push({ prompt, sessionId: sid });
},
```

Same pattern as the canary. Same blind spot. The comment at line 471-472 is even honest about it:
> "Separate from Suite 1 because initGatewayAudioCapture's onIngest does lazy require() of Cortex/Router which aren't available in test context."

This is the gap acknowledged but not addressed.

---

## Section 3: Additional Gaps Identified

### 3.1 gateway-init.test.ts Test 6: Validates the Failure Mode as Success

**File: `src/audio/__tests__/gateway-init.test.ts:261-276`**

```ts
it("workerDeps includes onIngest callback", () => {
  const { handle, log } = initWithDefaults();
  // ...
  // Calling onIngest should not crash — lazy Cortex/Router imports will fail
  // in test context, but the try/catch in server-audio.ts handles it gracefully
  handle!.workerDeps.onIngest!("test prompt", "test-session-id");

  // Verify graceful failure (warning logged, no crash)
  expect(log.messages.some((m) => m.includes("[warn]") && m.includes("Librarian ingestion"))).toBe(true);
});
```

This test literally **validates the production failure mode as correct behavior**. It calls `onIngest`, observes that it fails (Cortex/Router not available), and asserts that the failure was "graceful." This IS the bug. The test certifies it as working-as-designed.

The test name "workerDeps includes onIngest callback" is true — the callback exists. But existing ≠ working. The test proves `typeof onIngest === "function"` but never proves onIngest achieves its purpose.

### 3.2 Silent Error Swallowing in onIngest

**`server-audio.ts:112-114`:**
```ts
} catch (err) {
  opts.log.warn(`[audio] Librarian ingestion failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
}
```

The entire body of `onIngest` (lines 77-111) is wrapped in a single try/catch. Any failure — Cortex unavailable, SQL constraint error, Router enqueue failure, missing modules — is caught and logged as a warning. This means:

- A broken `require()` path → warn
- A schema mismatch → warn
- A network error in `router.enqueue()` → warn
- A missing table → warn
- `channel: null` NOT NULL violation → warn

No retry. No status update. No error propagation. The session stays "done" because `updateSessionStatus(deps.sessionDb, sessionId, "done")` already ran at `worker.ts:147`, BEFORE `onIngest` at line 150.

### 3.3 Temporal Ordering Bug: Status Set Before Ingestion

**`src/audio/worker.ts:147-158`:**
```ts
// 9. Update session status
updateSessionStatus(deps.sessionDb, sessionId, "done");   // line 147

// 10. Trigger Librarian ingestion (optional)               // line 149
if (transcript.fullText && deps.onIngest) {                // line 150
  // ...
  await deps.onIngest(prompt, sessionId);                  // line 157
}
```

The session is marked "done" (step 9) before ingestion is attempted (step 10). If ingestion fails, the session remains "done." No external observer can distinguish "done + ingested" from "done + ingestion failed." The canary polls for `status === "done"` at line 160 and celebrates.

### 3.4 `channel: null` in storeDispatch — Systemic Mismatch

The `onIngest` code at `server-audio.ts:99` explicitly sets `channel: null` with the comment "no user conversation to notify." But the `cortex_task_dispatch` table requires `channel TEXT NOT NULL`. This is a design mismatch between:

- The audio ingestion path (system-initiated, no channel)
- The dispatch schema (designed for user-initiated tasks with a conversation channel)

The `onJobDelivered` handler in `gateway-bridge.ts:503` handles null-channel dispatches gracefully:
```ts
if (!dispatch?.channel) {
  params.log.warn(`[cortex] Router result ingested (no-channel): job=${jobId} status=${job.status}`);
  return;
}
```

But the INSERT never reaches the DB because of the NOT NULL constraint.

### 3.5 No Tests Exercise the Full Ingestion Pipeline

**Boundary: Transcript → Librarian → Library/Hippocampus**

No test in the entire suite calls the production `onIngest` with functioning Cortex and Router singletons. The boundary map from the TESTS-REVISION-REPORT.md confirms:

| Boundary | Status |
|----------|--------|
| Transcript → Librarian | MOCK — onIngest is always a spy |
| Librarian → Library/Hippocampus | UNTESTED — server-audio.ts onIngest with lazy imports of Cortex/Router is never exercised |
| Gateway init → Handler | PARTIAL — gateway-init.test.ts validates failure mode as success |

### 3.6 Worker onIngest is Optional (`?` type)

**`src/audio/worker.ts:32`:**
```ts
onIngest?: (librarianPrompt: string, sessionId: string) => void | Promise<void>;
```

The `?` makes `onIngest` optional in the type. The check at `worker.ts:150` (`deps.onIngest`) guards against undefined. But this also means if `initGatewayAudioCapture()` somehow fails to set `onIngest`, the worker silently skips ingestion. No error, no warning, no indication of a problem.

This is defensive typing that hides misconfiguration. If `onIngest` is required for the pipeline to function, it should not be optional.

---

## Section 4: Recommendations

### Priority 1: Fix the Production Code (Without These, No Test Can Help)

#### R1. Fix `channel: null` NOT NULL violation
**File:** `src/gateway/server-audio.ts:99`
**Fix:** Change `channel: null` to `channel: "system"` or add a dedicated channel constant for system-initiated tasks. Alternatively, alter `cortex_task_dispatch.channel` to allow NULL.
**Impact:** Without this fix, ingestion will silently fail even when Cortex and Router are fully available. This is a latent bug that no existing test catches.

#### R2. Separate try/catch blocks for each ingestion step
**File:** `src/gateway/server-audio.ts:77-115`
**Current:** One try/catch wraps everything. A failure in `storeDispatch` (step 1) prevents `storeLibraryTaskMeta` (step 2) and `router.enqueue` (step 3) from running.
**Fix:** Wrap each step independently, or at minimum don't swallow errors silently — update session status to `"ingestion-failed"` or similar so it's externally visible.

#### R3. Move status update AFTER ingestion
**File:** `src/audio/worker.ts:147-157`
**Fix:** Move `updateSessionStatus(deps.sessionDb, sessionId, "done")` to AFTER `onIngest` completes. Or add a separate status for ingestion: `transcribed` → (onIngest) → `done`. This makes ingestion failure visible via the status API.

### Priority 2: Fix the Canary Test

#### R4. Use `initGatewayAudioCapture()` instead of `createGatewayAudioHandler()`
**File:** `src/audio/__tests__/canary.test.ts:105`
**Fix:** Replace `createGatewayAudioHandler({ workerDeps: { onIngest: spy } })` with `initGatewayAudioCapture()`. This exercises the real `onIngest` closure.

#### R5. Boot minimal Cortex/Router for canary
**Fix:** The canary needs functioning Cortex and Router singletons. Options:
- Boot real instances (SQLite + singletons, no LLM needed — `startCortex()` with a no-op `callLLM`)
- Or: inject singletons into `globalThis` before the test runs (mock the instance, not the callback)
- Or: at minimum, set `globalThis.__openclaw_router_instance__` to a stub Router with a working `enqueue()` that writes to a test DB

#### R6. Assert on DB-level side effects
**Fix:** After `onIngest` fires, query `cortex_task_dispatch` for a row with the session's `taskId`. Query `library_pending_tasks` for the URL. These are the integration contract — not "was a function called" but "did the function produce the expected side effects."

#### R7. Make canary FAIL when ingestion is broken
**Fix:** If `getGatewayCortex()` returns null in the canary, the test must fail — not silently skip ingestion. This is the entire point of the canary: detect when production is broken.

### Priority 3: Fix Other Tests with the Same Gap

#### R8. Fix gateway-init.test.ts Test 6
**File:** `src/audio/__tests__/gateway-init.test.ts:261-276`
**Fix:** This test should NOT validate "graceful failure" as a pass. It should boot minimal Cortex/Router stubs and verify that `onIngest` produces a dispatch row. The current test actively validates the bug.

#### R9. Fix real-e2e.test.ts Suite 1
**File:** `src/audio/__tests__/real-e2e.test.ts:242-465`
**Fix:** Suite 1 uses `initGatewayAudioCapture()` — the right init path. But it never checks ingestion. Add assertions that verify the real `onIngest` either succeeded (dispatch row exists) or that the test explicitly boots Cortex/Router singletons.

#### R10. Fix real-e2e.test.ts Suite 2
**File:** `src/audio/__tests__/real-e2e.test.ts:474-574`
**Fix:** Replace the spy with the production `onIngest`. Same approach as R5 — boot minimal singletons.

### Priority Ordering

| Priority | Fix | Reason |
|----------|-----|--------|
| **P0** | R1 (channel NOT NULL) | Production code is broken — no test fix matters until this is fixed |
| **P0** | R3 (status after ingestion) | Without this, no external observer can detect ingestion failure |
| **P1** | R2 (separate try/catch) | Makes failure modes independent and debuggable |
| **P1** | R4-R7 (canary overhaul) | The canary must catch this class of failure |
| **P2** | R8-R10 (other test fixes) | Prevent regression from other test suites |

### Key Insight

The canary test gap and the production bug are the same root cause: **nobody ever called the real `onIngest` in a context where it could succeed.** The production code has TWO independent silent failure modes (null singletons AND NOT NULL constraint), and the test suite has THREE layers of substitution that prevent any test from reaching either failure mode (spy callback, wrong factory function, validated-as-graceful-failure).

Fixing only the test without fixing the production code (R1, R2, R3) would result in a test that correctly catches a bug it cannot fix. Fixing only the production code without fixing the test would leave the next silent failure undetected. Both must change.

---

## Appendix: Evidence

### Audio Session (audio.sqlite)
```json
{
  "session_id": "089187ab-b4ea-45bc-8272-594abc889e10",
  "status": "done",
  "chunks_received": 5,
  "created_at": "2026-03-19 11:09:35",
  "completed_at": "2026-03-19T11:10:18.818Z",
  "error": null
}
```

### Cortex Bus (bus.sqlite) — No Audio-Related Entries
- `cortex_task_dispatch`: Zero rows with audio-capture task summaries for this session
- `library_pending_tasks`: Empty table
- `hippocampus_facts WHERE source_ref LIKE '%audio-capture%'`: Zero rows

### Config State
- `cortex/config.json`: `enabled: true` (current — may have differed at time of failure)
- `openclaw.json`: `router.enabled: true`, `audioCapture.enabled: true`

### NOT NULL Constraint Verification
```
SQLite: INSERT NULL into TEXT NOT NULL column → "NOT NULL constraint failed"
```
Confirmed: `storeDispatch()` with `channel: null` throws in production.
