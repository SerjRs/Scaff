# CLAUDE.md — Executor Instructions for Task 005

## Context

You are implementing the Coding Executor feature for the OpenClaw Router. Read `SPEC.md` in this directory for the full specification. Check `STATE.md` for your current checkpoint.

## Repo & Branch

- **Repo root:** `C:\Users\Temp User\.openclaw` (also accessible as `/c/Users/Temp User/.openclaw` in Git Bash)
- **Branch:** `feat/coding-executor` (create from `main`)
- **Only modify files in:** `src/router/`, `src/agents/subagent-spawn.ts`, `src/agents/tools/sessions-spawn-tool.ts`

## Implementation Order

Follow this exact order. Commit after each step. Update STATE.md after each commit.

### Step 1: types.ts — Add `coding_run` job type
- Add `"coding_run"` to the `JobType` union type
- Commit: `feat(router): add coding_run job type`

### Step 2: Templates — Create coding_run templates
Create three new template files:

**`src/router/templates/opus/coding_run.md`:**
```
You are a coding executor with shell access. Implement the task below using Claude Code CLI.

## Process
1. Read any spec files or context mentioned in the task (use the read tool)
2. Determine the correct working directory (usually the repo root at C:\Users\Temp User\.openclaw)
3. Spawn Claude Code in print mode:
   exec(command="claude -p '<your prompt here>'", pty=true, workdir="C:\\Users\\Temp User\\.openclaw", timeout=600)
   Include ALL relevant context in the prompt — file paths, requirements, constraints.
4. Monitor the process:
   - process(action="poll", sessionId="<id>", timeout=120000) to wait for progress
   - process(action="log", sessionId="<id>") to check output
5. If Claude Code fails or errors out:
   - Read the error from the logs
   - Diagnose the issue
   - Retry with a corrected prompt (max 3 attempts total)
6. When Claude Code completes:
   - Check the output for success indicators
   - Run tests if the task mentions them: exec(command="npx vitest run <path>")
   - Review changes: exec(command="git diff --stat")
7. Report results clearly:
   - What was implemented
   - Files changed
   - Test results (pass/fail counts)
   - Any issues encountered

## Important
- Always use pty=true for Claude Code (it requires a terminal)
- Set timeout=600 on the exec call (10 min max per attempt)
- Use process(action="poll", timeout=120000) — do NOT busy-loop with short polls
- If all 3 attempts fail, report the failure with error details — do not hang

## Task
{task}
```

**`src/router/templates/sonnet/coding_run.md`:**
```
You are a coding executor. Implement the task below using Claude Code CLI.

## Process
1. Read any referenced spec files (use the read tool)
2. Spawn Claude Code: exec(command="claude -p '<prompt>'", pty=true, workdir="C:\\Users\\Temp User\\.openclaw", timeout=600)
3. Monitor: process(action="poll", sessionId="<id>", timeout=120000)
4. On failure: retry once with corrected prompt
5. Report: what changed, test results, any issues

## Task
{task}
```

**`src/router/templates/haiku/coding_run.md`:**
```
You are a task executor. Complete the coding task below directly using available tools (read, write, edit, exec).

For simple changes, edit files directly. For complex tasks, use exec to run Claude Code:
exec(command="claude -p '<prompt>'", pty=true, workdir="C:\\Users\\Temp User\\.openclaw", timeout=300)

{task}
```

- Commit: `feat(router): add coding_run templates for all tiers`

### Step 3: gateway-integration.ts — Accept jobType parameter

In `routerCallGateway`:
1. Add 3rd parameter: `jobType: JobType = "agent_run"`
2. Import `JobType` from `./types.js`
3. After evaluation, if `jobType === "coding_run"`, floor weight to 7: `evalResult.weight = Math.max(evalResult.weight, 7)`
4. Use `jobType` in `getTemplate(tier, jobType)` call (currently hardcoded as `"agent_run"`)
5. Pass `jobType` to `logRouterDecision` (add to decision object, store as part of the archived JSON)

**IMPORTANT:** The `logRouterDecision` call near line ~260 hardcodes `instance.enqueue("agent_run", ...)`. Update it to use `jobType` parameter.

- Commit: `feat(router): routerCallGateway accepts jobType with coding_run weight floor`

### Step 4: subagent-spawn.ts — Accept executor parameter

1. Add `executor?: "auto" | "coding"` to `SpawnSubagentParams` type
2. In `spawnSubagentDirect()`, after the Router active check (~line 296):
   ```typescript
   const jobType: JobType = params.executor === "coding" ? "coding_run" : "agent_run";
   ```
3. Pass `jobType` as 3rd argument to `routerCallGateway()` call (~line 443):
   ```typescript
   await routerCallGateway<{ runId: string }>(agentCallOpts, spawnMode === "run" ? "sync" : "async", jobType)
   ```
4. Import `JobType` from `../router/types.js`

- Commit: `feat(agents): pass executor type through spawn to router`

### Step 5: sessions-spawn-tool.ts — Add executor to tool schema

1. Add to `SessionsSpawnToolSchema`:
   ```typescript
   executor: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("coding")])),
   ```
2. In `execute()`, read and pass through:
   ```typescript
   const executor = params.executor === "coding" ? "coding" : undefined;
   ```
   Pass as `executor` in the `spawnSubagentDirect` params object.

- Commit: `feat(agents): add executor param to sessions_spawn tool schema`

### Step 6: Tests

**Create `src/router/__tests__/coding-executor.test.ts`:**
- Test template existence for all 3 tiers × coding_run
- Test template rendering (task variable substitution)
- Test opus template contains "claude" and "exec" keywords
- Test `routerCallGateway` with `jobType="coding_run"` floors weight to 7
- Test `routerCallGateway` with default jobType is backward compatible

**Update `src/router/templates/templates.test.ts`:**
- Add tests for `getTemplate("opus", "coding_run")` etc.

**Update `src/router/gateway-integration.test.ts`:**
- If there are existing tests that call `routerCallGateway`, ensure they still pass with default 3rd param

Follow existing test patterns:
- Use `vi.mock` for modules
- Use `vi.useFakeTimers()` where needed
- See `src/router/__tests__/weight-timeout.test.ts` for mock patterns

- Commit: `test(router): add coding executor tests`

### Step 7: Final verification

```bash
npx vitest run src/router/
npx vitest run src/agents/openclaw-tools.subagents.sessions-spawn*.test.ts
```

ALL tests must pass. If any fail, fix them before proceeding.

### Step 8: Push, PR, and update STATE.md

```bash
git push -u origin feat/coding-executor
```

Update STATE.md to COMPLETE.

## Rules

- **Incremental commits** after each step
- **Update STATE.md** after each commit with current checkpoint
- **Do NOT modify** files outside the listed paths
- **Backward compatibility** — all existing tests must pass
- **Template content** — copy the EXACT template text from Step 2 above
- The `gh` CLI is at `C:\Program Files\GitHub CLI\gh.exe` (use full path if `gh` not in your PATH)
