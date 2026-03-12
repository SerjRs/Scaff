---
id: "006"
title: "Router inactivity-based timeout (replace blind 5min TTL)"
created: 2026-03-12
author: scaff
executor: TBD
branch: ""
pr: ""
priority: high
status: cooking
moved_at: 2026-03-12
---

# 006 — Router Inactivity-Based Timeout

## Problem

The Router kills executors after a blind 5-minute TTL regardless of whether the executor is actively working. This caused a real incident (2026-03-11): an executor was making tool calls every 2-6 seconds, completed successfully at 17:21:41, but the Router had already killed it at 17:21:23 — 18 seconds too early.

**Source:** `docs/working/cortex-freeze-investigation-2026-03-11.md` § Finding 3, § P3

## Root Cause Analysis

The timeout lives in `src/router/gateway-integration.ts` inside `createGatewayExecutor()`:

```typescript
const response = await callGateway<...>({
  method: "agent",
  params: { message: prompt, sessionKey, deliver: false, idempotencyKey },
  expectFinal: true,
  timeoutMs: 5 * 60 * 1000,  // ← THIS IS THE BLIND 5-MINUTE KILLER
});
```

`callGateway` with `expectFinal: true` waits for the agent's final response via WebSocket. When `timeoutMs` expires, it throws — the worker catches it as a failure.

