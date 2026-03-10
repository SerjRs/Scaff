# Executor Architecture v2 — Process-Isolated Workers with IPC

*Version: 2.0 — 2026-03-10*
*Status: Draft*
*Authors: Serj & Scaff*
*Supersedes: `process-isolated-executors-architecture.md`*
*Ref: `cortex-architecture.md`, `router-architecture-v2.md`, `cortex-implementation-tasks.md` (Phases 8-10)*

---

## 1. Design Principles

**Cortex is the brain. Executors are disposable hands.**

Cortex runs the most sophisticated model (Opus) and never burns tokens on work that cheaper tiers can handle. It has exactly one tool — `sessions_spawn` — to delegate. Everything else happens in executors.

Executors are standalone child processes. They receive a task, execute it with full tooling, and return a result. They can produce files. They can ask Cortex for guidance mid-execution. When they crash, nothing else dies.

The architecture follows the **Actor Model with Supervision** (Erlang OTP):

| Concept | Actor Model | Our System |
|---|---|---|
| Supervisor | Monitors workers, handles failures | Gateway (Router + Notifier) |
| Brain | Makes decisions, delegates | Cortex |
| Worker | Executes tasks, reports back, can escalate | Executor (child process) |
| Mailbox | Message queue, processed sequentially | cortex_bus (SQLite) |
| Message passing | IPC between actors | Node.js fork() IPC channel |
| Supervision strategy | Restart, fail, escalate | Retry once, then fail + notify Cortex |

**Communication is parent-child IPC only.** No WebSocket. No auth tokens. No network calls. The executor doesn't know the gateway exists — it speaks a typed message protocol on its IPC channel and writes files to its workspace directory.

---

## 2. End-to-End Flow

```
User (WhatsApp/Webchat)
     │
     ↓
Cortex (Opus, conversational)
     │ "I need to research X"
     │ generates taskId (UUID)
     │ writes cortex_pending_ops { taskId, reply_channel, result_priority, description }
     │ calls sessions_spawn(taskId, task)
     │ responds immediately: "Let me look into that"
     ↓
Router
     │ receives { taskId, message, issuer }
     │ evaluates complexity (Ollama → Sonnet verification)
     │ assigns tier + model (Haiku/Sonnet/Opus)
     │ renders tier-specific prompt template
     ↓
Worker (gateway process)
     │ fork() → child process
     │ sends job via IPC: { type:'job', taskId, prompt, model, sessionKey }
     │ monitors child: heartbeat, timeout, crash
     ↓
Executor (child process)                        Cortex (if guidance needed)
     │ receives job via IPC                          │
     │ executes with full tooling                    │
     │ (read/write/exec/browser/web)                 │
     │                                               │
     │── {type:'ask', question:'A or B?'} ──────────>│ (via gateway IPC relay)
     │<── {type:'guidance', answer:'Use A'} ─────────│
     │                                               │
     │ writes files to tasks/<taskId>/               │
     │ writes manifest.json                          │
     │── {type:'result', ok:true, data:'...'} ──>│
     │ exits                                    │
     ↓                                          │
Worker                                          │
     │ reads manifest.json                      │
     │ updates job: status='completed'          │
     ↓                                          │
Notifier                                        │
     │ fires job:delivered event                │
     ↓                                          │
gateway-bridge.ts                               │
     │ looks up cortex_pending_ops by taskId    │
     │ reads reply_channel, result_priority     │
     │ creates envelope:                        │
     │   channel = reply_channel (e.g. "webchat")
     │   priority = result_priority             │
     │   content = result + artifact refs       │
     │ feeds to cortex_bus                      │
     ↓                                          │
Cortex                                          │
     │ processes result from bus                │
     │ delivers answer to user                  │
     │ op transitions: completed → (gardener) → gardened → archived
     │ Gardener extracts facts into hot memory  │
     ↓
User gets the answer
```

---

## 3. IPC Protocol

Communication between gateway (parent) and executor (child) uses Node.js `child_process.fork()` IPC. No WebSocket, no auth, no network.

### 3.1 Message Types

