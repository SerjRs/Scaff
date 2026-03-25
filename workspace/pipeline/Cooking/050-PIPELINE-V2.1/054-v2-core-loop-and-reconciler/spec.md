---
id: 054
title: V2 Core Loop & Startup Reconciler
priority: P1
status: Cooking
branch: feat/054-v2-core-loop-and-reconciler
epic: 050-PIPELINE-V2.1
---

# Specification: V2 Core Loop & Reconciler

## Objective
Implement the Orchestrator's continuous event loop (`core/scheduler.py`) and the startup crash recovery mechanism (`core/reconciler.py`). This is the engine that actually moves tasks through the pipeline, enforces concurrency limits, checks dependencies, and recovers from dirty states.

## Architecture & Context
The Orchestrator operates on a 10-second tick loop using `asyncio`. It relies on SQLite as the source of truth but trusts the filesystem for physical folder locations. The reconciler runs exactly once at startup to fix any mismatches between the two.

## Implementation Requirements

### 1. Configuration & Utils
- Update `core/config.py` to include `concurrency` (dict mapping stage to int), `sla_timeouts` (dict), and `tick_interval_seconds` (default 10).
- Create `core/priority.py` to handle regenerating the human-readable `PRIORITY.MD` files in each stage folder by querying the SQLite database.

### 2. Startup Reconciler (`core/reconciler.py`)
Implement `async def reconcile(db, config)`:
- Iterate over all stage directories in the `pipeline_root`.
- For each task folder found, compare its location against the SQLite `tasks` table.
- **Orphan folders:** If no DB record exists, insert a new record matching the current folder stage.
- **Stage Mismatch:** If the DB stage != folder stage (e.g., crashed mid-move), update the DB to match the folder location and set status to `PENDING`.
- **Dead WIP:** If DB status is `WIP` but `agent_pid` is None or the PID is no longer running, reset status to `PENDING` and increment `stage_attempts`.

### 3. Core Loop (`core/scheduler.py`)
Implement `async def orchestrator_loop(db, config)`:
- Run an infinite `while True` loop with `await asyncio.sleep(config.tick_interval_seconds)`.
- **Step 1:** Drain `knowledge_appends` table (sequentially, writing to `KNOWLEDGE/ARCHITECTURE.md`) and drain `priority_patches` table (applying to tasks).
- **Step 2:** For each stage in `PIPELINE_STAGES`:
  - Count `WIP` tasks. Calculate available slots: `config.concurrency[stage] - active`.
  - Fetch up to `slots` `PENDING` tasks.
  - Check dependencies: If stage is `EXECUTION`, read `DEPS.MD` (if present). If dependencies are not `DONE` in DB, set task status to `BLOCKED`.
  - If slots are open and dependencies met, call a stubbed `spawn_agent(stage, task)`. (For now, `spawn_agent` just updates DB status to `WIP` and logs it—actual subprocess management comes in a later task).
- **Step 3:** Check SLA timers. Query DB for `WIP` tasks exceeding `config.sla_timeouts[stage]`. Reset them to `PENDING` (or `FAILED` if max attempts exceeded).
- **Step 4:** Call the `PRIORITY.MD` generator to update the markdown files.

## Testing Requirements
- Create `tests/test_reconciler.py` to test the 3 mismatch scenarios using a mocked DB and temporary filesystem.
- Create `tests/test_scheduler.py` to test the loop logic (dependency blocking, concurrency limits) using `unittest.mock.AsyncMock`.