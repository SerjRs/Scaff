# Router Implementation — Task Execution Plan

**Source:** `docs/router-architecture-v2.md`
**Codebase:** `C:\Users\Temp User\.openclaw` (OpenClaw 2026.2.25, source build)
**Date:** 2026-02-26 (updated: context isolation tasks added)

---

## Task Summary

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Types & Schema | ✅ Done | `types.ts`, `queue.ts` schema |
| 2 | Queue Operations | ✅ Done | 8 functions, SQLite WAL |
| 3 | Template Engine | ✅ Done | 3 tier templates (placeholders) |
| 4 | Evaluator | ✅ Done | Two-stage: Ollama + Sonnet verification |
| 5 | Worker | ✅ Done | 30s heartbeat, EventEmitter |
| 6 | Dispatcher | ✅ Done | weight → tier → model → template → worker |
| 7 | Notifier | ✅ Done | Push-based, 5min timeout |
| 8 | Router Loop + Watchdog | ✅ Done | 1s loop, 30s watchdog, MAX_CONCURRENT=2 |
| 9 | Crash Recovery | ✅ Done | All stuck states handled |
| 10 | Router Service Entry | ✅ Done | startRouter → RouterInstance |
| 11 | Gateway Integration | ✅ Done | routerCallGateway, initGatewayRouter, wiring |
| 12 | E2E Tests | ✅ Done | 164 tests passing |
| 13 | **Executor Agent Profile** | 🔲 TODO | Context isolation — empty workspace agent |
| 14 | **Executor Isolation Wiring** | 🔲 TODO | Worker uses `router-executor` sessions |
| 15 | **Context Isolation E2E Tests** | 🔲 TODO | 10 test scenarios |
| 16 | **Auth Sync Mechanism** | 🔲 TODO | Startup hook syncs auth to executor agent |
| — | **Caller-Provided Task IDs** | ✅ Done | `enqueue()` accepts optional `taskId` param |

---

## Task Order

Each task is self-contained, testable, and builds on the previous one.

---

### Task 1: Types & Schema
**Files:** `src/router/types.ts`, `src/router/queue.ts` (schema only)

Define all TypeScript types and the SQLite schema:
- `RouterJob` interface: id, type, status, weight, tier, issuer, payload, result, error, retry_count, worker_id, last_checkpoint, checkpoint_data, timestamps
- `JobStatus` enum: `in_queue`, `evaluating`, `pending`, `in_execution`, `completed`, `failed`, `canceled`
- `JobType` enum: `agent_run`
- `Tier` enum: `haiku`, `sonnet`, `opus`
- `EvaluatorResult` interface: `{ weight: number, reasoning: string }`
- SQLite schema for `jobs` and `jobs_archive` tables (create if not exists)
- DB initialization function: open SQLite at `~/.openclaw/router/queue.sqlite`, WAL mode, create tables

**Test:** Unit test — create DB, verify tables exist, verify WAL mode is on.

**Acceptance:** Types compile. DB initializes cleanly. Tables match the schema in the architecture doc.

---

### Task 2: Queue Operations
**Files:** `src/router/queue.ts`

Implement the SQLite queue operations:
- `enqueue(type, payload, issuer) → jobId` — INSERT with status `in_queue`, return UUID
- `dequeue() → RouterJob | null` — SELECT + UPDATE oldest `in_queue` job to `evaluating`
- `updateJob(id, fields)` — generic UPDATE for status transitions, weight, tier, result, error, etc.
- `getJob(id) → RouterJob | null` — SELECT by ID
- `archiveJob(id)` — INSERT INTO jobs_archive SELECT ... + DELETE FROM jobs
- `getHungJobs(thresholdSeconds: 90) → RouterJob[]` — SELECT `in_execution` jobs where last_checkpoint is older than threshold
- `getStuckJobs() → RouterJob[]` — for crash recovery: jobs in `evaluating` or `in_execution`
- `queryArchive(filters) → RouterJob[]` — query archived jobs by issuer, status, date range

**Test:** Unit test — enqueue 3 jobs, dequeue in FIFO order, update status, archive, verify archive queries work. Test hung job detection with fake timestamps.

**Acceptance:** All queue operations work against real SQLite. Archive preserves all data. FIFO ordering correct.

---

### Task 3: Template Engine
**Files:** `src/router/templates/index.ts`, `src/router/templates/haiku/agent_run.md`, `src/router/templates/sonnet/agent_run.md`, `src/router/templates/opus/agent_run.md`

