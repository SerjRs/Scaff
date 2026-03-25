# Instructions for Claude Code Executor

## Task Context
You are building the human-facing control plane for the autonomous pipeline. This consists of a FastAPI backend and a Typer CLI frontend.

## Git Workflow
1. Branch name: `feat/056-v2-rest-api-and-cli`
2. Check out this branch based on `main` (ensure it includes all prior v2 tasks).
3. Commit frequently. Format: `[056] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Use `fastapi` and `uvicorn` for the API.
- Use `typer` and `rich` for the CLI.
- Ensure the API properly handles async database calls using the existing `core/db.py` interface.
- In `main.py` (`pipeline serve`), you must orchestrate the async startup of the API server, the MCP server, and the core Orchestrator loop simultaneously.

## Execution Steps
0. MANDATORY FIRST STEP: Read CODEBASE.md in the repo root to understand the existing API surface, available dataclasses, and functions you must use.
1. Read `STATE.md` to check current progress.
2. Add dependencies: `uv add fastapi uvicorn typer rich httpx`.
3. Implement `api/rest.py` per the specs.
4. Implement `main.py` (the Typer CLI app).
5. Write unit tests in `tests/test_api.py` and `tests/test_cli.py`.
6. Run tests via `uv run pytest`. Fix any issues.
7. Update `STATE.md`.
8. Push the branch when all tests pass.