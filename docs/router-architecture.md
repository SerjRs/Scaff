# Router Architecture

The Router is OpenClaw's task delegation engine. It evaluates task complexity, selects the appropriate model tier, and executes work asynchronously. The Cortex delegates to the Router via the `sessions_spawn` tool; the Router evaluates, dispatches, executes, and delivers results back.

## Core Principles

1. **Complexity-based routing.** Every task is scored 1–10 for complexity. The score maps to a model tier (Haiku/Sonnet/Opus), so simple tasks use cheap models and complex tasks get powerful ones.
2. **Fire-and-forget dispatch.** The Cortex doesn't wait for results. It submits work, tracks it as a pending operation, and continues processing other messages.
3. **Self-healing.** Hung jobs are detected by a watchdog, retried up to 2 times, and permanently failed if unrecoverable. Crash recovery on startup handles incomplete state.
4. **Event-driven delivery.** Results are pushed back to the Cortex via `routerEvents`, not polled. The Cortex sees them as `[NEW RESULT]` or `[FAILED]` in its next LLM turn.

## System Overview

```
                    ┌──────────────────────────────────┐
                    │  Cortex (sessions_spawn tool)    │
                    │  Fire-and-forget delegation      │
                    └──────────────┬───────────────────┘
                                   │ enqueue
                    ┌──────────────▼───────────────────┐
                    │  Router Instance (index.ts)      │
                    │  Public API, init, shutdown       │
                    └──────────────┬───────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
    ┌─────────▼──────┐  ┌─────────▼──────┐  ┌──────────▼─────────┐
    │  Queue          │  │  Loop           │  │  Watchdog          │
    │  (queue.ts)     │  │  (loop.ts)      │  │  (loop.ts)         │
    │  SQLite jobs    │  │  1s tick         │  │  30s tick           │
    │  + archive      │  │  Eval → Dispatch │  │  Hung detection    │
    └─────────┬──────┘  └─────────┬──────┘  └──────────┬─────────┘
              │                    │                     │
              │          ┌─────────▼──────┐              │
              │          │  Evaluator      │              │
              │          │  (evaluator.ts) │              │
              │          │  Ollama → Sonnet│              │
              │          └─────────┬──────┘              │
              │                    │                     │
              │          ┌─────────▼──────┐              │
              │          │  Dispatcher     │              │
              │          │  (dispatcher.ts)│              │
              │          │  Tier → Model   │              │
              │          │  → Template     │              │
              │          └─────────┬──────┘              │
              │                    │                     │
              │          ┌─────────▼──────┐              │
              │          │  Worker         │              │
              │          │  (worker.ts)    │              │
              │          │  Execute + HB   │              │
              │          └─────────┬──────┘              │
              │                    │                     │
              │          ┌─────────▼──────┐              │
              │          │  Notifier       │              │
              │          │  (notifier.ts)  │              │
              │          │  Deliver + Arc  │              │
              │          └────────────────┘              │
              └─────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point. Init DB, recovery, notifier, loop. Public API (`enqueue`, `enqueueAndWait`, `stop`, `getStatus`). |
| `loop.ts` | Main polling loop (1s tick) + watchdog (30s tick). Dequeue → evaluate → dispatch. Concurrency gate (max 2). |
| `evaluator.ts` | Two-stage complexity scoring: Ollama local (llama3.2:3b) → optional Sonnet verification. |
| `dispatcher.ts` | Resolve weight → tier → model. Load template. Fire worker (non-blocking). |
| `worker.ts` | Execute single job with heartbeat monitoring (30s). Emit `job:completed` or `job:failed`. |
| `notifier.ts` | Listen for terminal events. Stamp `delivered_at`, emit `job:delivered`, archive job. |
| `queue.ts` | SQLite queue CRUD. Jobs table + archive table. Dequeue is atomic (SELECT + UPDATE). |
| `recovery.ts` | Crash recovery on startup. Reset stuck jobs, re-deliver undelivered terminal jobs. |
| `types.ts` | Type definitions: `RouterJob`, `Tier`, `JobStatus`, `EvaluatorResult`, `RouterConfig`, `TierConfig`. |
| `gateway-integration.ts` | Gateway bridge. Executor factory, auth sync, singleton management, `routerCallGateway`. |
| `templates/index.ts` | Template loading and placeholder rendering. Cached in memory. |
| `templates/{tier}/agent_run.md` | Tier-specific prompt templates (haiku, sonnet, opus). |

## Job Lifecycle

```
   ┌────────────┐
   │  in_queue   │  Job submitted, waiting for loop tick
   └──────┬─────┘
          │ dequeue()
   ┌──────▼─────┐
   │ evaluating  │  Ollama scoring complexity (1–10)
   └──────┬─────┘
          │ evaluate() → weight set
   ┌──────▼─────┐
   │  pending    │  Weight assigned, ready for dispatch
   └──────┬─────┘
          │ dispatch() → tier + model resolved, template rendered
   ┌──────▼──────────┐
   │  in_execution    │  Worker running, heartbeat every 30s
   └──────┬───────┬──┘
          │       │
     success    failure
          │       │
   ┌──────▼──┐ ┌──▼──────┐
   │completed│ │ failed   │
   └──────┬──┘ └──┬──────┘
          │       │
          │  Notifier listens on routerEvents
          │       │
   ┌──────▼───────▼──┐
   │   delivered      │  delivered_at stamped, job:delivered emitted
   └──────┬──────────┘
          │
   ┌──────▼──────────┐
   │   archived       │  Moved from jobs → jobs_archive
   └─────────────────┘
