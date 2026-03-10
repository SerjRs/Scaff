# Process-Isolated Executors — Implementation Plan

*Created: 2026-03-10*
*Status: Not Started*
*Ref: `docs/process-isolated-executors-architecture.md`*
*Approach: Fork-per-job (Phase 1 from architecture doc)*

---

## Why

Executors run in-process with the gateway. A stuck or crashed executor can kill the gateway, WhatsApp, main agent — everything. We move executors to child processes so they can be killed independently. The executor already calls `callGateway()` via WebSocket RPC — it just happens to be calling itself. Fork it out.

---

## Phase 1: Executor Runner Script

**Goal:** Create a standalone Node.js script that can execute a router job as a child process. Receives job params via IPC, connects to gateway via WebSocket, runs the agent, returns result via IPC.

### Tasks

**1.1 — Create `src/router/executor-runner.mjs`**

Standalone entry point that runs in a child process. Does NOT import any gateway code other than `callGateway`.

```typescript
// Receives via IPC: { prompt, model, sessionKey, jobId, gatewayUrl, authToken }
// Connects to gateway WS
// Calls: sessions.patch (set model)
// Calls: agent (run prompt, expectFinal)
// Calls: sessions.delete (cleanup)
// Sends result back via IPC: { ok: true, result } or { ok: false, error }
// Exits with code 0 (success) or 1 (failure)
```

