# TokenMonitor Fix Spec

**Created:** 2026-03-09
**Status:** In Progress
**Author:** Scaff (Cortex)

---

## Problem

TokenMonitor has two issues:
1. When a task finishes execution, it stays visible in the monitor with no indication it's done — unclear if it's still working or dead
2. No way to identify which OS process a model row belongs to — can't kill stuck processes

## Solution

### Task 1: Add PID Column
- [ ] Add PID as the **first column** in the TokenMonitor display
- [ ] For separate processes (Ollama, Main Agent shell): show the OS process ID
- [ ] For in-process executors (Router tasks running inside gateway): show the task ID prefixed with `T:` (e.g. `T:813e79ca`)
- [ ] PID should be captured when the model session starts

**Test:** Start a task via Router, verify PID/TaskID appears in the first column. Kill a process by PID and confirm it works.

**Status:** ⬜ Not Started

---

### Task 2: Add Status Column
- [ ] Add Status as the **last column** in the TokenMonitor display
- [ ] Status values:
  - `Active` — persistent agents (Cortex, Main Agent) that run continuously
  - `InProgress` — one-shot tasks currently executing
  - `Finished` — task completed successfully
  - `Canceled` — task was canceled
  - `Failed` — task errored out
- [ ] Status must update in real-time when a task completes, fails, or is canceled
- [ ] Data source: poll router queue DB (`router/queue.sqlite`) for task status, or subscribe to completion events if available

**Test:** Run a task, watch it go from `InProgress` → `Finished`. Cancel a task, confirm it shows `Canceled`. Verify Cortex and Main Agent show `Active` permanently.

**Status:** ⬜ Not Started

---

### Task 3: Auto-cleanup of Finished Rows
- [ ] Finished/Canceled/Failed rows remain visible for **30 seconds** after status change
- [ ] After 30s, row is removed from the display
- [ ] Active and InProgress rows never auto-remove

**Test:** Complete a task, confirm row stays for ~30s with status shown, then disappears.

**Status:** ⬜ Not Started

---

### Task 4: Column Layout Update
- [ ] Final column order: `PID | Model | Channel | Tokens In | Tokens Out | Duration | Status`
- [ ] Ensure alignment and formatting is clean in the terminal display
- [ ] PID column width: 12 chars (accommodates both PIDs and `T:` + 8-char task ID)
- [ ] Status column width: 12 chars

**Test:** Visual inspection — all columns aligned, no overflow or wrapping on standard terminal width.

**Status:** ⬜ Not Started

---

---

### Task 5: Add Task Column
- [x] Add a "Task" column **after** the Model column
- [x] New column order: `PID | Model | Task | Channel | Tokens In | Tokens Out | Duration | Status`
- [x] Task column shows a SHORT summary (max 40 chars, truncated with "..." if longer)
- [x] For persistent agents with `Active` status (no task set): show `"Live session"`
- [x] For router executor tasks in `in_execution`: show first ~40 chars of `payload.message` from router queue DB
- [x] For jobs with `evaluating` status: show `"Evaluating task"`
- [x] Task column width: 42 chars (40 + 2 padding)
- [x] Task text synced from router queue DB on every `usage.tokens` snapshot request
- [x] `task` field added to `TokenLedgerRow` and `TokenLedgerEvent` types
- [x] New `updateTaskBySession()` function in ledger for in-process updates
- [x] `pnpm build` passes with no errors

**Status:** ✅ Completed — 2026-03-09

---

## Progress Log

| Task | Started | Completed | Notes |
|------|---------|-----------|-------|
| 1    |         |           |       |
| 2    |         |           |       |
| 3    |         |           |       |
| 4    |         |           |       |
| 5    | 2026-03-09 | 2026-03-09 | Task column added after Model; syncs from router queue DB payload |

## Files Modified

- `src/token-monitor/cli.ts` — Added `colTask = 42`, `resolveTaskLabel()`, Task column in header/rows/totals/divider
- `src/token-monitor/ledger.ts` — Added `task?` to `TokenLedgerRow` + `TokenLedgerEvent`; new `updateTaskBySession()` function
- `src/token-monitor/gateway-methods.ts` — Added `extractTaskSummary()`, active-job task sync in `syncRouterStatuses()`
- `src/token-monitor/index.ts` — Exported `updateTaskBySession`