# Task 061b: Update Prompt Files + Delete Execution Wrapper

## STATUS: AGREED

## Priority: P1
## Complexity: S

## Objective

Update all 5 agent prompt files to reference `$PIPELINE_REPO_PATH` for git/code operations, and delete the unused `execution_wrapper.py` (codex bridge no longer needed with claude-only agents).

## Scope

### In Scope
- Update 5 prompt files in `orchestrator/prompts/`
- Delete `orchestrator/agents/execution_wrapper.py`
- Clean up any imports of execution_wrapper from `orchestrator/agents/__init__.py`
- Remove codex-specific tests from test_agents.py if any remain

### Out of Scope
- Changes to base.py (already done in 061)
- Changes to config.py (already done in 060)

## Files to Modify

- `orchestrator/prompts/architect.md` — Add in startup sequence: "The project repository is at the path provided in `Repo Path` above (also available as `$PIPELINE_REPO_PATH`)."
- `orchestrator/prompts/spec.md` — Same addition as architect.
- `orchestrator/prompts/execution.md` — Update git section: "Your working directory is the project repository at `$PIPELINE_REPO_PATH`. You are already running inside it. Run git commands directly without `cd`."
- `orchestrator/prompts/review.md` — Update git diff section: "Your working directory is the project repository. Run `git diff main..feature/<task-id>` directly."
- `orchestrator/prompts/testing.md` — Update merge section: "Your working directory is the project repository. Run git merge commands directly."

## Files to Delete

- `orchestrator/agents/execution_wrapper.py`

## Files to Clean Up

- `orchestrator/agents/__init__.py` — remove any import of execution_wrapper if present
- `orchestrator/tests/test_agents.py` — remove any codex/execution_wrapper specific tests if remaining

## Acceptance Criteria

- [ ] All 5 prompt files reference `$PIPELINE_REPO_PATH`
- [ ] execution_wrapper.py is deleted
- [ ] No imports of execution_wrapper remain
- [ ] All existing tests pass

## Dependencies

- 061 (fix spawn mechanics) — must be merged first
