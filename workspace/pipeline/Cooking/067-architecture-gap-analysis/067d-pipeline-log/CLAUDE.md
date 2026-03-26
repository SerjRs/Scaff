# Claude Code Instructions — 067d

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067d-pipeline-log-audit` from main.
2. Commit frequently with format: `[067d] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Create `core/pipeline_log.py`
- Single function: `append_log(pipeline_root: Path, event: str, task_id: str, **kwargs)`
- Writes one JSON line to `{pipeline_root}/PIPELINE.log`
- Always includes: `ts` (ISO 8601 UTC), `event`, `task_id`
- Extra kwargs become additional fields (e.g. `stage`, `from_stage`, `to_stage`, `model`, `pid`, `reason`)
- Use `json.dumps` + file append — keep it simple, no external deps
- Must be sync (called from both sync and async contexts) — use regular `open()` not `aiofiles`
- Handle write errors gracefully (log warning, don't crash the orchestrator)

### 2. Hook into State Transitions
- `core/filesystem.py` → `move_task()`: after successful move, call `append_log(config.pipeline_root, "stage_transition", task_id, from_stage=from_stage, to_stage=to_stage)`
- Need to pass `config` (or just `pipeline_root`) to `move_task` — it already receives `config`

### 3. Hook into Agent Spawns
- `agents/base.py` → `spawn_agent()`: after DB update, call `append_log(config.pipeline_root, "agent_spawned", task.id, stage=stage, model=model, pid=process.pid)`

### 4. Hook into SLA Timeouts
- `core/scheduler.py` → `_check_sla_timers()`: on timeout (both requeue and fail), call `append_log`

### 5. Hook into MCP Signals
- `api/mcp.py` → `orchestrator_signal_back()`: call `append_log(..., "signal_back", task_id, from_stage=task.stage, to_stage=target_stage, reason=reason)`
- `api/mcp.py` → `orchestrator_signal_cancel()`: call `append_log(..., "signal_cancel", task_id, stage=task.stage, reason=reason)`

### 6. Hook into REST Cancel
- `api/rest.py` → `cancel_task()`: call `append_log(..., "cancel", task_id, stage=task.stage, reason=body.reason)`

## Do NOT Modify
- `core/db.py` — DB events are separate from disk log
- `core/config.py` — no config changes needed (log path derived from pipeline_root)

## Tests
- Add `tests/test_pipeline_log.py` — test that `append_log` writes valid JSON lines
- Test that the log file is created if it doesn't exist
- Test that multiple appends produce multiple lines
- Run full suite: `cd orchestrator && uv run pytest -v`
- All 93 existing tests must still pass

## Important
- The log must be append-only — never truncate or overwrite
- Each line must be valid JSON (parseable by `json.loads`)
- Use `"a"` mode for file open, not `"w"`
- Thread safety is not required (single event loop)
- Keep the function simple — ~15 lines max

## Execution
Do NOT ask questions. Execute the full task end-to-end.
