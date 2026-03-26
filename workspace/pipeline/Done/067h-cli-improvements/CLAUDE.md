# Claude Code Instructions — 067h

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067h-cli-improvements` from main.
2. Commit frequently with format: `[067h] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Rewrite `status` Command
- Show a Rich table with columns: Task ID, Stage, Status, Priority, Model, Bounces, Time in Stage
- Calculate "Time in Stage" from `entered_stage_at` (ISO 8601) → human-readable duration (e.g., "2h 15m", "3d")
- Use Rich status colors (already partially implemented)
- Add stage summary line below the table: `TODO: 0 | ARCH: 1 | SPEC: 0 | EXEC: 2 | REV: 0 | TEST: 1 | DONE: 5`

### 2. Empty State
- When no tasks exist, print `"No tasks in pipeline"` and the stage summary (all zeros)
- Don't print an empty table with just headers

### 3. Stage Filter
- Add `--stage` option: `cli.py status --stage EXECUTION`
- Filter tasks by stage before display
- Still show the full stage summary line (unfiltered)

### 4. Keep Existing Commands
- `approve`, `cancel`, `reprioritize`, `retry` — no changes needed
- Just improve `status`

## Do NOT Modify
- `core/` — no code changes
- `api/` — no API changes
- `agents/` — no changes

## Tests
- Add `tests/test_cli.py` tests for the new status output
- Test: status with tasks shows table
- Test: status with no tasks shows empty message
- Test: status with --stage filter
- Mock `httpx.get` — do NOT call the real API
- Run full suite: `cd orchestrator && uv run pytest -v`

## Important
- The CLI calls the REST API (`GET /tasks`) — it doesn't access DB directly
- `entered_stage_at` may be None for some tasks — handle gracefully (show "—")
- Rich is already a dependency — use `rich.table.Table` and `rich.console.Console`
- Typer is already used — add `--stage` as `typer.Option`
- Keep the status_colors dict (already exists in current code)

## Execution
Do NOT ask questions. Execute the full task end-to-end.
