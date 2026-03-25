# Instructions for Claude Code Executor

## Task Context
You are building the subprocess engine that the Orchestrator uses to spawn AI models (like yourself). You will also build a Python wrapper script that sanitizes broken git states before a retry.

## Git Workflow
1. Branch name: `feat/055-v2-agent-spawning`
2. Check out this branch based on `main` (ensure it includes changes from task 054).
3. Commit frequently. Format: `[055] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Use `asyncio.create_subprocess_exec` for non-blocking process execution.
- Ensure the file handler for `AGENT.log` is properly managed so the subprocess can write to it seamlessly.
- In `execution_wrapper.py`, use standard synchronous `subprocess.run` for the git commands, as it runs in its own isolated process space.

## Execution Steps
0. MANDATORY FIRST STEP: Read CODEBASE.md in the repo root to understand the existing API surface, available dataclasses, and functions you must use.
1. Read `STATE.md` to check current progress.
2. Update `core/config.py` to parse agent configurations.
3. Implement `agents/base.py` with `spawn_agent` and `kill_agent`.
4. Implement `agents/execution_wrapper.py` with the git sanitization logic for retries.
5. Write unit tests in `tests/test_agents.py`.
6. Run tests via `uv run pytest`. Fix any issues.
7. Update `STATE.md`.
8. Push the branch when all tests pass.