```

## Evaluator

Two-stage complexity scoring (`evaluator.ts`):

### Stage 1: Ollama (Local, Fast)
- Model: `llama3.2:3b` at `http://127.0.0.1:11434/api/generate`
- Scores task complexity 1–10
- If weight ≤ 3 → trust Ollama result, skip Stage 2 (Haiku-tier tasks don't need verification)

### Stage 2: Sonnet Verification (Remote, Accurate)
- Only runs if Ollama scores > 3
- Calls Sonnet via `callGateway` with proper OAuth auth
- Returns refined weight

### Fallback
- If both stages fail, returns `fallback_weight` from config (default: 5 → Sonnet tier)
- Evaluator never throws — always returns an `EvaluatorResult`

### Scoring Guide
| Score | Complexity | Tier |
|-------|-----------|------|
| 1–3 | Trivial — simple lookups, formatting, basic Q&A | Haiku |
| 4–7 | Moderate — analysis, multi-step reasoning, code review | Sonnet |
| 8–10 | Complex — architecture, deep research, creative writing | Opus |

## Dispatcher

Resolves the evaluated weight to a concrete execution plan (`dispatcher.ts`):

1. **Weight → Tier**: Check each tier's `[min, max]` range from config
2. **Tier → Model**: Look up model ID from tier config (e.g., `anthropic/claude-sonnet-4-6`)
3. **Template**: Load `src/router/templates/{tier}/agent_run.md`
4. **Render**: Replace `{task}`, `{context}`, `{issuer}`, `{constraints}` placeholders
5. **Fire**: Call `worker.run()` non-blocking (fire-and-forget)

## Worker

Executes a single job to completion (`worker.ts`):

1. Mark job `started_at`, set initial `last_checkpoint`
2. Start heartbeat timer — update `last_checkpoint` every 30 seconds
3. Call executor with rendered prompt + resolved model
4. On success: clear heartbeat, mark `completed`, emit `job:completed`
5. On failure: clear heartbeat, mark `failed`, emit `job:failed`

### Heartbeat
The heartbeat is the watchdog's liveness signal. Every 30s the worker updates `last_checkpoint` in the DB. If the watchdog sees a job with a checkpoint older than 90s, it considers the job hung.

## Watchdog

Runs every 30 seconds as part of `loop.ts`:

```
For each job WHERE status = 'in_execution'
                AND last_checkpoint > 90 seconds old:

  IF retry_count < 2:
    Reset status → 'pending'
    Increment retry_count
    (Loop will re-dispatch after 5s delay)

  ELSE:
    Mark status → 'failed'
    Error: "hung: no checkpoint for 90s"
    Emit job:failed
```

## Notifier

Event-driven result delivery (`notifier.ts`):

1. Listens on `routerEvents` for `job:completed` and `job:failed`
2. On event: calls `deliverResult(db, jobId)`
   - Verify job is in terminal status
   - Stamp `delivered_at`
   - Emit `job:delivered` on `routerEvents`
   - Archive job (move from `jobs` → `jobs_archive`)
3. Fire `onDelivered` callback (gateway-bridge uses this to ingest results into Cortex)

Also exposes `waitForJob(db, jobId, timeoutMs)` for synchronous callers (5-minute default timeout).

## Crash Recovery

On startup (`recovery.ts`):

| Stuck State | Action |
|-------------|--------|
| `evaluating` | Reset to `in_queue` (re-evaluate from scratch) |
| `in_execution`, retry_count < 2 | Reset to `pending`, bump retry_count |
| `in_execution`, retry_count >= 2 | Mark `failed` |
| Terminal (completed/failed) with no `delivered_at` | Re-emit via `deliverResult()` |

## Concurrency

- **Max 2 concurrent jobs** (`MAX_CONCURRENT = 2` in `loop.ts`)
- Concurrency gate checks count of `in_execution` jobs before dequeuing
- Retry jobs get priority over new jobs (checked first each tick)
- Retry delay: 5 seconds before re-dispatch

## Router Events

`routerEvents` (`worker.ts`) is a shared EventEmitter:

| Event | Emitter | Payload | Listener |
|-------|---------|---------|----------|
| `job:completed` | `worker.ts` (success) | `{ jobId }` | Notifier |
| `job:failed` | `worker.ts` (error), `loop.ts` (eval/dispatch crash) | `{ jobId, error }` | Notifier, Cortex gateway-bridge |
| `job:delivered` | `notifier.ts` | `{ jobId, job }` | Cortex gateway-bridge |

### Cortex Integration via Events

`gateway-bridge.ts` subscribes to two Router events:

**`job:delivered`** — Successful result delivery:
1. Check `job.issuer === cortexIssuer` (ignore non-Cortex jobs)
2. Parse routing metadata from `payload.context` (replyChannel, resultPriority)
3. Call `completePendingOp(db, jobId, result)` — marks the pending op as completed (unread)
4. Create a result envelope and enqueue it into the Cortex bus
5. On the next LLM turn, Cortex sees `[NEW RESULT]` in the System Floor

**`job:failed`** — Failure notification:
1. Call `failPendingOp(db, jobId, error)` — marks the pending op as failed (unread)
2. Does NOT set `acknowledged_at` — the op stays visible in `getPendingOps()`
3. On the next LLM turn, Cortex sees `[FAILED] ... Inform the user that this task failed.`
4. After the LLM turn, `acknowledgeCompletedOps()` marks it as read — disappears from future turns

## Gateway Integration

`gateway-integration.ts` bridges the Gateway and Router:

### Executor Factory
`createGatewayExecutor()` creates an `AgentExecutor` function:
1. Create isolated session `agent:router-executor:task:{uuid}`
2. Patch session with Router-selected model
3. Execute via `callGateway` (waits for final result)
4. Clean up session after execution

### Auth Sync
`syncExecutorAuth()` copies `auth-profiles.json` and `auth.json` from the main agent to the router-executor agent, ensuring the executor can authenticate with providers.

### Direct Routing (routerCallGateway)
For subagent spawning without the full queue:
1. Evaluate task complexity
2. Resolve weight → tier → model
3. Render tier template
4. Patch session with model
5. Execute via `callGateway`
6. Log decision to SQLite

## Configuration

Router is configured in `openclaw.json`:

```json
{
  "router": {
    "enabled": true,
    "evaluator": {
      "model": "anthropic/claude-sonnet-4-6",
      "tier": "sonnet",
      "timeout": 10,
      "fallback_weight": 5
    },
    "tiers": {
      "haiku": {
        "range": [1, 3],
        "model": "anthropic/claude-haiku-4-5"
      },
      "sonnet": {
        "range": [4, 7],
        "model": "anthropic/claude-sonnet-4-6"
      },
      "opus": {
        "range": [8, 10],
        "model": "anthropic/claude-opus-4-6"
      }
    }
  }
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable Router |
| `evaluator.model` | string | Model for Sonnet verification stage |
| `evaluator.tier` | string | Internal tier label for the evaluator model |
| `evaluator.timeout` | number | Evaluation timeout in seconds |
| `evaluator.fallback_weight` | number | Default weight if evaluation fails (1–10) |
| `tiers.{name}.range` | [min, max] | Weight range that maps to this tier |
| `tiers.{name}.model` | string | Anthropic model ID for this tier |

## SQLite Schema

### Jobs (`router/queue.sqlite` → `jobs`)
```sql
id              TEXT PRIMARY KEY,
type            TEXT NOT NULL,          -- 'agent_run'
status          TEXT NOT NULL,          -- in_queue/evaluating/pending/in_execution/completed/failed/canceled
weight          INTEGER,               -- complexity score 1–10
tier            TEXT,                   -- haiku/sonnet/opus
issuer          TEXT NOT NULL,          -- session key of requester
payload         TEXT NOT NULL,          -- JSON: { message, context? }
result          TEXT,                   -- execution result
error           TEXT,                   -- error message on failure
retry_count     INTEGER DEFAULT 0,     -- 0, 1, or 2
worker_id       TEXT,                   -- worker instance ID
last_checkpoint TEXT,                   -- heartbeat timestamp
started_at      TEXT,
finished_at     TEXT,
delivered_at    TEXT,
created_at      TEXT NOT NULL,
updated_at      TEXT NOT NULL
```

### Archive (`jobs_archive`)
Same schema as `jobs` plus:
```sql
archived_at     TEXT NOT NULL
```

## Constants

| Constant | Value | Location |
|----------|-------|----------|
| `LOOP_INTERVAL_MS` | 1,000 ms | loop.ts |
| `WATCHDOG_INTERVAL_MS` | 30,000 ms | loop.ts |
| `HUNG_THRESHOLD_SECONDS` | 90 s | loop.ts |
| `MAX_RETRIES` | 2 | loop.ts, recovery.ts |
| `RETRY_DELAY_MS` | 5,000 ms | loop.ts |
| `MAX_CONCURRENT` | 2 | loop.ts |
| `HEARTBEAT_INTERVAL_MS` | 30,000 ms | worker.ts |
| `DEFAULT_TIMEOUT_MS` | 300,000 ms (5 min) | notifier.ts |
