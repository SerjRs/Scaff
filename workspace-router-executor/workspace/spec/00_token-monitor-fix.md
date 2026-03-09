# TokenMonitor Fix Spec

**Created:** 2026-03-09
**Last Updated:** 2026-03-09 16:15
**Author:** Scaff (Cortex)

---

## Current State

TokenMonitor has 8 columns: PID | MODEL | TASK | CHANNEL | TOKENS-IN | TOKENS-OUT | DURATION | STATUS

### What works
- PID column shows gateway PID or T:taskId for executor tasks
- Status column shows Active/InProgress/Finished
- Finished executor rows auto-cleanup after 30s
- Single TOTAL row (fixed)
- Column layout and alignment correct
- Cortex shows "Live session" in Task column

### What's broken — 3 remaining bugs

---

## Bug 1: Task Column Empty for All Rows Except Cortex

**Priority:** HIGH
**Status:** ✅ Complete — 2026-03-09 16:21

**Symptom:** Every row except Cortex shows blank in the TASK column. Executors, evaluators, and Main Agent all show empty.

**Root cause analysis:**
- `resolveTaskLabel()` in `cli.ts` returns "Live session" only for Active rows with no task set — only Cortex qualifies
- `syncRouterStatuses()` in `gateway-methods.ts` should read the `request` column from router/queue.sqlite jobs table and call `updateTaskBySession()` — but the session ID mapping (jobToSession map) likely doesn't resolve
- `extractTaskSummary()` in `gateway-methods.ts` should parse and truncate task descriptions to 40 chars — but may never be called
- There are 184 uncommitted lines in gateway-integration.ts (+22), worker.ts (+13), stream-hook.ts (+12) that may contain wiring fixes not yet built/deployed
- Evaluators are not router jobs so syncRouterStatuses() doesn't see them at all

**Fix plan:**
1. Check if uncommitted changes in src/router/gateway-integration.ts and src/router/worker.ts contain the jobToSession registration. If yes, commit and build first
2. Verify extractTaskSummary() is being called during syncRouterStatuses() with the job request text
3. Ensure updateTaskBySession() correctly matches the ledger row by session ID
4. For executors: show first 40 chars of task request with "..." if truncated
5. For evaluators: show "Evaluating task" — requires hooking into evaluator lifecycle (not router jobs)
6. For Main Agent: show "Live session" — requires recognizing Main Agent as persistent (see Bug 2)

**Source files:** src/token-monitor/gateway-methods.ts, src/token-monitor/ledger.ts, src/token-monitor/cli.ts, src/router/gateway-integration.ts, src/router/worker.ts

**Test:** Spawn a task via Router. Verify executor row shows truncated task description. Verify evaluator shows "Evaluating task". Verify Main Agent shows "Live session".

---

## Bug 2: Main Agent Stuck as InProgress (Should Be Active)

**Priority:** MEDIUM
**Status:** ✅ Complete — 2026-03-09 16:21

**Symptom:** Main Agent row shows InProgress forever with unchanging token counts (3 in, 189 out). It should show Active like Cortex since it's a persistent session.

**Root cause analysis:**
- The code that assigns Active status only recognizes Cortex (channel === "cortex")
- Main Agent channel shows as "main" — not included in the persistent agent check
- Main Agent is a long-lived session, not a one-shot task

**Fix plan:**
1. In ledger.ts record() or wherever status is assigned, add "main" to the list of channels that get Active status
2. This should be a simple check: if channel is "cortex" OR "main", status = Active
3. Once Active, resolveTaskLabel() will also return "Live session" for Main Agent

**Source files:** src/token-monitor/ledger.ts, src/token-monitor/stream-hook.ts

**Test:** After restart, verify Main Agent row shows Active status and "Live session" in Task column.

---

## Bug 3: Evaluator Rows Accumulate as Stale InProgress

**Priority:** MEDIUM
**Status:** ✅ Complete — 2026-03-09 16:21

**Symptom:** Evaluator rows pile up over time. Old evaluators stay as InProgress forever. New evaluator runs add new rows instead of replacing old ones. They never transition to Finished and never get cleaned up.

**Root cause analysis:**
- Evaluators are NOT router jobs — they run as part of the evaluation stage before a job is created
- syncRouterStatuses() only checks the router queue jobs table — evaluators are invisible to it
- Evaluator sessions complete but nothing calls updateStatus() to mark them as Finished
- Without Finished status, the 30s auto-cleanup never fires
- Each new evaluation creates a new session ID, so old rows are orphaned

**Fix plan:**
1. Hook into evaluator completion in src/router/evaluator.ts — when evaluation finishes (success or failure), call updateStatusBySession() to mark the evaluator ledger row as Finished
2. Alternatively, add evaluator lifecycle tracking in gateway-methods.ts syncRouterStatuses() — check if evaluator sessions have been idle for >60s and mark them Finished
3. Ensure evaluator rows properly dedup — if evaluator uses same session pattern, key should upsert

**Source files:** src/router/evaluator.ts, src/token-monitor/gateway-methods.ts, src/token-monitor/ledger.ts

**Test:** Run a task through the router. Verify evaluator shows as InProgress during evaluation, transitions to Finished when done, disappears after 30s.

---

## Completed Tasks (for reference)

### Task 1: Add PID Column ✅
Commit: Part of Main Agent implementation
33/33 tests passing

### Task 2: Add Status Column ✅
Commit: Part of Main Agent implementation
Status values: Active, InProgress, Finished, Canceled, Failed

### Task 3: Auto-cleanup of Finished Rows ✅
30s cleanup delay working for rows that reach Finished status

### Task 4: Column Layout Update ✅
8-column layout with color-coded status

### Task 5: Add Task Column ✅
Commit: 58a76de71
Task column renders between Model and Channel. Only populates for Cortex currently.

### Previous fix attempts:
- Commit bf70d9e6f: dedup + status transitions + stale cleanup (partially effective)
- Commit cb099cfab: remove duplicate recording paths (partially effective)
- 184 uncommitted lines may contain additional fixes not yet built

---

## Progress Log

| Task | Started | Completed | Notes |
|------|---------|-----------|-------|
| 1 - PID Column | 2026-03-09 | 2026-03-09 | ✅ Working |
| 2 - Status Column | 2026-03-09 | 2026-03-09 | ✅ Working |
| 3 - Auto-cleanup | 2026-03-09 | 2026-03-09 | ✅ Working |
| 4 - Layout | 2026-03-09 | 2026-03-09 | ✅ Working |
| 5 - Task Column | 2026-03-09 | 2026-03-09 | ⚠️ Only Cortex populates |
| 6 - Task Labels | 2026-03-09 | 2026-03-09 | ✅ Evaluator records "Evaluating task"; executors via syncRouterStatuses; Active rows → "Live session" |
| 7 - Main Agent Active | 2026-03-09 | 2026-03-09 | ✅ channel "main" now treated as persistent → Active status |
| 8 - Evaluator Cleanup | 2026-03-09 | 2026-03-09 | ✅ verifySonnet marks session Finished/Failed → 30s auto-cleanup |

## Files Modified (all changes)

- src/token-monitor/ledger.ts
- src/token-monitor/stream-hook.ts
- src/token-monitor/cli.ts
- src/token-monitor/gateway-methods.ts
- src/token-monitor/index.ts
- src/router/worker.ts
- src/router/gateway-integration.ts
- src/router/evaluator.ts (pending)
- src/agents/cli-runner.ts
- src/agents/pi-embedded-subscribe.ts
- src/cortex/llm-caller.ts
