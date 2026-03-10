# Process-Isolated Executors Architecture

*Version: 1.0 — 2026-03-10*
*Status: Draft*
*Authors: Serj & Scaff*
*Ref: `router-architecture.md`, `src/router/gateway-integration.ts`, `src/router/worker.ts`*

---

## 1. Problem Statement

Router executors currently run **inside the gateway process** on the **same Node.js event loop**. They are not separate threads or processes — they are async functions that share memory, CPU time, and crash fate with the gateway.

This creates three categories of risk:

**Blast radius.** An executor that triggers an unhandled exception, exhausts memory, or enters an infinite loop can take down the entire gateway — killing the main agent session, WhatsApp connection, webchat, cron scheduler, and all other executors simultaneously.

**Resource contention.** A long-running executor (multi-step code generation, browser automation) blocks event loop time. While Node.js handles I/O concurrency well, CPU-intensive tool operations (large file parsing, JSON serialization of big payloads) create head-of-line blocking that degrades the main agent's responsiveness.

**Operational opacity.** All executors share PID with the gateway. The token monitor shows `PID=<gateway-pid>` for persistent agents and can only distinguish executors by task UUID prefix (`T:<8-char>`). There's no OS-level process isolation, no per-executor memory limits, and no way to kill a stuck executor without killing the gateway.

---

## 2. Current Architecture (In-Process)

### 2.1 Execution Flow

```
Gateway Process (single Node.js)
├── Main Agent (Scaff) — persistent session, Opus
├── WhatsApp Web connection (baileys)
├── Webchat WebSocket server
├── Cron scheduler
├── Router
│   ├── Queue (SQLite: router/queue.sqlite)
│   ├── Loop — polls pending jobs every 2s
│   ├── Evaluator — Ollama + Sonnet verification
│   ├── Dispatcher — resolves tier, renders template, fires worker
│   └── Worker — calls executor, manages heartbeat
│       └── Executor — callGateway({ method: "agent" })
│           └── pi-embedded runner (same process)
│               ├── LLM API call (HTTP, async)
│               ├── Tool execution (read/write/exec/browser)
│               └── Session cleanup on completion
├── Token Monitor (in-memory Map)
├── Cortex (shadow/live, SQLite)
└── Hippocampus (gardener, SQLite)
```

### 2.2 Key Integration Points

| Component | Coupling | Notes |
|-----------|----------|-------|
| `callGateway()` | WebSocket to self | Executor calls the gateway's own WS server to run agent sessions |
| Token Monitor | `globalThis` shared state | `registerJobSession()`, `updateStatusByJobId()`, `getCurrentExecutorTaskLabel()` all use in-memory Maps via globalThis |
| Auth profiles | Filesystem + memory cache | Loaded from `agents/main/agent/auth-profiles.json`, cached in gateway memory |
| Session store | Filesystem | `agents/main/sessions/sessions.json` + JSONL transcripts |
| Router queue | SQLite | `router/queue.sqlite` — already process-safe (SQLite handles concurrent access) |
| Result delivery | `callGateway()` | Notifier pushes results to issuer session via gateway WS |
| Cortex feed | `globalThis` hooks | `__openclaw_cortex_feed__`, `__openclaw_cortex_getChannelMode__` |

### 2.3 What the Executor Actually Does

From `gateway-integration.ts`:

```typescript
// 1. Create isolated session key
const sessionKey = `agent:router-executor:task:${crypto.randomUUID()}`;

// 2. Register job→session mapping for token monitor
registerJobSession(jobId, sessionKey);

// 3. Patch session with Router-selected model
await callGateway({ method: "sessions.patch", params: { key: sessionKey, model } });

// 4. Execute agent (blocks until complete)
const response = await callGateway({
  method: "agent",
  params: { message: prompt, sessionKey, deliver: false },
  expectFinal: true,
  timeoutMs: 5 * 60_000,
});

// 5. Clean up session
await callGateway({ method: "sessions.delete", params: { key: sessionKey } });
```

The executor communicates with the gateway entirely through `callGateway()` (WebSocket RPC). This is the critical insight: **the executor already treats the gateway as a service**, even though it runs inside it.

---

## 3. Proposed Architecture (Process-Isolated)

### 3.1 Core Idea

Move executor runs from in-process async functions to **child processes** (or a worker pool) that communicate with the gateway via its existing WebSocket RPC protocol. The executor code doesn't change — `callGateway()` already uses WebSocket, it just needs to connect to `ws://127.0.0.1:18789` from a separate process instead of from within the gateway.

### 3.2 Execution Flow (Proposed)