```typescript
// ── Gateway → Executor ──────────────────────────────────

type GatewayToExecutor =
  | { type: 'job'; taskId: string; prompt: string; model: string; sessionKey: string }
  | { type: 'guidance'; requestId: string; answer: string }
  | { type: 'kill'; reason: string }

// ── Executor → Gateway ──────────────────────────────────

type ExecutorToGateway =
  | { type: 'progress'; taskId: string; status: string; tokensUsed?: number }
  | { type: 'ask'; requestId: string; question: string; timeoutMs?: number }
  | { type: 'artifact'; taskId: string; path: string; metadata: ArtifactMeta }
  | { type: 'result'; taskId: string; ok: boolean; data?: string; error?: string }

interface ArtifactMeta {
  filename: string;
  type: string;          // "markdown" | "code" | "image" | "json" | "binary"
  size: number;          // bytes
  description?: string;  // human-readable summary
}
```

### 3.2 Message Flow

**Happy path:**
```
Gateway                              Executor
   │                                    │
   │── {type:'job', ...} ──────────────>│
   │                                    │ (working...)
   │<── {type:'progress', status} ─────│  (every 30s)
   │<── {type:'artifact', path} ───────│  (file produced)
   │<── {type:'result', ok:true} ──────│
   │                                    │ (exits 0)
   │<── exit event ─────────────────────│
```

**With guidance request:**
```
Gateway                              Executor
   │                                    │
   │── {type:'job', ...} ──────────────>│
   │                                    │ (working...)
   │<── {type:'ask', question} ─────────│
   │                                    │ (waiting, up to timeoutMs)
   │    ┌──── relay to Cortex bus ────┐ │
   │    │    Cortex processes...      │ │
   │    └──── Cortex replies ─────────┘ │
   │── {type:'guidance', answer} ──────>│
   │                                    │ (continues working)
   │<── {type:'result', ok:true} ──────│
```

**Timeout / crash:**
```
Gateway                              Executor
   │                                    │
   │── {type:'job', ...} ──────────────>│
   │                                    │ (working...)
   │    (timeoutMs expires)             │
   │── {type:'kill', reason} ──────────>│
   │    (wait killGraceMs)              │
   │    (SIGTERM)                       │
   │    (wait killGraceMs)              │
   │    (SIGKILL if still alive)        │
   │                                    │ (dead)
   │    → job marked 'failed'           │
   │    → Cortex notified               │
```

### 3.3 Why IPC, Not WebSocket

| | WebSocket (current proposal) | IPC (this proposal) |
|---|---|---|
| Setup | Connect to `ws://127.0.0.1:18789`, authenticate | Free — comes with `fork()` |
| Auth | Gateway token in env var | Not needed — parent-child only |
| Reconnect | Must handle disconnects | Channel is process lifetime |
| Overhead | TCP + WebSocket framing + JSON | Kernel IPC pipe, minimal framing |
| Monitoring | Manual health checks | `child.on('exit')`, `child.on('error')` |
| Kill | HTTP request or signal | `child.kill('SIGTERM')` |
| Complexity | ~200 lines for client + reconnect | ~20 lines for send/receive |

---

## 4. Executor Process

### 4.1 Entry Point

**File:** `src/router/executor-runner.mjs`

Standalone Node.js script. Receives job via IPC, executes using tool harness, returns result via IPC. Exits on completion.

```typescript
// Pseudocode
process.on('message', async (msg) => {
  if (msg.type === 'job') {
    const { taskId, prompt, model, sessionKey } = msg;

    try {
      // Set up tool harness
      const tools = createToolHarness({
        workdir: `workspace-router-executor/tasks/${taskId}`,
        onAsk: (question, timeoutMs) => askCortex(question, timeoutMs),
        onArtifact: (path, meta) => reportArtifact(taskId, path, meta),
        onProgress: (status) => reportProgress(taskId, status),
      });

      // Execute the task with the LLM
      const result = await runAgent({ prompt, model, tools });

      // Write manifest if artifacts were produced
      await writeManifest(taskId);

      // Report result
      process.send({ type: 'result', taskId, ok: true, data: result });
    } catch (err) {
      process.send({ type: 'result', taskId, ok: false, error: err.message });
    }

    process.exit(0);
  }

  if (msg.type === 'guidance') {
    // Resolve pending guidance request
    guidanceResolvers.get(msg.requestId)?.(msg.answer);
  }

  if (msg.type === 'kill') {
    process.exit(1);
  }
});
```

### 4.2 Tool Harness

The executor gets full tool access — it IS the hands. Tools available:

