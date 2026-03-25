# Claude Code Instructions — 061b

Read `CODEBASE.md` in this folder first — it's the authoritative API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/061b-update-prompts-cleanup` from main.
2. Commit frequently with format: `[061b] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Update all 5 prompt files in `orchestrator/prompts/` to reference `$PIPELINE_REPO_PATH`
- Agents now run with cwd set to the repo — prompts should tell agents they're already in the repo
- Delete `orchestrator/agents/execution_wrapper.py` (codex bridge, no longer needed)
- Clean up any execution_wrapper imports from `__init__.py`
- Remove any codex-specific tests

## Do NOT Modify
- db.py, filesystem.py, reconciler.py, scheduler.py, priority.py, mcp.py, config.py, base.py

## Tests
Run: `cd orchestrator && uv run pytest -v` — ALL tests must pass.

## Execution
Do NOT ask questions. Execute the full task end-to-end.