```
Gateway Process (Node.js)
├── Main Agent, WhatsApp, Webchat, Cron (unchanged)
├── Router
│   ├── Queue, Loop, Evaluator, Dispatcher (unchanged)
│   └── Worker — spawns child process instead of calling executor directly
│       └── Executor Process (separate Node.js)
│           ├── Connects to gateway via ws://127.0.0.1:18789
│           ├── Authenticates with gateway token
│           ├── Runs: callGateway({ method: "agent", ... })
│           ├── Reports result back to worker via IPC/stdout
│           └── Exits on completion (or is killed on timeout)
├── Token Monitor (needs adapter — see §4.2)
└── Everything else (unchanged)
```

### 3.3 Spawning Strategy

**Option A: Fork per job (simple)**
- `child_process.fork()` a lightweight executor script for each job
- Script receives: `{ prompt, model, sessionKey, gatewayUrl, authToken }` via IPC
- Script runs the executor logic, writes result to stdout/IPC, exits
- Worker collects result, updates queue
- Pros: Perfect isolation, simple lifecycle, OS-level kill
- Cons: ~100-200ms fork overhead per job, memory duplication

**Option B: Persistent worker pool (efficient)**
- Pre-fork N worker processes (configurable, default: 2-4)
- Workers idle until assigned a job via IPC
- After job completion, worker returns to pool
- Pros: No fork overhead, bounded concurrency, reusable connections
- Cons: More complex lifecycle management, pool sizing

**Option C: Cluster workers (Node.js native)**
- Use `cluster` module for zero-copy forking
- Workers share the server port (not needed here — executors are clients, not servers)
- Pros: Built-in IPC, automatic restart
- Cons: Designed for server scaling, not task execution; awkward fit

**Recommendation: Option A for Phase 1, Option B for Phase 2.** Fork-per-job is dead simple, and the 100-200ms overhead is negligible compared to the 10-300s executor runtime. Migrate to a worker pool only if fork overhead becomes measurable.

---

## 4. Migration: What Changes

### 4.1 Worker (src/router/worker.ts)

**Before:** `await executor(prompt, model)` — calls in-process function.

**After:** Spawn child process, pass job params via IPC, await result.

```typescript
// Pseudocode
const child = fork('executor-runner.mjs', [], {
  env: { GATEWAY_URL: 'ws://127.0.0.1:18789', GATEWAY_TOKEN: authToken },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});
child.send({ prompt, model, sessionKey, jobId });

const result = await new Promise((resolve, reject) => {
  child.on('message', (msg) => resolve(msg.result));
  child.on('exit', (code) => { if (code !== 0) reject(new Error(`Exit ${code}`)); });
  setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')); }, timeoutMs);
});
```

### 4.2 Token Monitor

**Problem:** Token monitor uses in-memory `globalThis` Maps. Child processes don't share memory.

**Solutions (pick one):**
1. **IPC bridge:** Child process sends token usage events to gateway via IPC. Gateway updates the in-memory Map.
2. **SQLite ledger:** Move token monitor state from memory to SQLite. Both gateway and executors write to the same DB. Token monitor CLI reads from SQLite.
3. **Gateway RPC:** Add a `tokenMonitor.record` RPC method. Executor calls it via WebSocket just like it calls `agent`.

**Recommendation:** Option 3 (Gateway RPC). It's consistent with how the executor already communicates — via `callGateway()`. One new RPC method, minimal code change.

### 4.3 Auth Profiles

**No change needed.** The executor doesn't read auth profiles directly. It calls `callGateway({ method: "agent" })`, and the gateway's pi-embedded runner handles auth internally. The child process never touches auth files.

### 4.4 Cortex Feed

**No change needed.** Cortex hooks (`__openclaw_cortex_feed__`) are called by the gateway's dispatch layer, not by the executor. The executor just calls `callGateway()` — all cortex integration happens on the gateway side.

### 4.5 Result Delivery

**No change needed.** The notifier already delivers results by calling `callGateway({ method: "agent" })` to push to the issuer session. This happens in the gateway process, not the executor.

### 4.6 Session Cleanup

**No change needed.** The executor already calls `callGateway({ method: "sessions.delete" })` for cleanup. This works from a child process identically.

### 4.7 Queue Database

**No change needed.** SQLite handles concurrent access. The worker (gateway process) writes status updates; the child process doesn't touch the queue directly.

---

## 5. What We Gain

### 5.1 Fault Isolation
A crashed executor kills only its child process. Gateway continues running. Main agent stays responsive. WhatsApp stays connected. Other executors are unaffected.