| Tool | Description |
|---|---|
| `read` | Read files (project workspace + task workspace) |
| `write` | Write files to task workspace |
| `edit` | Edit files |
| `exec` | Shell commands (sandboxed to task workspace) |
| `web_search` | Brave search API |
| `web_fetch` | Fetch and extract URL content |
| `browser` | Browser automation |
| `code_search` | Semantic search over codebase index |

Tools NOT available (Cortex-only):

| Tool | Why excluded |
|---|---|
| `sessions_spawn` | Only Cortex delegates — executors don't spawn sub-executors |
| `message` | Only Cortex communicates with the user |
| `memory_search` / `memory_get` | Only Cortex accesses long-term memory |
| `tts` | Only Cortex speaks |

### 4.3 Workspace

Each task gets an isolated directory:

```
workspace-router-executor/
  tasks/
    <taskId>/
      manifest.json          ← written on completion
      <any files executor produces>
```

The executor can READ from the main project workspace (for code context) but only WRITES to its task directory. This prevents executors from stomping on each other or on the main workspace.

### 4.4 Manifest

Written by the executor on completion. Read by the Worker to register artifacts.

```json
{
  "taskId": "abc-123",
  "completedAt": "2026-03-10T17:00:00Z",
  "artifacts": [
    {
      "filename": "report.md",
      "path": "tasks/abc-123/report.md",
      "type": "markdown",
      "size": 4096,
      "description": "Analysis of WhatsApp delivery pipeline"
    },
    {
      "filename": "diagram.png",
      "path": "tasks/abc-123/diagram.png",
      "type": "image",
      "size": 102400,
      "description": "Architecture diagram"
    }
  ]
}
```

No DB table needed. The filesystem IS the registry. The Worker reads the manifest after the child exits and includes artifact references in the result delivered to Cortex.

---

## 5. Executor ↔ Cortex Guidance Channel

### 5.1 The Pattern

This is the **Escalation Pattern** from Erlang's supervisor architecture. A worker encounters ambiguity and escalates to the supervisor (Cortex) for a decision.

```
Executor: "The user asked for analysis but I found two conflicting datasets.
           Should I use dataset A (2024, larger) or dataset B (2025, smaller)?"

Cortex:   "Use dataset B — the user is working on a 2025 report."

Executor: (continues with dataset B)
```

### 5.2 Implementation

**Executor side:**

```typescript
// In executor-runner.mjs
const guidanceResolvers = new Map<string, (answer: string) => void>();

async function askCortex(question: string, timeoutMs = 60_000): Promise<string> {
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      guidanceResolvers.delete(requestId);
      resolve('[no guidance received — proceeding with best judgment]');
    }, timeoutMs);

    guidanceResolvers.set(requestId, (answer) => {
      clearTimeout(timer);
      guidanceResolvers.delete(requestId);
      resolve(answer);
    });

    process.send({ type: 'ask', requestId, question, timeoutMs });
  });
}

// When guidance arrives:
process.on('message', (msg) => {
  if (msg.type === 'guidance') {
    guidanceResolvers.get(msg.requestId)?.(msg.answer);
  }
});
```

**Gateway side (Worker):**

```typescript
// In worker.ts, when child sends {type:'ask'}
child.on('message', async (msg) => {
  if (msg.type === 'ask') {
    // Relay to Cortex via the bus
    const envelope = createEnvelope({
      channel: 'executor',
      sender: { id: `executor:${taskId}`, relationship: 'internal' },
      content: `[EXECUTOR GUIDANCE REQUEST]\nTask: ${taskDescription}\nQuestion: ${msg.question}`,
      priority: 'urgent',   // executor is blocked waiting
      replyContext: { channel: 'executor', taskId, requestId: msg.requestId },
    });

    feedCortex(envelope);

    // Cortex will process and reply. The reply arrives as a
    // Cortex output targeting channel='executor', which the
    // executor adapter routes back to the child via IPC.
  }
});
```

**Cortex side:**

Cortex sees the guidance request as a high-priority message in its bus:

```
[EXECUTOR GUIDANCE REQUEST]
Task: Analyze WhatsApp delivery pipeline
Question: Found two conflicting datasets. Use A (2024, larger) or B (2025, smaller)?
```

Cortex responds naturally. The executor adapter (`channel: 'executor'`) routes Cortex's reply back through the Worker's IPC to the child process.

### 5.3 Timeout Behavior

The executor sets a timeout (default 60s). If Cortex doesn't reply in time:
- The `askCortex()` Promise resolves with a fallback message
- The executor continues with its best judgment
- No deadlock, no blocking

