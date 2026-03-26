# Task 067c: Git Branch Discipline

## STATUS: COOKING

## Priority: P1
## Complexity: M

## Objective

Ensure agents work on proper feature branches during EXECUTION and merge to main after TESTING passes. Currently agents work on whatever branch is current (usually main), which means untested code lands directly on main.

## Background

Architecture spec v2.2 §9.5 says:
- Execution agent creates `feature/<task-id>` before any changes
- All commits scoped to that branch
- Testing agent merges `feature/<task-id>` to main on PASS

Currently: no branch is created, agents commit to main, no merge step exists.

## Scope

### In Scope
1. Before spawning an EXECUTION agent: create `feature/<task-id>` branch from main (if it doesn't exist) and check it out
2. Add `PIPELINE_BRANCH` env var to the agent's environment
3. Execution prompt already says "Verify you are on branch `feature/<task-id>`" — just needs the branch to actually exist
4. After TESTING → DONE transition (in `signal_done` handler): merge `feature/<task-id>` to main and push
5. On `signal_back` from REVIEW/TESTING to EXECUTION: keep the feature branch (don't delete it)
6. On cancel: optionally delete the feature branch

### Out of Scope
- PR-based workflow (direct merge is fine for autonomous pipeline)
- Conflict resolution (fail and notify if merge conflicts)

## Files to Modify

- `agents/base.py` — create/checkout feature branch before EXECUTION spawn
- `api/mcp.py` — in `signal_done` handler, merge branch when advancing to DONE
- `core/config.py` — add `git.feature_branch_prefix` config (default: `feature/`)

## Testing Requirements

1. Feature branch created before EXECUTION spawn
2. Branch name follows `feature/<task-id>` pattern
3. Merge to main happens on TESTING → DONE
4. Merge failure (conflict) sets task to FAILED with notification

## Acceptance Criteria

- [ ] EXECUTION agents run on `feature/<task-id>` branch
- [ ] Branch created automatically before spawn if it doesn't exist
- [ ] Testing → DONE triggers merge to main
- [ ] Merge conflicts cause FAILED status (not silent corruption)
- [ ] Existing tests pass

## Dependencies

- 067a (MCP return channel) — agents need signal_done to trigger the merge