### 5.2 Resource Control
- **Memory limits:** Set `--max-old-space-size` per executor process
- **CPU limits:** Use OS-level cgroups or nice/priority
- **Timeout enforcement:** `child.kill('SIGTERM')` is reliable — no more "stuck InProgress" rows that need 2-minute stale detection
- **Concurrency control:** Worker pool size = max parallel executors

### 5.3 Observability
- Each executor has its own PID (real OS PID, not a UUID prefix)
- `ps aux | grep executor` shows all running executors
- Per-process memory/CPU visible in task manager
- Killed executors leave exit codes for debugging

### 5.4 Horizontal Scaling (Future)
Once executors are process-isolated, moving them to **remote machines** is a small step: replace `fork()` with SSH or a job queue (Redis, NATS). The executor already communicates via WebSocket — it just needs to connect to a remote gateway URL instead of localhost.

---

## 6. What We Lose (Trade-offs)

| Loss | Severity | Mitigation |
|------|----------|------------|
| Fork overhead (~100-200ms) | Low | Negligible vs 10-300s runtime. Worker pool eliminates it. |
| Memory duplication | Low | Node.js fork uses copy-on-write. Base overhead ~30-50MB per executor. |
| Token monitor direct access | Medium | RPC bridge (§4.2, Option 3) adds ~1ms latency per update. |
| Debugging complexity | Low | IPC adds one layer. Executor logs to own stderr, captured by worker. |
| `globalThis` shared state | Medium | Must audit all `globalThis` keys used by executor code path. Known: job ID, task label, cortex hooks. |

---

## 7. Implementation Plan

### Phase 1: Fork-per-Job (MVP)

1. **Executor runner script** — standalone `.mjs` that receives job params, connects to gateway WS, runs `callGateway()`, returns result via IPC
2. **Worker refactor** — replace `await executor(prompt, model)` with `fork()` + IPC
3. **Token monitor RPC** — add `tokenMonitor.record` gateway method for child process reporting
4. **Timeout enforcement** — `SIGTERM` after configured timeout, `SIGKILL` after grace period
5. **Tests** — verify isolation: crash one executor, confirm gateway survives

### Phase 2: Worker Pool (Optimization)

1. **Pool manager** — pre-fork N workers, assign jobs via IPC
2. **Health monitoring** — restart workers that crash or exceed memory
3. **Concurrency config** — `router.executors.poolSize` in openclaw.json
4. **Backpressure** — when pool is full, queue jobs instead of spawning unbounded

### Phase 3: Remote Execution (Future)

1. **Remote executor protocol** — executor connects to remote gateway URL
2. **Job distribution** — gateway distributes jobs across machines
3. **Result aggregation** — results flow back through the same RPC channel

---

## 8. Configuration (Proposed)

```json
{
  "router": {
    "enabled": true,
    "executors": {
      "isolation": "process",
      "maxConcurrent": 4,
      "timeoutMs": 300000,
      "killGraceMs": 5000,
      "maxMemoryMb": 512,
      "pool": {
        "enabled": false,
        "size": 2,
        "idleTimeoutMs": 60000
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `isolation` | `"process"` | `"inline"` (current behavior) or `"process"` (child process) |
| `maxConcurrent` | 4 | Maximum simultaneous executor processes |
| `timeoutMs` | 300000 | Per-job timeout before SIGTERM (5 minutes) |
| `killGraceMs` | 5000 | Time between SIGTERM and SIGKILL |
| `maxMemoryMb` | 512 | `--max-old-space-size` per executor process |
| `pool.enabled` | false | Use persistent worker pool instead of fork-per-job |
| `pool.size` | 2 | Number of pre-forked workers |

---

## 9. Open Questions

- **Gateway auth for child processes:** The executor needs to authenticate with the gateway WebSocket. Currently auth uses a static token (`gateway.auth.token`). Child processes can receive this via env var. Secure enough for localhost? For remote executors, we'd need per-executor tokens or mTLS.
- **Workspace isolation:** Current executors use `workspace-router-executor/` as their workspace. In process-isolated mode, should each executor get a temp directory (true isolation) or share the existing workspace (simpler, risk of file conflicts)?
- **Log aggregation:** Executor stderr goes to the child process. Should we pipe it to the gateway's log file? Separate per-executor logs? Both?
- **Hot reload:** When the gateway rebuilds, in-process executors die with it. Process-isolated executors could survive a gateway restart and reconnect — is this desirable or a footgun?

---

*This document proposes moving Router Executors from in-process async functions to child processes. The key insight is that executors already communicate with the gateway via WebSocket RPC (`callGateway`) — they just happen to be calling themselves. Moving them to separate processes requires minimal code changes because the communication protocol is already remote-capable.*
