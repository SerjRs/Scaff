# Claude Code Instructions — 067j

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067j-cancel-reason-fix` from main.
2. Commit frequently with format: `[067j] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. REST Cancel — Add `triggered_by: human` (`api/rest.py`)
- In `cancel_task()`, add `- **triggered_by:** human\n` to the CANCEL-REASON.md content
- Insert it after the existing fields (task_id, timestamp, cancelled_from_stage, reason)

### 2. MCP Cancel — Add `triggered_by: agent` (`api/mcp.py`)
- In `orchestrator_signal_cancel()`, add `- **triggered_by:** agent\n` to the CANCEL-REASON.md content
- Same position as REST version

### 3. That's It
- Two lines of code. One in each file. Identical pattern, different value.

## Do NOT Modify
- `core/db.py` — no changes
- `core/config.py` — no changes
- `core/scheduler.py` — no changes
- `agents/base.py` — no changes
- `core/filesystem.py` — no changes

## Tests
- Update existing cancel tests in `tests/test_api.py` and `tests/test_mcp.py` to verify `triggered_by` appears in CANCEL-REASON.md
- Run full suite: `cd orchestrator && uv run pytest -v`
- All 93 existing tests must still pass

## Important
- Keep the markdown format consistent with existing CANCEL-REASON.md fields
- Both files write CANCEL-REASON.md with the same template — just add one line to each

## Execution
Do NOT ask questions. Execute the full task end-to-end.