Implement the template registry:
- `getTemplate(tier, jobType) → string` — reads the markdown template file
- `renderTemplate(template, variables) → string` — replaces `{task}`, `{context}`, `{issuer}`, `{constraints}` with actual values
- Create placeholder templates for all 3 tiers (will be replaced with real content later)

Placeholder templates should be functional but basic:
- Haiku: explicit, structured, step-by-step instructions
- Sonnet: balanced guidance
- Opus: minimal, trust the model

**Test:** Unit test — load each template, render with sample variables, verify output contains the substituted values.

**Acceptance:** All 3 templates load and render. Missing template throws a clear error.

---

### Task 4: Evaluator
**Files:** `src/router/evaluator.ts`

Implement the complexity scoring:
- Read evaluator config (model, tier, timeout, fallback_weight)
- Load the template for the evaluator's configured tier
- Render template with the task payload
- Make a single LLM completion call to the configured model (claude-sonnet-4-6)
- Parse the response for `{ weight, reasoning }`
- On failure/timeout: return `{ weight: fallback_weight, reasoning: "evaluator failed, using fallback" }`

**Config location:** `router.evaluator` in `openclaw.json`

**Test:** 
- Unit test with mocked LLM call — verify weight extraction, fallback on error, timeout handling.
- Integration test (live) — send a trivial task ("what is 2+2") and a complex task ("design a distributed system"), verify weights are in expected ranges.

**Acceptance:** Evaluator returns weight 1-10 for real tasks. Falls back gracefully on error. Never throws.

---

### Task 5: Worker
**Files:** `src/router/worker.ts`

Implement the agent execution wrapper:
- `run(jobId, prompt, model) → void`
- Call the gateway's existing agent execution (`agentCommand()` or equivalent in 2026.2.25)
- Start heartbeat timer: every 30s, UPDATE `last_checkpoint` on the job
- On success: update job to `completed` with result, stop heartbeat
- On failure: update job to `failed` with error, stop heartbeat
- Emit lifecycle event for Notifier

**Test:** 
- Unit test with mocked agentCommand — verify status transitions, heartbeat writes, result storage.
- Verify heartbeat timer starts and stops correctly.

**Acceptance:** Worker executes, heartbeats every 30s, writes result/error, cleans up timer.

---

### Task 6: Dispatcher
**Files:** `src/router/dispatcher.ts`

Implement tier resolution and worker dispatch:
- Read tier config (`router.tiers` in openclaw.json)
- `resolveWeightToTier(weight) → tier` — map weight to tier using config ranges
- `dispatch(job) → void`:
  1. Resolve weight → tier → model from config
  2. Load template for tier + job type
  3. Render template with job payload
  4. Update job: set tier, status → `in_execution`
  5. Call `worker.run(job.id, prompt, model)` (fire-and-forget)

**Test:** Unit test — verify weight 2 → haiku, weight 5 → sonnet, weight 9 → opus. Verify template is rendered and worker is called with correct model.

**Acceptance:** Dispatcher correctly maps weights to tiers and models. Worker is invoked with rendered prompt.

---

### Task 7: Notifier
**Files:** `src/router/notifier.ts`

Implement result delivery:
- Listen for job lifecycle events (completed/failed)
- `deliver(job) → void`:
  1. Stamp `delivered_at` on the job
  2. Emit event with job ID + result (for enqueueAndWait Promises)
  3. Push system message to the issuer's session
  4. Move job to `jobs_archive`
- Event emitter for sync waiters: `waitForJob(jobId, timeout) → Promise<result>`

**Test:** 
- Unit test — verify delivered_at is stamped, archive happens, event is emitted.
- Test waitForJob resolves when job completes.
- Test waitForJob times out correctly.

**Acceptance:** Results delivered to issuers. Sync waiters resolve. Jobs archived after delivery.

---

### Task 8: Router Loop + Watchdog
**Files:** `src/router/loop.ts`

Implement the main processing loop and hang detection:
- Loop: poll for `in_queue` jobs, pass through evaluator → dispatcher
- Watchdog timer (every 30s): scan for hung jobs (no checkpoint for 90s)
  - If retry_count < 2: reset to `pending`, increment retry_count
  - If retry_count >= 2: mark `failed`
