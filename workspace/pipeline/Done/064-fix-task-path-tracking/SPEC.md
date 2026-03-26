# Task 064: Fix task_path Tracking on Stage Moves

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Fix `task_path` in the DB so it always reflects the task's current filesystem location. Currently, `task_path` is set once at creation and never updated when a task moves between stages, causing agents to read/write to stale paths.

## Problem

When a task is created (e.g., by the reconciler finding it in COOKING), `task_path` is set to `../pipeline/COOKING/<task-id>`. When the task moves through stages (COOKING → TODO → ARCHITECTING → ...), `move_task()` in `filesystem.py` moves the folder but `task_path` in the DB still points to the original COOKING location.

**Consequences:**
- `spawn_agent()` uses `task.task_path` to write `PROMPT.md` and `AGENT.log`
- With a stale path, it recreates the old directory and writes files there
- The agent gets a PROMPT.md in a ghost directory with no SPEC.md
- The real task folder (in ARCHITECTING) has no PROMPT.md or AGENT.log

This caused complete task loss during the first E2E run — SPEC.md disappeared and the agent ran blind.

## Root Cause

`core/filesystem.py` → `move_task()` moves the folder and updates `stage` and `status` in the DB, but does NOT update `task_path`.

## Fix

In `move_task()`, after moving the folder, update `task_path` in the DB to reflect the new location:

```python
# In move_task(), after shutil.move and before db.update_task_state:
new_task_path = str(dest)  # the new folder path after move
await db.update_task_state(
    task_id,
    stage=to_stage,
    status="PENDING",
    stage_attempts=0,
    entered_stage_at=now,
    task_path=new_task_path,  # <-- ADD THIS
)
```

## Files to Modify

- `core/filesystem.py` — update `task_path` in `move_task()`

## Testing Requirements

- Update `tests/test_filesystem.py` — verify `task_path` is updated after `move_task()`
- Add a test that moves a task through 2+ stages and asserts `task_path` matches at each step

## Acceptance Criteria

- [ ] `move_task()` updates `task_path` in the DB to the new location
- [ ] After any stage transition, `task.task_path` points to the correct folder
- [ ] Existing tests pass
- [ ] New test verifies multi-stage path tracking