Cortex processes messages sequentially. If Cortex is busy with a user message when the guidance request arrives, the request queues in the bus with `priority: 'urgent'` — it will be processed next after the current turn.

### 5.4 When to Ask vs When to Decide

The executor's prompt template should include guidance:

```
If you encounter ambiguity that could significantly change the outcome:
- Ask for guidance using the ask_cortex tool
- Include the specific options you're considering and why
- Continue with your best judgment if no response within 60 seconds

Do NOT ask for guidance on:
- Formatting decisions
- Minor implementation details
- Things the task description already covers
```

---

## 6. Worker (Gateway Side)

### 6.1 Fork and Monitor

**File:** `src/router/worker.ts`

```typescript
async function forkExecutor(params: {
  taskId: string;
  prompt: string;
  model: string;
  sessionKey: string;
  taskDescription: string;
  config: ExecutorConfig;
}): Promise<ForkResult> {

  const child = fork(EXECUTOR_RUNNER_PATH, [], {
    execArgv: [`--max-old-space-size=${config.maxMemoryMb}`],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // Send job
  child.send({ type: 'job', taskId, prompt, model, sessionKey });

  // Monitor
  const heartbeatInterval = setInterval(() => {
    updateJobCheckpoint(db, taskId);
  }, 30_000);

  // Handle messages from child
  child.on('message', async (msg) => {
    switch (msg.type) {
      case 'progress':
        updateJobStatus(db, taskId, msg.status);
        break;
      case 'ask':
        relayGuidanceRequest(taskId, msg, child);
        break;
      case 'artifact':
        registerArtifact(taskId, msg);
        break;
      case 'result':
        clearInterval(heartbeatInterval);
        resolveResult(msg);
        break;
    }
  });

  // Timeout enforcement
  const timer = setTimeout(() => {
    child.send({ type: 'kill', reason: 'timeout' });
    setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, config.killGraceMs);
    }, config.killGraceMs);
  }, config.timeoutMs);

  // Wait for result or exit
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(heartbeatInterval);
      if (!resultReceived) {
        reject(new Error(`Executor exited with code ${code} without result`));
      }
    });
  });
}
```

### 6.2 Configuration

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

| Key | Default | Description |
|-----|---------|-------------|
| `isolation` | `"inline"` | `"inline"` (current in-process) or `"process"` (child process) |
| `maxConcurrent` | 2 | Maximum simultaneous executor processes |
| `timeoutMs` | 300000 | Per-job timeout before SIGTERM (5 min) |
| `killGraceMs` | 5000 | Grace period between SIGTERM and SIGKILL |
| `maxMemoryMb` | 512 | V8 heap limit per executor process |

### 6.3 Inline Fallback

When `isolation: "inline"`, the existing in-process `callGateway()` path runs unchanged. This is the default — zero behavior change on upgrade. Switch to `"process"` when ready.

---

## 7. Integration with Existing Systems

### 7.1 Cortex Pending Ops (Already Implemented — Phase 9-10)

Cortex owns the full task lifecycle. No changes needed:

```
Cortex generates taskId
  → writes cortex_pending_ops { taskId, reply_channel, result_priority, description }
  → calls sessions_spawn(taskId, task)
  → responds immediately to user

Result arrives:
  → gateway-bridge.ts looks up cortex_pending_ops by taskId
  → reads reply_channel, result_priority from Cortex's own table
  → creates envelope with channel = reply_channel
  → feeds to cortex_bus with correct priority

Op lifecycle:
  → pending (dispatched, awaiting result)
  → completed (result arrived, unacknowledged — visible to Cortex as [NEW RESULT])
  → acknowledged (Cortex read it, delivered to user)
  → gardened (Gardener extracted facts into hot memory)
  → archived (7 days later, zero token cost)
```

Process isolation doesn't change any of this. The Worker is the only component that changes — instead of calling `callGateway()` in-process, it forks a child.

### 7.2 Token Monitor

Currently uses `globalThis` Maps. With process isolation:

- **Job registration:** Worker calls `registerJobSession(jobId, sessionKey)` BEFORE fork — runs in gateway process, direct Map access. No change.
- **Token usage updates:** Child sends `{type: 'progress', tokensUsed}` via IPC. Worker receives and updates the Map. No new RPC method needed.
- **PID tracking:** Worker stores `child.pid` in the token monitor entry — real OS PID, not gateway PID.

