# Instructions for Claude Code Executor

## Task Context
You are building the MCP server that acts as the sole communication interface between the Orchestrator and the AI agents working in the pipeline. 

## Git Workflow
1. Branch name: `feat/053-v2-mcp-server`
2. Check out this branch. Ensure it is based on the merged code from task 052.
3. Commit frequently. Format: `[053] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Use the official Anthropic `mcp` Python SDK (`uv add mcp`).
- Ensure tool inputs are heavily typed (using `pydantic` or standard typing) so the SDK generates accurate descriptions for the agents.
- **Integration:** You must import and use `move_task` and `build_context_manifest` from `core/filesystem.py`, and the CRUD methods from `core/db.py`.

## Execution Steps
0. MANDATORY FIRST STEP: Read CODEBASE.md in the repo root to understand the existing API surface, available dataclasses, and functions you must use.
1. Read `STATE.md` to check current progress.
2. Add the `mcp` dependency.
3. Update `core/config.py` with the `PIPELINE_STAGES` list.
4. Implement `api/mcp.py` with the 6 required `@tool` endpoints.
5. Write unit tests in `tests/test_mcp.py` using `unittest.mock` to mock the DB/FS layers.
6. Run tests via `uv run pytest tests/test_mcp.py`. Fix any routing or type-hinting issues.
7. Update `STATE.md`.
8. Push the branch when tests pass.