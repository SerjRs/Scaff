# 046 — Token Monitor: Show Full Task Lifecycle

*Version: 1.0 — 2026-03-25*
*Status: Cooking*

---

## Problem

The token monitor only shows tasks when they finish. It should show tasks from the moment they're created — through evaluation, execution, and completion.

### What happens now

1. Cortex calls `library_ingest` → Router creates a job (status: `in_queue`)
2. Router evaluator picks it up (status: `evaluating`) → assigns tier (status: `pending`)
3. Router spawns executor (status: `in_execution`) → token monitor sees it IF the executor makes an LLM call
4. Executor finishes (status: `completed`) → `syncRouterStatuses()` catches it and updates the token monitor row

The token monitor's `syncRouterStatuses()` in `src/token-monitor/gateway-methods.ts` only queries:
- `completed`/`failed`/`canceled` jobs (last 2 min) — for status sync
- `in_execution`/`evaluating` jobs — for task text

It never queries `in_queue` or `pending`. And it only runs on snapshot poll (when the CLI refreshes), not on job creation.

### What the user sees

- Nothing when a task is dispatched
- Nothing during evaluation
- Maybe a brief "InProgress" if the executor runs long enough
- "Finished" for ~30 seconds, then auto-cleaned

### What the user expects

- Task appears immediately when dispatched ("Queued")
- Status updates through: Queued → Evaluating → InProgress → Finished/Failed

### Root cause

Two gaps:

1. **No early registration.** The ledger's `record()` only fires when LLM tokens are consumed. Tasks that don't use tokens (or haven't started yet) are invisible.

2. **`syncRouterStatuses()` ignores pre-execution states.** The SQL queries skip `in_queue` and `pending` jobs entirely.

## References

- Token monitor ledger: `src/token-monitor/ledger.ts` (in-memory singleton, `record()`, `snapshot()`, `updateStatusBySession()`)
- Token monitor gateway sync: `src/token-monitor/gateway-methods.ts` (`syncRouterStatuses()`, line ~74)
- Token monitor CLI display: `src/token-monitor/cli.ts`
- Router queue DB: `src/router/queue.ts` (`initRouterDb()`, `jobs` table)
- Router dispatch: `src/router/dispatch.ts` (where jobs are created)
- Cortex dispatch: `src/cortex/gateway-bridge.ts` (where Cortex creates dispatch tasks)
- Ledger job-session map: `ledger.ts` `registerJobSession()` — maps router jobId → sessionId

## Fix

### Change 1: Expand `syncRouterStatuses()` to include all job states

In `src/token-monitor/gateway-methods.ts`, add a third query for `in_queue` and `pending` jobs:

```sql
SELECT id, status, payload, worker_id FROM jobs
WHERE status IN ('in_queue', 'pending', 'evaluating')
```

For each row:
- If no ledger entry exists for this job, call `record()` with `tokensIn: 0` to create a placeholder row
- Set status to `"Queued"` for `in_queue`/`pending`, `"InProgress"` for `evaluating`
- Extract task summary from payload

### Change 2: Add "Queued" status to the ledger

In `src/token-monitor/ledger.ts`:
- Add `"Queued"` to `TokenRowStatus` type: `"Active" | "Queued" | "InProgress" | "Finished" | "Canceled" | "Failed"`
- `"Queued"` is NOT a terminal status (no auto-cleanup)
- Stale Queued cleanup: rows in `"Queued"` with no activity for 5+ minutes → mark `"Failed"` (orphaned)

### Change 3: CLI display for Queued status

In `src/token-monitor/cli.ts`:
- Render `"Queued"` rows with appropriate styling (e.g. dim/yellow)
- Show task summary even for queued rows

### Change 4 (optional): Register on dispatch, not just on sync

Currently tasks appear only on the next CLI poll (when `syncRouterStatuses` runs). For immediate appearance, the Router's `dispatch()` or `enqueue()` function could call `record()` directly when a job is created. This makes tasks appear instantly instead of on next poll.

This is optional because the poll interval is fast enough (~1s) for most cases. But for a clean architecture, dispatch-time registration is better.

## Status transitions

```
Job created (in_queue)     → Ledger: "Queued"
Evaluator picks up         → Ledger: "InProgress" (via evaluating status)
Executor assigned (pending)→ Ledger: "Queued" (still waiting)
Executor starts            → Ledger: "InProgress" (via in_execution + LLM tokens)
Executor finishes          → Ledger: "Finished"/"Failed"
                           → Auto-cleanup after 30s
```

## Acceptance criteria

- [ ] Token monitor shows tasks immediately when dispatched (within 1 poll cycle)
- [ ] Status transitions visible: Queued → InProgress → Finished
- [ ] Task summary visible for all states (extracted from job payload)
- [ ] Stale queued tasks auto-cleanup after 5 min
- [ ] No regression: existing Active/InProgress/Finished behavior unchanged
- [ ] Works for both Cortex-dispatched tasks (library_ingest) and Router-spawned tasks (sessions_spawn)

## Complexity

~1 session. Small change — expand one SQL query, add one status value, update CLI rendering.
