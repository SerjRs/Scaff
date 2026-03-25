# Instructions for Claude Code Executor

## Task Context
You are building the infinite loop and crash recovery logic for the V2 Pipeline Orchestrator. The reconciler ensures the system can survive abrupt restarts, while the scheduler enforces the pipeline's operational rules (concurrency, dependencies, SLAs).

## Git Workflow
1. Branch name: `feat/054-v2-core-loop-and-reconciler`
2. Check out this branch based on `main` (ensure it includes changes from task 053).
3. Commit frequently. Format: `[054] <description>`.

## Technical Constraints
- Language: Python 3.12+
- Use standard `asyncio` for the loop and sleep mechanisms.
- Use `pyyaml` (add via `uv add pyyaml`) to parse `DEPS.MD` during the dependency check phase.
- Use the DB interface from `core/db.py` and the filesystem config from `core/config.py`.
- **Stub out agent spawning:** Implement `agents/base.py` with an `async def spawn_agent(...)` that *only* marks the task as `WIP` in the database and logs it. We will implement the actual subprocess `subprocess.exec` in the next task.

## Execution Steps
0. MANDATORY FIRST STEP: Read CODEBASE.md in the repo root to understand the existing API surface, available dataclasses, and functions you must use.
1. Read `STATE.md` to check current progress.
2. Add `pyyaml` dependency. Update `core/config.py` with concurrency/SLA defaults.
3. Implement `core/reconciler.py` per the specs.
4. Implement `core/priority.py` to generate the markdown tables for `PRIORITY.MD`.
5. Implement `core/scheduler.py` with the 10-second tick loop.
6. Write unit tests in `tests/test_reconciler.py` and `tests/test_scheduler.py`.
7. Run tests via `uv run pytest`. Fix any issues.
8. Update `STATE.md`.
9. Push the branch when all tests pass.