# Claude Code Instructions — 067b

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067b-loop-detection` from main.
2. Commit frequently with format: `[067b] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Bounce Check in Scheduler (`core/scheduler.py`)
- In `_schedule_agents()`, before calling `spawn_agent()`, check `task.lifetime_bounces >= config.max_lifetime_bounces`
- If exceeded: set status to `LOOP_DETECTED`, log event, skip spawn
- This goes BEFORE the existing dependency check (which only applies to EXECUTION stage)
- The check applies to ALL active stages, not just EXECUTION

### 2. DB Updates for Loop Detection
- Use `db.update_task_state(task.id, status="LOOP_DETECTED")` — no schema changes needed, status is a free-text field
- Use `db.log_event(task.id, "loop_detected", stage_from=task.stage, details=...)` for audit trail
- Do NOT modify `core/db.py` — the existing API surface is sufficient

### 3. Config Verification
- `PipelineConfig.max_lifetime_bounces` already exists (default: 8)
- Verify it's accessible in `_schedule_agents` via `config.max_lifetime_bounces`
- No changes to `core/config.py` expected

### 4. Test
- Add test in `tests/test_scheduler.py`
- Create a task with `lifetime_bounces >= max_lifetime_bounces` (e.g. set to 8)
- Call `_schedule_agents(db, config)` and assert:
  - Task status is `LOOP_DETECTED`
  - Task was NOT spawned (still no agent_pid)
  - Event was logged via `db.log_event`
- Follow existing test patterns: use `setup_db` fixture, `_make_config` helper

## Do NOT Modify
- `core/db.py` — no schema changes, no new functions
- `core/config.py` — field already exists
- `core/monitor.py` — unrelated
- `agents/base.py` — unrelated

## Tests
- Run full suite: `cd orchestrator && uv run pytest -v`
- All 93 existing tests must still pass
- New test must pass

## Important
- `LOOP_DETECTED` is a terminal status — the task freezes until human intervention (retry via API or CLI)
- The existing `retry` endpoint already handles re-enabling loop-detected tasks (sets status back to PENDING)
- Keep it simple — this is a ~15-line change in scheduler + ~30-line test

## Execution
Do NOT ask questions. Execute the full task end-to-end.
