# Claude Code Instructions — 064

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/064-fix-task-path-tracking` from main.
2. Commit frequently with format: `[064] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Single file change: `core/filesystem.py` → `move_task()`
- Add `task_path=str(dest)` to the `update_task_state()` call
- The `update_task_state` function accepts arbitrary kwargs — `task_path` is a valid column
- Add/update tests in `tests/test_filesystem.py`

## Tests
Run: `cd orchestrator && uv run pytest tests/test_filesystem.py -v`
Then: `cd orchestrator && uv run pytest -v` (full suite)

## Execution
Do NOT ask questions. Execute the full task end-to-end.