**Key decisions:**
- Script must be self-contained. Import only `callGateway` (or reimplement the WS call inline — it's ~50 lines)
- Gateway URL from env: `GATEWAY_URL` (default `ws://127.0.0.1:18789`)
- Auth token from env: `GATEWAY_TOKEN`
- All job params via IPC message (not env — too large for prompts)
- Timeout: script sets its own `setTimeout` as a safety net. Worker also enforces timeout externally via `child.kill()`

**File:** `src/router/executor-runner.mjs` (ESM, standalone)

### Tests

- `test_runner_receives_ipc_and_returns_result`: Mock gateway WS, send job via IPC, verify result comes back
- `test_runner_exits_on_error`: Send invalid params, verify exit code 1 and error in IPC
- `test_runner_exits_on_timeout`: Set a 1s timeout, mock a slow gateway, verify exit code 1

### Gate
Script can be run standalone with `node src/router/executor-runner.mjs`, receives IPC, calls gateway, returns result. Test with a real gateway running locally.

---

## Phase 2: Worker Refactor — Fork Instead of Call

**Goal:** Replace the in-process `await executor(prompt, model)` call in `worker.ts` with a `child_process.fork()` that spawns `executor-runner.mjs`.

### Tasks

**2.1 — New function: `forkExecutor()` in `src/router/worker.ts`**

```typescript
import { fork } from 'node:child_process';
import path from 'node:path';

interface ForkExecutorParams {
  prompt: string;
  model: string;
  sessionKey: string;
  jobId: string;
  timeoutMs: number;
  killGraceMs: number;
}

interface ForkResult {
  ok: boolean;
  result?: string;
  error?: string;
  pid?: number;
}

async function forkExecutor(params: ForkExecutorParams): Promise<ForkResult> {
  // 1. Resolve path to executor-runner.mjs (relative to dist/)
  // 2. fork() with env: GATEWAY_URL, GATEWAY_TOKEN
  // 3. Send job params via child.send()
  // 4. Listen for IPC 'message' event → resolve
  // 5. Listen for 'exit' event → reject if non-zero
  // 6. Set timeout → child.kill('SIGTERM'), then SIGKILL after graceMs
  // 7. Return { ok, result, pid }
}
```

**2.2 — Refactor `run()` in `worker.ts`**

Current:
```typescript
const result = await executor(prompt, model);
```

After:
```typescript
const isolation = config.executors?.isolation ?? 'inline';

let result: string;
if (isolation === 'process') {
  const sessionKey = `agent:router-executor:task:${crypto.randomUUID()}`;
  const forkResult = await forkExecutor({
    prompt, model, sessionKey, jobId,
    timeoutMs: config.executors?.timeoutMs ?? 300_000,
    killGraceMs: config.executors?.killGraceMs ?? 5_000,
  });
  if (!forkResult.ok) throw new Error(forkResult.error ?? 'executor process failed');
  result = forkResult.result ?? '';
} else {
  // Existing inline path — backward compatible
  result = await executor(prompt, model);
}
```

**2.3 — Pass config to `run()` and `dispatch()`**

Currently `run()` receives `(db, jobId, prompt, model, executor, taskLabel)`. Add a `config` parameter so it knows whether to fork or call inline.

**Files:**
- `src/router/worker.ts` — `forkExecutor()`, refactor `run()`
- `src/router/dispatcher.ts` — pass config through to `run()`
- `src/router/loop.ts` — pass config through to `dispatch()`

### Tests

- `test_fork_executor_returns_result`: Fork real executor-runner, mock gateway, verify result
- `test_fork_executor_timeout_kills_child`: Set 2s timeout, mock slow executor, verify child is killed and job fails
- `test_fork_executor_crash_does_not_crash_gateway`: Executor throws/segfaults, verify gateway process survives
- `test_inline_mode_unchanged`: Set `isolation: 'inline'`, verify old behavior works exactly as before
- `test_config_defaults_to_inline`: No `executors` config → inline mode (backward compat)

### Gate
With `isolation: 'process'`, a router job spawns a child process, the child runs the agent, result comes back, job completes. With `isolation: 'inline'`, existing behavior unchanged. Run both modes against the same test jobs.

---

## Phase 3: Session Key Generation

**Goal:** Move session key creation from `gateway-integration.ts` executor to `worker.ts`, so both inline and process modes use the same session key.

### Tasks

**3.1 — Generate `sessionKey` in `run()` before executor call**

Currently, `createGatewayExecutor()` in `gateway-integration.ts` creates:
```typescript
const sessionKey = `agent:router-executor:task:${crypto.randomUUID()}`;
```

Move this to `run()` in `worker.ts` so it's shared between both code paths. Pass `sessionKey` to both inline executor and fork executor.

**3.2 — Refactor `createGatewayExecutor()` to accept `sessionKey` parameter**

```typescript
// Before: executor creates its own sessionKey internally
export function createGatewayExecutor(): AgentExecutor

// After: executor receives sessionKey from caller
export function createGatewayExecutor(): (prompt: string, model: string, sessionKey: string) => Promise<string>
```

**3.3 — Update `AgentExecutor` type**

```typescript
// Before
export type AgentExecutor = (prompt: string, model: string) => Promise<string>;

// After
export type AgentExecutor = (prompt: string, model: string, sessionKey: string) => Promise<string>;
```

**Files:**
- `src/router/worker.ts` — generate sessionKey, pass to executor
- `src/router/gateway-integration.ts` — accept sessionKey param
- `src/router/types.ts` or `worker.ts` — update AgentExecutor type

### Tests

- `test_session_key_generated_by_worker`: Verify sessionKey format `agent:router-executor:task:<uuid>`
- `test_session_key_passed_to_inline_executor`: Mock executor, verify it receives sessionKey
- `test_session_key_passed_to_fork_executor`: Verify IPC message includes sessionKey
- `test_existing_tests_still_pass`: Run full `worker.test.ts`, `dispatcher.test.ts`, `loop.test.ts`

### Gate
All existing router tests pass. Session key is generated once in `run()` and used by both execution paths.

---

## Phase 4: Token Monitor Bridge

**Goal:** Enable process-isolated executors to report token usage to the gateway's in-memory token monitor.

### Current Problem
Token monitor uses `globalThis` shared state:
- `registerJobSession(jobId, sessionKey)` — Maps job to session
- `getCurrentExecutorTaskLabel()` — reads from globalThis
- `updateStatusByJobId(jobId, status)` — updates in-memory Map

Child processes don't share `globalThis`. Token usage events from the executor won't reach the monitor.

### Tasks

**4.1 — Add `tokenMonitor.record` RPC method to gateway**

New gateway WebSocket method that accepts token usage events from child processes:

```typescript
// Method: 'tokenMonitor.record'
// Params: { jobId, sessionKey, event: 'start' | 'usage' | 'end', data: {...} }
```

**File:** `src/gateway/server-methods/` — new file or add to existing methods

**4.2 — Call `tokenMonitor.record` from executor-runner**

After each LLM API call completes, the executor sends a token usage update via `callGateway({ method: 'tokenMonitor.record', ... })`.

**File:** `src/router/executor-runner.mjs`

**4.3 — Register job→session mapping before fork**

Move `registerJobSession(jobId, sessionKey)` from the executor to the worker (gateway process), before forking. This way the gateway's in-memory map knows about the job immediately.

**File:** `src/router/worker.ts`

**4.4 — Forward task label to token monitor before fork**

Set task label in the gateway's token monitor before forking, not inside the child process:

```typescript
// In worker.ts run(), before forkExecutor():
registerJobSession(jobId, sessionKey);
setCurrentExecutorTaskLabel(taskLabel);
```

**File:** `src/router/worker.ts`

### Tests

- `test_token_monitor_record_rpc`: Call `tokenMonitor.record` via WS, verify ledger updated
- `test_job_registered_before_fork`: Verify `registerJobSession` called before `forkExecutor`
- `test_task_label_set_before_fork`: Verify task label visible in token monitor before executor starts
- `test_inline_mode_token_monitor_unchanged`: Inline executor still works with globalThis path

### Gate
Token monitor shows correct PID, Task, Status, and token counts for process-isolated executors. `openclaw token-monitor` display works for both inline and forked jobs.

---

## Phase 5: Timeout & Kill Enforcement

**Goal:** Reliable timeout enforcement via OS-level process kill. No more "stuck InProgress" rows.

### Tasks

**5.1 — Implement two-stage kill in `forkExecutor()`**

```
1. timeoutMs expires → send SIGTERM to child
2. Wait killGraceMs
3. If child still alive → send SIGKILL
4. Mark job as 'failed' with error 'executor timeout after Xms'
```

**5.2 — Track child PID in token monitor**

Update token monitor to show the real child PID instead of the gateway PID:

```typescript
// After fork:
const childPid = child.pid;
// Update token monitor entry with real PID
```

**File:** `src/router/worker.ts`, `src/token-monitor/ledger.ts`

**5.3 — Add `maxConcurrent` enforcement**

Currently `loop.ts` has `MAX_CONCURRENT = 2` hardcoded. Make it configurable:

```typescript
const maxConcurrent = config.executors?.maxConcurrent ?? 2;
```

When pool is full, jobs wait in queue (existing behavior, just configurable).

**File:** `src/router/loop.ts`

### Tests

- `test_sigterm_sent_on_timeout`: Mock slow executor, verify SIGTERM sent at timeoutMs
- `test_sigkill_sent_after_grace`: Mock executor that ignores SIGTERM, verify SIGKILL at graceMs
- `test_job_marked_failed_on_timeout`: Verify queue DB has `status=failed, error=executor timeout`
- `test_child_pid_in_token_monitor`: Verify token monitor shows child PID, not gateway PID
- `test_max_concurrent_configurable`: Set maxConcurrent=1, enqueue 3 jobs, verify only 1 runs at a time

### Gate
Stuck executors are killed reliably. Token monitor shows real child PIDs. Concurrency is configurable.

---

## Phase 6: Configuration Schema

**Goal:** Add `router.executors` config section to `openclaw.json`.

### Tasks

**6.1 — Add config types**

```typescript
interface ExecutorConfig {
  /** 'inline' (in-process, default) or 'process' (child process) */
  isolation: 'inline' | 'process';
  /** Max simultaneous executor processes */
  maxConcurrent: number;
  /** Per-job timeout before SIGTERM (ms) */
  timeoutMs: number;
  /** Time between SIGTERM and SIGKILL (ms) */
  killGraceMs: number;
  /** Max V8 heap per executor process (MB) */
  maxMemoryMb: number;
}
```

**File:** `src/router/types.ts`

**6.2 — Add defaults and validation**

```typescript
const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  isolation: 'inline',
  maxConcurrent: 2,
  timeoutMs: 300_000,
  killGraceMs: 5_000,
  maxMemoryMb: 512,
};
```

**File:** `src/router/gateway-integration.ts` (where config is loaded)

**6.3 — Pass `--max-old-space-size` to child process**

```typescript
const child = fork(runnerPath, [], {
  execArgv: [`--max-old-space-size=${config.executors.maxMemoryMb}`],
  env: { GATEWAY_URL, GATEWAY_TOKEN },
});
```

**File:** `src/router/worker.ts`

**6.4 — Document in openclaw.json**

```json
{
  "router": {
    "enabled": true,
    "executors": {
      "isolation": "process",
      "maxConcurrent": 4,
      "timeoutMs": 300000,
      "killGraceMs": 5000,
      "maxMemoryMb": 512
    }
  }
}
```

### Tests

- `test_config_defaults`: No `executors` key → defaults applied (inline, 2 concurrent, 5min timeout)
- `test_config_inline_explicit`: `isolation: 'inline'` → in-process executor, no fork
- `test_config_process_explicit`: `isolation: 'process'` → fork-per-job
- `test_memory_limit_applied`: Verify `--max-old-space-size` in child execArgv
- `test_invalid_config_falls_back`: `isolation: 'banana'` → default to inline with warning

### Gate
Config is documented, validated, defaults are safe. Existing setups with no `executors` key work unchanged (inline mode).

---

## Phase 7: Integration Test — End-to-End

**Goal:** Prove the full flow works: job enqueued → child process spawned → agent runs → result delivered → child exits → token monitor updated.

### Tasks

**7.1 — E2E test: happy path**

```
1. Set config: isolation='process'
2. Start gateway with router enabled
3. Enqueue a simple task: "What is 2+2?"
4. Verify: child process spawned (check PIDs)
5. Verify: job status transitions: in_queue → evaluating → pending → in_execution → completed
6. Verify: result delivered to issuer session
7. Verify: child process exited (PID gone)
8. Verify: token monitor shows correct data
9. Verify: session cleaned up (sessions.delete called)
```

**7.2 — E2E test: executor crash**

```
1. Set config: isolation='process'
2. Enqueue a task that will crash the executor (e.g., "process.exit(1)")
3. Verify: gateway still running
4. Verify: job marked as 'failed'
5. Verify: child process exited
6. Verify: main agent session unaffected
7. Verify: next job dispatches normally
```

**7.3 — E2E test: executor timeout**

```
1. Set config: isolation='process', timeoutMs=5000
2. Enqueue a task that takes 30s (e.g., complex multi-tool work)
3. Verify: SIGTERM sent at 5s
4. Verify: SIGKILL sent at 5s + graceMs
5. Verify: job marked 'failed' with timeout error
6. Verify: gateway + main agent unaffected
```

**7.4 — E2E test: concurrent isolation**

```
1. Set config: isolation='process', maxConcurrent=2
2. Enqueue 4 jobs simultaneously
3. Verify: only 2 child processes at any time
4. Verify: jobs 3 and 4 wait in queue until slots free
5. Verify: all 4 complete eventually
```

**7.5 — E2E test: inline fallback**

```
1. Set config: isolation='inline' (or omit executors config)
2. Enqueue a task
3. Verify: no child process spawned
4. Verify: executor runs in-process (existing behavior)
5. Verify: all router tests still pass
```

### Gate
All 5 E2E tests pass. Process isolation works end-to-end. Inline mode is fully backward compatible.

---

## Dependencies

```
Phase 1 (runner script) → Phase 2 (worker fork) → Phase 3 (session key) → Phase 4 (token monitor)
                                                                                    ↓
                                                        Phase 5 (timeout/kill) ← Phase 4
                                                                    ↓
                                                        Phase 6 (config) → Phase 7 (E2E)
```

Phase 1-3 are the critical path. Phase 4-5 are quality/observability. Phase 6-7 are polish/validation.

**Phase 1-3 alone deliver:** working process isolation with fault containment.
**Phase 4-5 add:** operational visibility and reliable cleanup.
**Phase 6-7 add:** production-ready config and confidence.

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `src/router/executor-runner.mjs` | 1 | **New** — standalone child process entry point |
| `src/router/worker.ts` | 2, 3, 4, 5 | `forkExecutor()`, refactor `run()`, session key generation, PID tracking |
| `src/router/gateway-integration.ts` | 3 | Accept sessionKey param, refactor `createGatewayExecutor()` |
| `src/router/dispatcher.ts` | 2 | Pass config to `run()` |
| `src/router/loop.ts` | 2, 5 | Pass config to `dispatch()`, configurable maxConcurrent |
| `src/router/types.ts` | 6 | `ExecutorConfig` interface |
| `src/token-monitor/ledger.ts` | 4, 5 | Handle child PID registration |
| `src/gateway/server-methods/*.ts` | 4 | `tokenMonitor.record` RPC method |

### Test Files

| File | Phase | Tests |
|------|-------|-------|
| `src/router/__tests__/executor-runner.test.ts` | 1 | 3 — IPC, error, timeout |
| `src/router/__tests__/worker-fork.test.ts` | 2 | 5 — fork, timeout, crash, inline, default |
| `src/router/__tests__/session-key.test.ts` | 3 | 4 — generation, passing, format, compat |
| `src/router/__tests__/token-monitor-bridge.test.ts` | 4 | 4 — RPC, registration, label, inline compat |
| `src/router/__tests__/timeout-kill.test.ts` | 5 | 5 — SIGTERM, SIGKILL, fail status, PID, concurrency |
| `src/router/__tests__/executor-config.test.ts` | 6 | 5 — defaults, inline, process, memory, invalid |
| `src/router/__tests__/executor-e2e.test.ts` | 7 | 5 — happy path, crash, timeout, concurrent, fallback |

**Total: 31 tests across 7 phases.**

---

## Rollout

1. **Merge with `isolation: 'inline'` as default** — zero behavior change, all existing tests pass
2. **Test with `isolation: 'process'` on dev** — run E2E tests, verify with token monitor
3. **Enable `isolation: 'process'` in production** — flip config, monitor for 24h
4. **Remove inline code path** (optional, after confidence) — simplify worker.ts
