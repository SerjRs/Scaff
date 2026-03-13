# 005 — Coding Executor (Claude Code integration via Router)

## Problem

The Router only has one job type (`agent_run`) and one executor template pattern. There's no way to tell the executor LLM "use Claude Code CLI to implement this." Today only MAIN (Scaff) can orchestrate Claude Code because he manually spawns it via `exec(pty:true)` + `process(poll/log)`.

The `router-executor` agent session already HAS `exec` + `process` tools. We just need:
1. A new job type that selects the right template
2. Templates that instruct the executor LLM how to drive Claude Code
3. A way for callers (Cortex, MAIN) to request a coding executor

## Architecture

```
Caller (Cortex/MAIN) → sessions_spawn(task, executor="coding")
  → subagent-spawn.ts (maps executor → jobType: "coding_run")
    → routerCallGateway(opts, mode, jobType="coding_run")
      → evaluator picks weight (floored to 7+ for coding)
      → dispatcher renders coding_run template (not agent_run)
      → callGateway({ method: "agent" }) in router-executor session
        → Opus reads template → spawns `claude -p "task"` via exec(pty:true)
        → monitors via process(poll/log)
        → reviews output, reports back
```

**Key: the Router stays a dumb dispatcher.** The intelligence is in the template — it tells Opus how to be a coding executor.

## Changes

### 1. `src/router/types.ts`

Add `"coding_run"` to the `JobType` union:

```typescript
export type JobType = "agent_run" | "coding_run";
```

### 2. Templates (NEW files)

**`src/router/templates/opus/coding_run.md`** — Full coding executor instructions for Opus. This is the core of the feature. Template tells the executor to:
- Read any spec/task files referenced in `{task}`
- Spawn Claude Code via `exec(command="claude -p '<prompt>'", pty=true, workdir="<repo>")`
- Monitor via `process(action="poll", sessionId="<id>", timeout=120000)`
- On failure: read logs, diagnose, retry (max 3 attempts)
- On success: review output (`git diff --stat`), run tests if mentioned
- Report structured results (files changed, tests passed/failed, branch/PR if created)

**`src/router/templates/sonnet/coding_run.md`** — Same instructions but Sonnet-appropriate (lighter tasks, simpler retry logic).

**`src/router/templates/haiku/coding_run.md`** — Minimal template. Haiku shouldn't get heavy coding tasks but needs to exist for completeness. Tells haiku to attempt the task directly without Claude Code (simple edits only).

Template variables: `{task}`, `{context}`, `{constraints}` (same as agent_run).

### 3. `src/router/gateway-integration.ts`

Update `routerCallGateway` signature to accept job type:

```typescript
export async function routerCallGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
  _routerMode: "sync" | "async" = "sync",
  jobType: JobType = "agent_run",   // ← NEW parameter
): Promise<T> {
```

Inside the function:
- Use `jobType` when calling `getTemplate(tier, jobType)` instead of hardcoded `"agent_run"`
- For `coding_run`: floor the evaluator weight to minimum 7 (ensures opus tier + 15min timeout)
- Pass `jobType` to `logRouterDecision` for observability

### 4. `src/agents/subagent-spawn.ts`

Add `executor` to `SpawnSubagentParams`:

```typescript
export type SpawnSubagentParams = {
  // ... existing fields ...
  /** Executor type: "auto" (default) or "coding" (uses Claude Code) */
  executor?: "auto" | "coding";
};
```

In `spawnSubagentDirect()`:
- Map `executor: "coding"` → `jobType = "coding_run"`
- Pass `jobType` to `routerCallGateway()` as 3rd argument
- Default (`"auto"` or undefined) → `"agent_run"` (no change)

### 5. `src/agents/tools/sessions-spawn-tool.ts`

Add `executor` to the tool schema:

```typescript
const SessionsSpawnToolSchema = Type.Object({
  // ... existing fields ...
  executor: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("coding")])),
});
```

In `execute()`:
- Read `params.executor`, pass through to `spawnSubagentDirect`

### 6. Tests

**`src/router/__tests__/coding-executor.test.ts`** (NEW):
- Template existence: `getTemplate("opus", "coding_run")` doesn't throw
- Template existence: `getTemplate("sonnet", "coding_run")` doesn't throw  
- Template existence: `getTemplate("haiku", "coding_run")` doesn't throw
- Template rendering: opus coding_run contains `{task}` placeholder that renders correctly
- Template content: opus coding_run mentions `claude` CLI and `exec`/`process`

**Update `src/router/gateway-integration.test.ts`**:
- `routerCallGateway` with `jobType="coding_run"` floors weight to 7
- `routerCallGateway` with default jobType uses `agent_run` template (backward compat)

**Update `src/router/templates/templates.test.ts`**:
- Add coding_run template loading tests alongside existing agent_run tests

## Weight Floor Logic

For `coding_run` in `routerCallGateway`:
```typescript
if (jobType === "coding_run") {
  evalResult.weight = Math.max(evalResult.weight, 7);
}
```
This ensures: weight ≥ 7 → opus tier → 15min timeout from Task 006's `weightToTimeoutMs()`.

## Backward Compatibility

- `JobType` union is additive — existing `"agent_run"` jobs unchanged
- `routerCallGateway` 3rd param defaults to `"agent_run"` — zero changes for existing callers
- `executor` param on sessions_spawn is optional, defaults to `"auto"` → `"agent_run"`
- All existing tests must pass without modification

## Out of Scope

- Auto-detection of coding tasks by evaluator (future enhancement)
- Security sandboxing for executor shell access (deferred)
- Process isolation (fork-per-job) — separate concern
- PR auto-merge by executor (template can instruct it, but not enforced)
