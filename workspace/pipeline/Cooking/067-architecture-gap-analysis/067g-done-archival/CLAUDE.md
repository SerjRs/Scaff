# Claude Code Instructions — 067g

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067g-done-archival` from main.
2. Commit frequently with format: `[067g] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Add Archival Step to Scheduler (`core/scheduler.py`)
- Add `async def _archive_done_tasks(db, config)` function
- Query all tasks in DONE stage with `completed_at` older than `config.done_retention_days`
- Move folder from `DONE/<task-id>` to `DONE/archive/<task-id>`
- Update `task_path` in DB via `db.update_task_state(task_id, task_path=new_path)`
- Do NOT run every tick — use a counter or timestamp to run once per hour (e.g., every 360 ticks at 10s interval)

### 2. Add Config (`core/config.py`)
- Add `done_retention_days: int = 90` to PipelineConfig
- Add to `_SCALAR_KEYS` set for YAML parsing

### 3. Wire into Orchestrator Loop
- In `orchestrator_loop()`, call `_archive_done_tasks(db, config)` but throttled
- Simple approach: use a tick counter, run every N ticks
- Or: track `_last_archive_check` as a module-level datetime

### 4. Filesystem Move
- Use `shutil.move` (same as `move_task`)
- Create `DONE/archive/` directory if it doesn't exist
- Do NOT use `move_task()` — archival doesn't need stage transition logic

## Do NOT Modify
- `core/db.py` — no schema changes (task_path update via existing `update_task_state`)
- `core/filesystem.py` — archival is simpler than stage moves, keep it in scheduler
- `agents/base.py` — unrelated
- `api/` — no API changes

## Tests
- Add test in `tests/test_scheduler.py` for archival logic
- Create a DONE task with `completed_at` older than retention period
- Verify folder moved to `DONE/archive/`
- Verify `task_path` updated in DB
- Verify recent DONE tasks are NOT archived
- Run full suite: `cd orchestrator && uv run pytest -v`

## Important
- Only archive tasks with `completed_at` set (some DONE tasks may not have it — skip them)
- Parse `completed_at` as ISO 8601 datetime, compare with `datetime.now(UTC)`
- The archive directory is `config.pipeline_root / "DONE" / "archive"`
- Archived tasks should remain queryable in DB (just with updated task_path)
- This is a low-frequency operation — performance is not critical

## Execution
Do NOT ask questions. Execute the full task end-to-end.
