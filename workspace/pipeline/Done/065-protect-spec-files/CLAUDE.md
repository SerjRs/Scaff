# Claude Code Instructions — 065

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/065-protect-spec-files` from main.
2. Commit frequently with format: `[065] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Set SPEC.md read-only (chmod) before spawning agent in `agents/base.py`
- Restore write permission in `core/filesystem.py` `move_task()` before moving folders
- Add "do not modify SPEC.md" instruction to all 5 prompt files in `orchestrator/prompts/`
- Use `import stat` and `Path.chmod()` for file permissions
- On Windows: `stat.S_IREAD` for read-only, `stat.S_IREAD | stat.S_IWRITE` to restore

## Do NOT Modify
- `core/db.py` — no schema changes
- `core/config.py` — no config changes

## Tests
- Add tests to `tests/test_agents.py` — verify SPEC.md is set read-only before spawn
- Add tests to `tests/test_filesystem.py` — verify write permission restored on move
- Run full suite: `cd orchestrator && uv run pytest -v`

## Execution
Do NOT ask questions. Execute the full task end-to-end.