### 7.3 Crash Recovery

On gateway startup (already implemented in `recovery.ts`):

1. Jobs in `evaluating` → reset to `in_queue`
2. Jobs in `in_execution` → check `last_checkpoint`:
   - Recent checkpoint + retry_count < 2 → reset to `pending`
   - Else → mark `failed`
3. Cortex: orphaned pending ops → `failPendingOp()` → visible to Cortex as `[FAILED]`

With process isolation: same logic. Child processes die when gateway dies. On restart, the recovery sweep handles all stuck jobs identically.

### 7.4 Evaluator

No change. The evaluator runs in the gateway process (it's a single LLM call, no tools, no isolation needed). Only the execution step moves to a child process.

### 7.5 Notifier

No change. The Notifier listens for `routerEvents` (EventEmitter) in the gateway process. The Worker emits events after the child exits and result is collected. Same flow as today.

---

## 8. Result Delivery with Artifacts

When a task produces files, the result delivered to Cortex includes artifact references:

### 8.1 Worker Collects Artifacts

After the child exits, the Worker reads `tasks/<taskId>/manifest.json`:

```typescript
// In worker.ts, after child exits with result
const manifestPath = `workspace-router-executor/tasks/${taskId}/manifest.json`;
let artifacts = [];
if (fs.existsSync(manifestPath)) {
  artifacts = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).artifacts;
}
```

### 8.2 Result Format to Cortex

The result pushed to the Cortex bus includes artifact references:

```
Task completed: Analyze WhatsApp delivery pipeline

Result:
The pipeline has three failure points...
[truncated analysis]

Artifacts:
- report.md (4 KB) — Full analysis with code references
- diagram.png (100 KB) — Architecture diagram
  Path: workspace-router-executor/tasks/abc-123/
```

Cortex can then:
- Reference artifacts in its response to the user ("I've written a detailed report")
- Read artifact contents if needed (via Cortex's own tools or a follow-up task)
- Include artifact paths in the message to the user

### 8.3 Artifact Cleanup

Task directories persist until explicitly cleaned. Options:
- Manual cleanup: `rm -rf workspace-router-executor/tasks/<taskId>/`
- Scheduled cleanup: delete task directories older than 7 days (same cadence as op archival)
- Cortex-triggered: Cortex decides when artifacts are no longer needed

---

## 9. What Changes from Current Architecture

| Component | Before (in-process) | After (process-isolated) |
|---|---|---|
| **Executor runtime** | Async function in gateway event loop | Child process via `fork()` |
| **Communication** | `callGateway()` WebSocket to self | IPC messages (typed protocol) |
| **Kill mechanism** | Cancel token (unreliable) | SIGTERM → SIGKILL (OS-level) |
| **Memory isolation** | Shared V8 heap with gateway | Separate V8 heap, `--max-old-space-size` |
| **Crash blast radius** | Executor crash kills gateway | Executor crash kills only itself |
| **PID** | Gateway PID for all executors | Real per-executor OS PID |
| **Token monitor** | Direct `globalThis` Map access | IPC progress messages → parent updates Map |
| **Heartbeat** | Direct SQLite write from worker | IPC progress → parent writes SQLite |
| **Result delivery** | In-process event emission | IPC result → parent emits event |
| **Guidance (Cortex ask)** | Not possible | IPC ask → parent relays to Cortex bus → IPC reply |
| **File artifacts** | Not possible (text-only results) | Write to task dir → manifest → parent collects |

**What does NOT change:**
- Cortex pending ops lifecycle (Phase 9-10)
- Issuer-owned task IDs (Phase 10)
- Evaluator (stays in-process)
- Notifier (stays in-process)
- Router queue (SQLite, same schema)
- Crash recovery logic
- Template engine
- Tier assignment

---

## 10. Security Boundaries

| Boundary | Enforcement |
|---|---|
| Executor can't talk to users | No `message` tool, no channel adapters |
| Executor can't spawn sub-tasks | No `sessions_spawn` tool |
| Executor can't access memory | No `memory_search` / `memory_get` tools |
| Executor can't escape task dir (writes) | Tool harness enforces `workdir` |
| Executor can't exceed memory | `--max-old-space-size` per process |
| Executor can't exceed time | SIGTERM/SIGKILL after timeout |
| Gateway auth not exposed | IPC, no auth tokens needed |
| Executors can't talk to each other | Each process only has IPC to parent |

---

## 11. Implementation Phases

### Phase 1: Executor Runner Script
- Create `src/router/executor-runner.mjs` — standalone entry point
- Implement IPC message handling (job, guidance, kill)
- Implement tool harness with workspace isolation
- Write manifest on completion
- **Tests:** IPC receive/send, tool execution, manifest writing, error handling

### Phase 2: Worker Fork Refactor
- Add `forkExecutor()` to `worker.ts`
- IPC message routing (progress, ask, artifact, result)
- Timeout enforcement (SIGTERM → SIGKILL)
- `isolation` config switch (inline vs process)
- **Tests:** Fork, timeout, crash survival, inline fallback

### Phase 3: Token Monitor Adapter
- Register job before fork (gateway-side, direct Map access)
- Route IPC progress messages to Map updates
- Store child PID in monitor entry
- **Tests:** PID tracking, token updates via IPC, inline compat

### Phase 4: Guidance Channel
- Worker relays `{type:'ask'}` to Cortex bus via `feedCortex()`
- Register executor adapter in Cortex adapter registry
- Cortex output targeting `channel: 'executor'` routes back through Worker IPC
- Executor-side `askCortex()` with timeout fallback
- **Tests:** Round-trip guidance, timeout fallback, Cortex busy (queued), multiple concurrent asks

### Phase 5: File Artifacts
- Task workspace directory creation/cleanup
- Manifest writing in executor
- Manifest reading in Worker after exit
- Artifact references in result envelope to Cortex
- Scheduled cleanup (7-day TTL)
- **Tests:** Manifest round-trip, artifact references in Cortex result, cleanup

### Phase 6: Integration Tests
- End-to-end: dispatch → fork → execute → result → Cortex
- Executor crash: gateway survives, job marked failed, Cortex notified
- Executor timeout: SIGTERM/SIGKILL, job failed
- Guidance round-trip: executor asks → Cortex answers → executor continues
- File artifacts: executor produces files → manifest → Cortex sees references
- Concurrent: 4 executors, all complete, no interference
- Inline fallback: `isolation: 'inline'` → existing behavior unchanged

### Dependencies

```
Phase 1 (runner) → Phase 2 (worker fork) → Phase 3 (token monitor)
                                         → Phase 4 (guidance) 
                                         → Phase 5 (artifacts)
                                                    ↓
                                              Phase 6 (E2E)
```

Phase 1-2 are the critical path. Phases 3-5 are parallel. Phase 6 validates everything.

---

## 12. Files Summary

### New Files

| File | Phase | Description |
|------|-------|-------------|
| `src/router/executor-runner.mjs` | 1 | Standalone child process entry point |
| `src/cortex/adapters/executor.ts` | 4 | Executor channel adapter for guidance replies |

### Modified Files

| File | Phase | Description |
|------|-------|-------------|
| `src/router/worker.ts` | 2, 3, 4, 5 | `forkExecutor()`, IPC routing, timeout, artifact collection |
| `src/router/dispatcher.ts` | 2 | Pass config to `run()` |
| `src/router/loop.ts` | 2 | Pass config to `dispatch()`, configurable maxConcurrent |
| `src/router/types.ts` | 2 | `ExecutorConfig` interface |
| `src/cortex/gateway-bridge.ts` | 4 | Register executor adapter, relay guidance replies |
| `src/token-monitor/ledger.ts` | 3 | Store child PID |

### Unchanged (explicitly)

| File | Why |
|------|-----|
| `src/cortex/loop.ts` | Cortex processing loop — no executor changes |
| `src/cortex/session.ts` | Pending ops — already correct |
| `src/cortex/context.ts` | Context assembly — unaffected |
| `src/router/queue.ts` | Queue schema — unaffected |
| `src/router/notifier.ts` | Event-based — unaffected |
| `src/router/evaluator.ts` | Stays in-process — no change |
| `src/router/gateway-integration.ts` | `createGatewayExecutor()` stays for inline mode |

---

## 13. Rollout

1. **Merge with `isolation: 'inline'` as default** — zero behavior change
2. **Test with `isolation: 'process'` on dev** — run E2E suite
3. **Enable `isolation: 'process'` in production** — flip config, monitor 24h
4. **Validate guidance channel** — trigger executor ask, verify Cortex responds
5. **Validate artifacts** — trigger file-producing task, verify manifest + references
6. **Remove inline path** (optional, after confidence)
