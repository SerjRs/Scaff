# Claude Code Instructions — 061

Read `CODEBASE.md` in this folder first — it's the authoritative API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/061-fix-spawn-mechanics` from main.
2. Commit frequently with format: `[061] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Prompt delivery: write prompt to temp file, pipe via stdin to Claude Code (not CLI arg — hits OS 32K limit)
- Set `cwd=` on subprocess to `<project>/repo/` (derived from `config.pipeline_root.parent / "repo"`)
- Add `PIPELINE_REPO_PATH` env var to all agent subprocesses
- Update prompt context header to include repo path
- Update all 5 prompt files to reference `$PIPELINE_REPO_PATH`
- Delete or deprecate `execution_wrapper.py` (codex bridge — not needed for claude-only)
- Update existing agent tests + create new tests for spawn mechanics

## Do NOT Modify
- db.py, filesystem.py, reconciler.py, scheduler.py, priority.py, mcp.py, config.py (already changed in 060)

## Tests
Run: `cd orchestrator && uv run pytest -v` — ALL tests must pass.

## Execution
Do NOT ask questions. Execute the full task end-to-end.
