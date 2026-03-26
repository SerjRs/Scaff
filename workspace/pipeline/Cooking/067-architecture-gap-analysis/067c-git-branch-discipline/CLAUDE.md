# Claude Code Instructions — 067c

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067c-git-branch-discipline` from main.
2. Commit frequently with format: `[067c] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Feature Branch Creation (`agents/base.py`)
- Before spawning an EXECUTION agent, create and checkout `feature/<task-id>` branch
- Use `asyncio.create_subprocess_exec("git", "checkout", "-b", f"feature/{task.id}")` in the repo directory
- If the branch already exists (signal_back re-entry), just checkout: `git checkout feature/<task-id>`
- Add `PIPELINE_BRANCH` to the agent's env vars
- This only applies to EXECUTION stage — other stages work on main

### 2. Merge on TESTING → DONE (`api/mcp.py`)
- In `orchestrator_signal_done`, when the current stage is TESTING (next stage is DONE):
  - Run `git checkout main && git merge feature/<task-id> --no-edit` in the repo dir
  - If merge fails (non-zero exit), set task to FAILED with details, do NOT advance to DONE
  - If merge succeeds, push and then proceed with the normal stage transition
- The repo path is `config.pipeline_root.parent`
- Use `asyncio.create_subprocess_exec` for git commands (same as agent spawn pattern)

### 3. Config (optional)
- Add `feature_branch_prefix` to PipelineConfig (default: `"feature/"`)
- Only add if it simplifies the code. Hardcoding `feature/` is also acceptable for S complexity.

### 4. Branch Cleanup on Cancel
- When a task is cancelled, optionally delete the feature branch
- Use `git branch -D feature/<task-id>` — best-effort, don't fail if branch doesn't exist

### 5. Keep Branch on signal_back
- When REVIEW or TESTING sends task back to EXECUTION, do NOT delete the branch
- The execution agent resumes work on the existing `feature/<task-id>` branch

## Do NOT Modify
- `core/db.py` — no schema changes
- `core/scheduler.py` — branch logic is in spawn (base.py) and signal (mcp.py)
- `core/monitor.py` — unrelated

## Tests
- Add tests in `tests/test_agents.py` for branch creation before EXECUTION spawn
- Add tests in `tests/test_mcp.py` for merge-on-done behavior
- Mock git subprocess calls — do NOT run real git in tests
- Run full suite: `cd orchestrator && uv run pytest -v`
- All 93 existing tests must still pass

## Important
- Git commands must be async (subprocess_exec, not subprocess.run)
- Handle the case where `feature/<task-id>` already exists (re-entry after bounce)
- Merge conflicts must surface as FAILED status, not silent corruption
- The repo dir (`config.pipeline_root.parent`) must exist — log warning if not

## Execution
Do NOT ask questions. Execute the full task end-to-end.