- Retry handling: on failed jobs with retry_count < 2, wait 5s, reset to `pending`
- **`job:failed` emission:** Catch blocks in the loop emit `routerEvents.emit("job:failed", { jobId, error })` when the evaluator or dispatcher crashes. This is critical — without it, loop-level failures leave orphaned pending ops in Cortex's System Floor forever (the worker never starts, so `worker.ts` never emits the failure event).

**Test:**
- Integration test — enqueue a job, verify it flows through evaluation → dispatch → execution.
- Test watchdog detects a hung job (mock a stale checkpoint).
- Test retry flow: fail once → retry → succeed.
- Test permanent failure after 2 retries.
- Test `job:failed` emitted when dispatch throws.
- Test `job:failed` emitted when evaluator throws.
- Test `job:failed` emitted when retry dispatch throws.
- Test `job:failed` NOT emitted on successful dispatch.

**Acceptance:** Full loop works. Watchdog catches hangs. Retries work correctly. All failure paths emit `job:failed`.

---

### Task 9: Crash Recovery
**Files:** `src/router/recovery.ts`

Implement startup recovery:
- `recover() → void` — called on gateway startup before the Router Loop begins
- Jobs in `evaluating` → reset to `in_queue`
- Jobs in `in_execution` with retry_count < 2 → reset to `pending`
- Jobs in `in_execution` with retry_count >= 2 → mark `failed`
- Jobs in `completed`/`failed` with no `delivered_at` → re-emit notification

**Test:**
- Unit test — seed DB with jobs in various stuck states, run recovery, verify all are in correct states.

**Acceptance:** All stuck jobs are recovered correctly on startup.

---

### Task 10: Router Service Entry
**Files:** `src/router/index.ts`

Wire everything together:
- `startRouter()` — initialize DB, run crash recovery, start Router Loop, start Watchdog
- `stopRouter()` — stop loop, stop watchdog, close DB
- Export `enqueue()` and `enqueueAndWait()` for external use

**Test:** Integration test — start router, enqueue a job, verify it completes end-to-end, stop router.

**Acceptance:** Router starts/stops cleanly. Full pipeline works.

---

### Task 11: Integration with callGateway()
**Files:** Modify existing `src/agents/subagent-spawn.ts` or wherever `callGateway()` is defined

Replace the direct HTTP self-call with Router enqueue:
- `sessions_spawn` with `mode="run"` → `enqueueAndWait()`
- `sessions_spawn` with `mode="session"` → `enqueue()`
- Gateway startup: call `startRouter()` before accepting connections
- Gateway shutdown: call `stopRouter()`

**CAUTION:** This modifies the gateway's core execution path. Must be thoroughly tested.

**Test:**
- End-to-end: spawn a subagent via `sessions_spawn` mode="run", verify it goes through the Router and returns result.
- End-to-end: spawn a subagent via `sessions_spawn` mode="session", verify async delivery.
- Verify main agent (direct conversation) is NOT affected by the Router.

**Acceptance:** `sessions_spawn` works exactly as before from the caller's perspective, but jobs go through the Router pipeline.

---

### Task 12: End-to-End Tests

Full pipeline tests covering all scenarios:

1. **Happy path (sync):** `enqueueAndWait` → evaluator scores → dispatcher picks tier → worker executes → result returned inline
2. **Happy path (async):** `enqueue` → full pipeline → result pushed to issuer session
3. **Trivial task → Haiku:** "What is 2+2" → weight 1-3 → haiku model
4. **Complex task → Opus:** "Design a distributed cache with consistency guarantees" → weight 8-10 → opus model
5. **Evaluator failure:** Mock evaluator error → fallback weight 5 → sonnet
6. **Worker failure + retry:** Mock worker error on first attempt → retry after 5s → succeed on second
7. **Permanent failure:** Mock worker error on both attempts → job fails → issuer notified
8. **Hang detection:** Mock worker that never finishes, no heartbeat → watchdog catches after 90s → retry
9. **Gateway crash recovery:** Seed stuck jobs → restart → verify recovery
10. **Archive queries:** Run several jobs → verify all appear in archive with correct data

**Acceptance:** All 10 tests pass. Router is production-ready.

---

---

### Task 13: Executor Agent Profile (Context Isolation)
**Files:** `openclaw.json`, `~/.openclaw/agents/router-executor/agent/auth-profiles.json`, `~/.openclaw/workspace-router-executor/` (empty dir)

Create the isolated executor agent that runs Router-dispatched tasks with zero inherited context.

