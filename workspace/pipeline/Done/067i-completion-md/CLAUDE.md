# Claude Code Instructions — 067i

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067i-completion-md` from main.
2. Commit frequently with format: `[067i] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Update Testing Prompt (`prompts/testing.md`)
- Add a clear COMPLETION.md template section with required format:
  - `# Completion: <task-id>`
  - `## Summary` — one paragraph
  - `## Changes` — list of files created/modified
  - `## Tests` — unit/E2E pass counts
  - `## Merged` — branch + commit hash
- Place it in the "On PASS" section, before the `signal_done` call
- Make it explicit: "You MUST write COMPLETION.md before calling signal_done"

### 2. Optional Warning in `signal_done` (`api/mcp.py`)
- In `orchestrator_signal_done`, when `task.stage == "TESTING"` (transitioning to DONE):
  - Check if `Path(task.task_path) / "COMPLETION.md"` exists
  - If missing: `log.warning("completion_md_missing", task_id=task_id)`
  - Do NOT block the transition — just warn
- Same check in `api/rest.py` signal_done endpoint

### 3. Keep It Simple
- This is primarily a prompt update + optional validation log
- No new modules, no config changes, no schema changes

## Do NOT Modify
- `core/db.py` — no changes
- `core/config.py` — no changes
- `core/scheduler.py` — no changes
- `agents/base.py` — no changes
- Other prompt files (architect.md, spec.md, execution.md, review.md) — no changes

## Tests
- No new test file needed
- Optionally: add a test in `tests/test_mcp.py` that verifies the warning is logged when COMPLETION.md is missing on TESTING→DONE
- Run full suite: `cd orchestrator && uv run pytest -v`

## Important
- The testing prompt already mentions COMPLETION.md — strengthen the instruction, don't duplicate
- The warning is non-blocking — testing agent forgets to write it? Log it, move on
- `task.task_path` points to the task folder — COMPLETION.md goes at `{task_path}/COMPLETION.md`

## Execution
Do NOT ask questions. Execute the full task end-to-end.
