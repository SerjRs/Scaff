# Instructions for Claude Code Executor

## Task Context
You are building the filesystem interaction layer for an autonomous pipeline. This includes transactional folder moves and generating strict context manifests for LLM agents.

## Git Workflow
1. Branch name: `feat/052-v2-filesystem-and-manifest`
2. Check out this branch. Create it from `main` (or whatever branch contains the merged changes from task 051).
3. Commit frequently. Format: `[052] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Use `uv add pathspec` to handle `.pipelineignore` parsing accurately.
- Use `shutil` for file operations and `pathlib.Path` for all path handling.
- Use the database methods implemented in `core/db.py` (from task 051) for the move transaction.

## Execution Steps
1. Read `STATE.md` to check current progress.
2. Ensure you have the latest code from `core/db.py`.
3. Create `core/config.py` with the configuration dataclass.
4. Implement `core/filesystem.py` per the `SPEC.md`. 
5. Write comprehensive tests in `tests/test_filesystem.py` utilizing pytest's `tmp_path` fixture.
6. Run tests via `uv run pytest tests/test_filesystem.py`. Fix any issues.
7. Update `STATE.md`.
8. Push the branch when all tests pass.