**Steps:**

1. Add `router-executor` to `openclaw.json` under `agents.list[]`:
   ```json
   {
     "id": "router-executor",
     "name": "Router Executor",
     "workspace": "~/.openclaw/workspace-router-executor",
     "tools": { "exec": false, "web": false, "browser": false },
     "memorySearch": { "enabled": false },
     "skills": [],
     "subagents": { "maxConcurrent": 0 }
   }
   ```

2. Create empty workspace directory: `~/.openclaw/workspace-router-executor/`
   - **No files** — no SOUL.md, AGENTS.md, USER.md, MEMORY.md, TOOLS.md, IDENTITY.md
   - This is intentional: the Router's template is the complete instruction set

3. Create agent directory: `~/.openclaw/agents/router-executor/agent/`
   - Copy `auth-profiles.json` from `~/.openclaw/agents/main/agent/auth-profiles.json`
   - Both agents share the same API credentials

4. Verify the Zod schema in `src/config/zod-schema.ts` accepts `agents.list[]` entries with:
   - `tools` with `deny` array (tool names to block)
   - `skills` as an empty array
   - Note: `subagents.maxConcurrent` is NOT valid on individual agent entries (only in `agents.defaults`)

**Test:**
- Unit test: verify `resolveAgentWorkspaceDir(cfg, "router-executor")` returns the empty workspace path
- Unit test: verify `loadWorkspaceBootstrapFiles(emptyDir)` returns all files as `missing: true`
- Integration test: create a session with key `agent:router-executor:task:test-uuid`, verify no context files are injected into the system prompt

**Acceptance:** Agent config loads without validation errors. Workspace is empty. No context files are injected for `router-executor` sessions.

---

### Task 14: Executor Isolation Wiring
**Files:** `src/router/gateway-integration.ts`, `src/router/worker.ts`, `src/router/dispatcher.ts`

Wire the executor to create sessions under the `router-executor` agent instead of the `main` agent.

**Steps:**

1. **Update `createGatewayExecutor()`** in `gateway-integration.ts`:
   - Session key format: `agent:router-executor:task:<uuid>` (was `agent:main:router:<uuid>`)
   - Remove the `originalSessionKey` parameter — executor always uses isolated sessions
   - The template-rendered prompt (from Dispatcher) is the only user message

2. **Update `dispatch()`** in `dispatcher.ts`:
   - Do NOT pass `payload.context` (parent session key) to the worker
   - The rendered template is the complete prompt — no additional context

3. **Update `run()`** in `worker.ts`:
   - Remove the `sessionKey?` parameter — executor always creates its own isolated session
   - Session is under `router-executor` agent → empty workspace → no context files

4. **Update templates** to be self-contained:
   - Haiku: "You are a task executor. Answer the following concisely and directly.\n\n{task}"
   - Sonnet: "You are a task executor. Analyze and respond thoughtfully.\n\n{task}"
   - Opus: "You are a task executor for complex problems. Provide thorough analysis.\n\n{task}"
   - Templates must NOT reference workspace files, memory, or tools — the executor has none

5. **Auth sync hook** (startup):
   - On gateway startup, copy `agents/main/agent/auth-profiles.json` → `agents/router-executor/agent/auth-profiles.json`
   - Ensures executor always has current API credentials

**Test:**
- Unit test: verify executor creates sessions with `agent:router-executor:task:*` prefix
- Unit test: verify dispatcher does not pass parent context to worker
- Integration test: dispatch a task, verify the executor session has no SOUL.md/AGENTS.md/USER.md in its context
- Integration test: verify the executor can authenticate and call the API

**Acceptance:** Executor runs in fully isolated sessions. No parent context leaks. Auth works.

---

### Task 15: Context Isolation End-to-End Tests
**Files:** `src/router/__tests__/isolation.test.ts`

Verify full context isolation across the Router pipeline.

**Test scenarios:**