Meanwhile, the worker's 30s heartbeat (`worker.ts`) keeps `last_checkpoint` fresh in the DB, so the loop's watchdog (90s hung threshold in `loop.ts`) never fires — it thinks the worker is alive (it is, it's just waiting on `callGateway`).

**The disconnect:** Worker heartbeat tracks "is the worker process alive?", not "is the executor session doing anything useful?". The executor could be actively making tool calls, but the `callGateway` timeout doesn't know or care.

## Architecture (Current)

```
loop.ts          worker.ts           gateway-integration.ts          Agent Session
   │                 │                         │                          │
   ├─dispatch()──►  run()                      │                          │
   │                 ├──setInterval(30s)───►  heartbeat (last_checkpoint)  │
   │                 ├──executor(prompt,model)──►                          │
   │                 │                         ├──callGateway(expectFinal) │
   │                 │                         │   timeoutMs: 5min  ◄──── BLIND
   │                 │                         │                    ──────►│ tool calls
   │                 │                         │                    ◄──────│ every 2-6s
   │                 │                         │   TIMEOUT at 5min!        │
   │                 │                    ◄────┤   throws Error            │ still working...
   │                 ├──catch(error)            │                          │ finishes 18s later
   │                 ├──job.status='failed'     │                          │
   │                 │                         │                          │
   ▼ watchdog(90s)   │                         │                          │
     checks last_checkpoint ─── always fresh (heartbeat) ─── never triggers
```

## Solution: Two-Phase Implementation

### Phase 1: Weight-Based Dynamic Timeout (prevents the incident)

Replace the fixed 5-minute `timeoutMs` with a weight-based hard cap. The evaluator already scores task complexity (1-10). Use it:

| Weight | Tier   | Hard Cap  | Use Case                     |
|--------|--------|-----------|------------------------------|
| 1-3    | haiku  | 5 minutes | Simple lookups, Q&A          |
| 4-6    | sonnet | 10 minutes| Moderate analysis, small code |
| 7-10   | opus   | 15 minutes| Complex code, multi-step work |

**This alone would have prevented the incident.** The task was weight 7 → 15min cap. It completed in 5min 50s.

#### Changes

**1. `src/router/types.ts` — Extend `AgentExecutor` signature**

```typescript
// Before:
export type AgentExecutor = (prompt: string, model: string) => Promise<string>;

// After:
export type AgentExecutor = (prompt: string, model: string, options?: ExecutorOptions) => Promise<string>;

export interface ExecutorOptions {
  /** Task weight (1-10) from evaluator. Determines timeout. */
  weight?: number;
  /** AbortSignal for external cancellation (Phase 2). */
  signal?: AbortSignal;
}
```

**2. `src/router/gateway-integration.ts` — Dynamic timeout**

In `createGatewayExecutor()`:

```typescript
// Before:
return async (prompt: string, model: string): Promise<string> => {
  // ...
  timeoutMs: 5 * 60 * 1000,
  // ...
};

// After:
return async (prompt: string, model: string, options?: ExecutorOptions): Promise<string> => {
  const weight = options?.weight ?? 5;
  const timeoutMs = weightToTimeoutMs(weight);
  // ...
  const response = await callGateway<...>({
    // ...
    expectFinal: true,
    timeoutMs,
  });
  // ...
};
```

New helper:

```typescript
/** Map evaluator weight (1-10) to executor timeout in ms */
function weightToTimeoutMs(weight: number): number {
  if (weight <= 3) return 5 * 60 * 1000;   // 5 min
  if (weight <= 6) return 10 * 60 * 1000;  // 10 min
  return 15 * 60 * 1000;                   // 15 min
}
```

**3. `src/router/dispatcher.ts` — Pass weight through**

In `dispatch()`, pass weight to `run()`:

```typescript
// Before:
void run(db, job.id, prompt, model, executor, taskLabel);

// After:
void run(db, job.id, prompt, model, executor, taskLabel, weight);
```

**4. `src/router/worker.ts` — Forward weight to executor**

In `run()`:

```typescript
// Before:
export async function run(db, jobId, prompt, model, executor, taskLabel?): Promise<void> {
  // ...
  const result = await executor(prompt, model);
  // ...
}

// After:
export async function run(db, jobId, prompt, model, executor, taskLabel?, weight?): Promise<void> {
  // ...
  const result = await executor(prompt, model, { weight });
  // ...
}
```

**5. `src/router/loop.ts` — Weight-aware watchdog**

In `watchdogTick()`, use weight-based thresholds instead of fixed 90s:

```typescript
// Before:
const hungJobs = getHungJobs(db, HUNG_THRESHOLD_SECONDS);

// After:
// Check each weight tier separately
const lightJobs = getHungJobsByWeight(db, 1, 3, 150);   // 2.5min no heartbeat
const mediumJobs = getHungJobsByWeight(db, 4, 6, 300);  // 5min no heartbeat
const heavyJobs = getHungJobsByWeight(db, 7, 10, 450);  // 7.5min no heartbeat
const hungJobs = [...lightJobs, ...mediumJobs, ...heavyJobs];
```

Or simpler: keep `getHungJobs` but compute threshold per-job:

```typescript
function hungThresholdForWeight(weight: number | null): number {
  const w = weight ?? 5;
  if (w <= 3) return 150;   // 2.5 min
  if (w <= 6) return 300;   // 5 min
  return 450;               // 7.5 min
}
```

**6. `src/router/queue.ts` — Update `getHungJobs` (if needed)**

If the per-job threshold approach is used, `getHungJobs` may need a variant that returns all `in_execution` jobs and lets the caller filter. Or keep the existing function and call it with the most generous threshold, then filter in `watchdogTick()`.

### Phase 2: Inactivity-Based Detection (proper fix, deferred)

Phase 1 uses weight as a proxy for "how long should this take". Phase 2 adds actual activity monitoring.

**Concept:** The worker tracks the executor's session activity. If the executor session hasn't made a tool call in 5 minutes, it's considered stuck — regardless of weight.

This requires:
- Exposing the executor's session key from `createGatewayExecutor()` back to the worker
- Worker's heartbeat checks session activity (via `callGateway({ method: "sessions.get" })` or similar)
- If inactive for `INACTIVITY_THRESHOLD_MS` (5 min), abort via `AbortController`

**Not in scope for Phase 1.** Phase 1's weight-based timeout is sufficient to unblock task 005 (Coding Executor).

## Files Changed (Phase 1)

| File | Change |
|------|--------|
| `src/router/types.ts` | Add `ExecutorOptions` interface, update `AgentExecutor` type |
| `src/router/gateway-integration.ts` | `weightToTimeoutMs()` helper, dynamic `timeoutMs`, accept `options` param |
| `src/router/worker.ts` | Accept `weight` param in `run()`, pass to executor as `options.weight` |
| `src/router/dispatcher.ts` | Pass `weight` to `run()` |
| `src/router/loop.ts` | Weight-aware hung thresholds in `watchdogTick()` |
| `src/router/queue.ts` | Possibly update `getHungJobs()` or add weight-aware variant |

## Tests

### Unit Tests — `src/router/__tests__/weight-timeout.test.ts` (new)

1. **`weightToTimeoutMs` returns correct values** — weight 1→5min, 3→5min, 4→10min, 6→10min, 7→15min, 10→15min
2. **`weightToTimeoutMs` handles edge cases** — null/undefined defaults to 5 (10min), weight 0→5min, weight 11→15min
3. **`executor receives weight in options`** — mock executor verifies `options.weight` matches dispatched weight

### Worker Tests — update `src/router/worker.test.ts`

4. **`run() passes weight to executor`** — mock executor, call `run()` with weight=7, verify executor received `{ weight: 7 }`
5. **`run() works without weight (backward compat)`** — call `run()` without weight, executor receives `{ weight: undefined }`
6. **`existing worker tests still pass`** — all 12 current tests unmodified

### Dispatcher Tests — update `src/router/dispatcher.test.ts`

7. **`dispatch passes weight to run()`** — verify `run()` called with job's weight value

### Loop Tests — update `src/router/loop.test.ts`

8. **`watchdog uses weight-based threshold for light tasks`** — weight=2 job with stale checkpoint (3min) → detected as hung
9. **`watchdog uses weight-based threshold for heavy tasks`** — weight=8 job with stale checkpoint (3min) → NOT detected as hung (threshold is 7.5min)
10. **`watchdog detects heavy task as hung after weight threshold`** — weight=8 job with stale checkpoint (8min) → detected as hung
11. **`existing loop tests still pass`** — all 16 current tests unmodified

### Gateway Integration Tests — update `src/router/gateway-integration.test.ts`

12. **`executor uses weight-based timeout for light tasks`** — weight=2 → verify callGateway called with `timeoutMs: 300000`
13. **`executor uses weight-based timeout for heavy tasks`** — weight=9 → verify callGateway called with `timeoutMs: 900000`
14. **`executor defaults to 10min when no weight provided`** — no options → `timeoutMs: 600000`

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Longer timeouts → stuck jobs burn more tokens | Watchdog still catches hung workers; 15min hard cap limits damage |
| Weight miscalculation (evaluator rates complex task as light) | Evaluator already has Sonnet verification for weight>3; fallback weight=5 gets 10min |
| Breaking `AgentExecutor` type consumers | `options` param is optional; existing callers work unchanged |
| Test flakiness with timeout-dependent tests | Use fake timers (vitest); never depend on real wall-clock time |

## Dependencies

- None (standalone fix)

## Blocks

- Task 005 (Coding Executor) — Claude Code tasks run 5-15min, need this to not get killed
