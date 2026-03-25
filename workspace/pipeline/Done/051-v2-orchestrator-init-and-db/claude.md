# Instructions for Claude Code Executor

## Task Context
You are initializing the core data layer for an autonomous pipeline orchestrator. This requires strict adherence to the provided `SPEC.md` and high-quality, typed Python code.

## Git Workflow
1. Branch name: `feat/051-v2-orchestrator-init-and-db`
2. Check out this branch before making any changes. If it doesn't exist, create it.
3. Commit frequently with descriptive messages. Format: `[051] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Package Manager: `uv` (use `uv init` and `uv add`)
- Database Driver: `aiosqlite`
- Use fully typed function signatures (`->` and `:` annotations).
- Use `structlog` for any logging within the DB layer.

## Execution Steps
1. Read `STATE.md` to check current progress.
2. Initialize the `uv` project inside an `orchestrator/` directory.
3. Implement `orchestrator/core/db.py` according to the schema in `SPEC.md`.
4. Write tests in `orchestrator/tests/test_db.py` using an in-memory SQLite database.
5. Run tests using `uv run pytest`. Fix any failures.
6. Update `STATE.md` as you complete milestones.
7. Push the branch when all tests pass and milestones are checked.