1. **Empty workspace verification:** Create a session under `router-executor`, verify `loadWorkspaceBootstrapFiles()` returns zero content files
2. **Template-only context:** Dispatch a task via the Router, capture the system prompt sent to the LLM — verify it contains ONLY the template content, no SOUL.md/AGENTS.md/USER.md
3. **No tool access:** Dispatch a task that attempts to use exec/web/browser tools — verify they are not available
4. **No memory search:** Dispatch a task, verify no embedding search queries are made
5. **No sub-agent spawning:** Dispatch a task that tries to spawn a sub-agent — verify it is blocked (maxConcurrent: 0)
6. **Auth works:** Dispatch a real task (e.g., "what is 2+2") to each tier, verify the executor can authenticate and return a result
7. **Cross-tier isolation:** Dispatch tasks to Haiku, Sonnet, and Opus — verify each receives only its tier-specific template, no cross-contamination
8. **Result delivery:** Dispatch a task, verify the result is delivered back to the issuer's session (not the executor's session)
9. **Error delivery:** Dispatch a task that will fail, verify the error is delivered back to the issuer
10. **Parent context not leaked:** Include sensitive strings in the main agent's SOUL.md, dispatch a task, verify none of those strings appear in the executor's context

**Acceptance:** All 10 tests pass. Context isolation is verified end-to-end.

---

### Task 16: Auth Sync Mechanism
**Files:** `src/router/gateway-integration.ts` or `src/gateway/server-startup.ts`

Implement automatic auth credential sync from main agent to router-executor agent.

**Steps:**

1. On gateway startup (in `initGatewayRouter()`), copy:
   - `~/.openclaw/agents/main/agent/auth-profiles.json` → `~/.openclaw/agents/router-executor/agent/auth-profiles.json`
   - `~/.openclaw/agents/main/agent/auth.json` → `~/.openclaw/agents/router-executor/agent/auth.json` (if exists)

2. Create parent directories if they don't exist (`agents/router-executor/agent/`)

3. Log: `[router] Synced auth profiles to router-executor agent`

4. Handle errors gracefully — if main agent auth doesn't exist, log a warning but don't crash

**Test:**
- Unit test: verify files are copied correctly
- Unit test: verify missing source files don't crash startup
- Integration test: delete executor auth, restart gateway, verify auth is re-synced

**Acceptance:** Auth is always in sync on startup. No manual copying needed.

---

## Config Addition

Add to `openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "router-executor",
        "name": "Router Executor",
        "workspace": "~/.openclaw/workspace-router-executor",
        "tools": { "deny": ["exec", "read", "write", "edit", "web_search", "web_fetch", "browser", "message", "tts", "image", "sessions_spawn", "sessions_send", "canvas", "nodes"] },
        "memorySearch": { "enabled": false },
        "skills": []
      }
    ]
  },
  "router": {
    "enabled": true,
    "evaluator": {
      "model": "anthropic/claude-sonnet-4-6",
      "tier": "sonnet",
      "timeout": 30,
      "fallback_weight": 5
    },
    "tiers": {
      "haiku": {
        "range": [1, 3],
        "model": "anthropic/claude-haiku-4-5"
      },
      "sonnet": {
        "range": [4, 7],
        "model": "anthropic/claude-sonnet-4-5"
      },
      "opus": {
        "range": [8, 10],
        "model": "anthropic/claude-opus-4-6"
      }
    }
  }
}
```

---

## Caller-Provided Task IDs

*Added: 2026-02-28*
*Status: ✅ Done — implemented in `queue.ts`, 2 tests passing*

### Change

`queue.ts:enqueue()` currently generates a UUID internally. This creates a race condition for callers (like Cortex) that need to record the task ID before the Router processes it — if the return path fails after enqueue but before the caller records the ID, the job runs with no caller-side tracking.

**Fix:** `enqueue()` accepts an optional `taskId` parameter. If provided, the job is stored with that ID instead of a generated UUID. If not provided, behavior is unchanged (backwards-compatible).

```ts
// Before:
enqueue(type, payload, issuer) → jobId

// After:
enqueue(type, payload, issuer, taskId?) → jobId
// taskId provided → use it; taskId omitted → generate UUID as before
```

The Router does not care who generated the ID. It receives a task with an ID, executes it, and fires events with that same ID. The issuer is responsible for ID uniqueness.

**Router's contract with issuers:**
- Issuer provides: `{ taskId, message, issuer }`
- Router executes, fires: `{ taskId, issuer, result/error }`
- Router does NOT parse or use any issuer-specific metadata in the payload
- Router does NOT generate IDs for callers that provide their own

This is documented in Cortex implementation tasks (Phase 10, Tasks 36–39) where the Cortex switches to generating its own UUIDs and storing all routing metadata (`reply_channel`, `result_priority`) in its own `cortex_pending_ops` table instead of serializing it into the Router payload.
```
