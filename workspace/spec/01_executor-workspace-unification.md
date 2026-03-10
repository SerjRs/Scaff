# Executor Workspace Unification

**Created:** 2026-03-09
**Status:** Not Started
**Author:** Scaff (Cortex)

---

## Problem

Router executor tasks run in an isolated sandbox at `~/.openclaw/workspace-router-executor/`. This means:
- Executor's `read` tool cannot access main workspace files (docs, specs, memory)
- Files written by executors land in the sandbox, not the main workspace
- Executor must use shell commands with full paths as a workaround, but results get lost in delivery
- Every spec file today ended up in the wrong location

## Solution

Point the executor workspace to the same root as Main Agent: `~/.openclaw/`

### Steps:
1. Find where the executor workspace path is configured. Search for "workspace-router-executor" in:
   - `openclaw.json` (likely `router.executor.workspace` or similar)
   - `src/router/worker.ts` (where executor sessions are created)
   - `src/agents/subagent-spawn.ts` (where subagent workspaces are set)
2. Change the executor workspace root from `workspace-router-executor/` to the main workspace root
3. Verify the executor's `read` tool can now access `workspace/docs/`, `workspace/memory/`, `workspace/spec/`
4. Verify the executor's `write` tool writes to the main workspace
5. Build and test

### Rationale:
- Executors run inside the gateway process, same machine, same user account
- No security boundary exists — sandbox adds friction with zero benefit
- Main Agent already has full filesystem access
- Executors already have shell access to the full HDD via `exec` tool

### Risk:
- Low. Executors already have unrestricted shell access. The `read`/`write` sandbox is inconsistent with `exec` permissions.

### Test:
1. Spawn a task that reads `workspace/docs/cortex-architecture.md` via the `read` tool
2. Verify it returns the file contents
3. Spawn a task that writes to `workspace/spec/test.md`
4. Verify the file appears in the main workspace, not in a sandbox

## Files to investigate:
- openclaw.json — router/executor config
- src/router/worker.ts — executor session creation
- src/agents/subagent-spawn.ts — workspace path resolution
