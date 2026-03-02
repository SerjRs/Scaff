# Router Architecture v2

**Status:** Partially implemented (v0.3 update: Executor Agent isolation)
**Date:** 2026-02-25 (updated 2026-02-26)
**Version:** 0.3

---

## 1. Overview

The Router is a service inside OpenClaw that takes any execution task, weights it by complexity, selects the appropriate AI model tier, wraps the task in a tier-specific prompt template, and dispatches it to an agent. It manages a persistent queue that survives gateway crashes.

---

## 2. Queue Backend

**SQLite-backed persistent queue** stored at `~/.openclaw/router/queue.sqlite`

Why SQLite:
- Survives gateway crashes (WAL mode, fsync)
- No external dependencies (no Redis, no extra service)
- Single-file, easy to back up
- Fast enough for the expected throughput (subagent tasks, not millions of jobs)

### Schema

```sql
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,        -- UUID
  type        TEXT NOT NULL,           -- 'agent_run'
  status      TEXT NOT NULL DEFAULT 'in_queue',
  weight      INTEGER,                -- 1-10, NULL until evaluated
  tier        TEXT,                    -- 'haiku' | 'sonnet' | 'opus', NULL until evaluated
  issuer      TEXT NOT NULL,           -- session key of the caller
  payload     TEXT NOT NULL,           -- JSON: { message, model?, context? }
  result      TEXT,                    -- JSON: response on completion, error on failure
  error       TEXT,                    -- error message if failed
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,                    -- when worker picked it up
  finished_at TEXT,                    -- when completed/failed/canceled
  delivered_at TEXT,                   -- when result was returned to issuer
  retry_count     INTEGER DEFAULT 0,       -- number of attempts so far
  worker_id       TEXT,                    -- identifies which worker is running it
  last_checkpoint TEXT,                    -- timestamp of last worker heartbeat
  checkpoint_data TEXT                     -- JSON: partial progress / intermediate state
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_issuer ON jobs(issuer);

-- Archive table: identical schema, holds all terminal jobs
CREATE TABLE jobs_archive (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  weight      INTEGER,
  tier        TEXT,
  issuer      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  delivered_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  worker_id   TEXT
);

CREATE INDEX idx_archive_issuer ON jobs_archive(issuer);
CREATE INDEX idx_archive_type ON jobs_archive(type);
CREATE INDEX idx_archive_status ON jobs_archive(status);
CREATE INDEX idx_archive_created ON jobs_archive(created_at);
```

### Archive Queries

```sql
-- All jobs for a given issuer
SELECT * FROM jobs_archive WHERE issuer = ? ORDER BY created_at DESC;

-- Failed jobs in the last 24h
SELECT * FROM jobs_archive WHERE status = 'failed' AND created_at > datetime('now', '-1 day');

-- Tier distribution (cost analysis)
SELECT tier, COUNT(*) as count, AVG(julianday(finished_at) - julianday(started_at)) * 86400 as avg_seconds
FROM jobs_archive WHERE status = 'completed' GROUP BY tier;

-- Full history for a specific job
SELECT * FROM jobs_archive WHERE id = ?;
```

### Statuses

| Status | Description |
|--------|-------------|
| `in_queue` | Job submitted, waiting to be picked up |
| `evaluating` | Evaluator is scoring complexity (1-10) |
| `pending` | Weight/tier assigned, waiting for a worker |
| `in_execution` | Worker is actively running the agent |
| `completed` | Finished successfully |
| `failed` | Finished with error |
| `canceled` | Aborted by issuer or system |

**Flow:** `in_queue` → `evaluating` → `pending` → `in_execution` → `completed` | `failed` | `canceled`

---

## 3. Components

### 3.1 Enqueuer

Entry point for task submission. Called by `sessions_spawn` and internal systems.

Two methods:

**`enqueue(type, payload, issuer) → jobId`** (async)
- Inserts a row with status `in_queue`
- Returns the job ID immediately — issuer walks away
- Result delivered later via Notifier push to the issuer's session
- Maps to `sessions_spawn` with `mode="session"`

**`enqueueAndWait(type, payload, issuer, timeout?) → result`** (sync)
- Calls `enqueue()` internally, then holds an open Promise
- Promise resolves when the Notifier emits the completion event for that job ID
- Timeout default: 5 minutes — if exceeded, returns timeout error but the job keeps running in the queue
- Maps to `sessions_spawn` with `mode="run"`

### 3.2 Router Loop

Continuously scans the queue for work. Runs as part of the gateway process (not a separate service).

```
loop:
  1. SELECT next job WHERE status = 'in_queue' ORDER BY created_at ASC LIMIT 1
  2. Update status → 'evaluating'
  3. Call Evaluator → get weight (1-10) and tier
  4. Update status → 'pending', set weight + tier
  5. Call Dispatcher with job
```

On gateway startup: recover any jobs stuck in `evaluating` or `in_execution` (crash recovery).

### 3.3 Evaluator

A lightweight API call (not an agent) that classifies task complexity. Single LLM completion request — no tools, no session, no memory.

The Evaluator is configured via its own config block and uses the same prompt templates as any other task — no special evaluator template.

**Evaluator config:**
```yaml
router:
  evaluator:
    model: anthropic/claude-sonnet-4-6    # model used for scoring
    tier: sonnet                           # which template folder to use
    timeout: 10s                           # max time for scoring call
    fallback_weight: 5                     # default weight if evaluation fails
```

**Flow:**
1. Read evaluator config → model is `claude-sonnet-4-6`, tier is `sonnet`
2. Load template from `templates/sonnet/agent_run.md` (same template any Sonnet task uses)
3. Render template with the task payload
4. Send completion request to `claude-sonnet-4-6`
5. Parse response for complexity score

**Input:** The task message + context from the job payload
**Output:** `{ weight: number, reasoning: string }`

The Evaluator only returns the weight (1-10). Tier and model are resolved later by the Dispatcher from config.

**Tier mapping:**
| Score | Tier | Model |
|-------|------|-------|
| 1-3 | Haiku | claude-haiku-4-5 |
| 4-7 | Sonnet | claude-sonnet-4-5 |
| 8-10 | Opus | claude-opus-4-6 |

**Failure mode:** If the evaluator errors or times out, default to `fallback_weight` (5 → Sonnet tier). Never block the queue on evaluator failure.

### 3.4 Template Engine

Each tier + job type has a dedicated prompt template that wraps the task before sending it to the model.

**Template location:** `src/router/templates/`

```
templates/
  haiku/
    agent_run.md
    memory_cleanup.md
  sonnet/
    agent_run.md
    memory_cleanup.md
  opus/
    agent_run.md
    memory_cleanup.md
  index.ts          -- registry: getTemplate(tier, jobType) → string
```

**Purpose:** Each tier's template is a universal prompt template optimized for that model's capabilities. The same template works for both task execution and evaluation — the template must handle any request sent to that model tier.

- **Haiku templates:** More explicit instructions, structured output format, guardrails
- **Sonnet templates:** Balanced guidance, room for reasoning
- **Opus templates:** Minimal scaffolding, trust the model's judgment

Template variables: `{task}`, `{context}`, `{issuer}`, `{constraints}`

### 3.5 Dispatcher

Takes a `pending` job (which only has a weight), resolves the tier and model from config, applies the template, and hands it to a Worker.

```
dispatch(job):
  1. tier = resolveWeightToTier(job.weight)   -- config lookup: weight 6 → 'sonnet'
  2. model = config.router.tiers[tier].model   -- config lookup: sonnet → claude-sonnet-4-5
  3. template = getTemplate(tier, job.type)     -- load templates/sonnet/agent_run.md
  4. prompt = template.render(job.payload)
  5. Update job: tier → 'sonnet', status → 'in_execution'
  6. worker.run(job.id, prompt, model)
```

**Tier resolution config:**
```yaml
router:
  tiers:
    haiku:
      range: [1, 3]
      model: anthropic/claude-haiku-4-5
    sonnet:
      range: [4, 7]
      model: anthropic/claude-sonnet-4-5
    opus:
      range: [8, 10]
      model: anthropic/claude-opus-4-6
```

The tier and model are only resolved at dispatch time — not during evaluation. This means you can change the model mapping in config without re-evaluating existing jobs.

### 3.6 Worker

Executes the agent task using the gateway's existing `callGateway()`.

```
worker.run(jobId, prompt, model):
  1. Call callGateway() with prompt + model on an isolated executor session
  2. Start heartbeat timer: update last_checkpoint every 30s
  3. On success: update job status → 'completed', store result, emit job:completed
  4. On failure: update job status → 'failed', store error, emit job:failed
```

The Worker creates sessions under the **Executor Agent** (`router-executor`), not the main agent. See §3.8.

**Lifecycle events:** The Worker emits events on a shared `routerEvents` EventEmitter (`worker.ts`). The Router Loop (`loop.ts`) also emits `job:failed` when the evaluator or dispatcher crashes — these are loop-level failures that the worker never sees. This ensures all failure paths are covered:

| Emitter | Event | When |
|---------|-------|------|
| `worker.ts` | `job:completed` | Worker finishes successfully |
| `worker.ts` | `job:failed` | Worker execution throws |
| `loop.ts` | `job:failed` | Evaluator or dispatcher crashes before worker starts |

Cortex's `gateway-bridge.ts` subscribes to `job:failed` to mark pending ops as failed (visible to the LLM for user notification).

### 3.7 Notifier

Returns results to the issuer. Push-based — issuers never poll.

```
on job completed/failed:
  1. Stamp delivered_at on the job
  2. Emit event with job ID + result (resolves any enqueueAndWait() Promise)
  3. Push system message to the issuer's session with the result
     (same mechanism as current subagent completion announcements)
```

**Delivery paths:**
- **Sync issuer (enqueueAndWait):** The held Promise resolves with the result. Issuer gets it inline.
- **Async issuer (enqueue):** System message pushed to the issuer's session. Agent sees it on next turn as: `[System Message] Job abc-123 completed. Result: ...`

**After delivery:** Notifier moves the job row from `jobs` to `jobs_archive` immediately.

**Archival:**
- The Notifier moves the job to `jobs_archive` immediately after delivering the result.
- No data is ever deleted — all timestamps, payloads, results, and errors are preserved in the archive.
- **Future:** Cleanup sweep for edge cases (undelivered jobs, crash between delivery and archive).

### 3.8 Executor Agent (Context Isolation)

**Problem:** When a task is dispatched to a subagent, the executor inherits the parent agent's full context — SOUL.md, AGENTS.md, USER.md, MEMORY.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, workspace files, skills, and tools. This:

- **Wastes tokens** — thousands of tokens of system prompt for a "what is 15*3?" question
- **Leaks context** — the executor sees personal info, memory, conversation patterns
- **Defeats tiered routing** — Haiku should be fast and cheap, not bloated with irrelevant context

**Solution:** A dedicated lightweight agent (`router-executor`) with an empty workspace and no inherited context. The Router's tier template is the executor's **only** instruction set.

#### How OpenClaw resolves agent context

1. Session key format: `agent:<agentId>:<type>:<uuid>`
2. Gateway extracts `agentId` from the session key
3. `resolveAgentWorkspaceDir(cfg, agentId)` → workspace directory for that agent
4. `loadWorkspaceBootstrapFiles(workspaceDir)` → loads AGENTS.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md
5. These files are injected as system context into every agent turn

If the workspace directory is **empty**, no context files are injected. The agent runs with only the user message (the Router's template-rendered prompt).

#### Executor Agent definition

**Config** — add to `openclaw.json` under `agents.list[]`:

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
  }
}
```

**Workspace** — `~/.openclaw/workspace-router-executor/`:
- **Empty directory** — no SOUL.md, no AGENTS.md, no USER.md, no MEMORY.md
- The Router's template is the complete instruction set
- No workspace files means zero token overhead from agent context

**Agent directory** — `~/.openclaw/agents/router-executor/agent/`:
- `auth-profiles.json` — copied from the main agent (shares API credentials)
- No other config files needed

**Session keys:**
- `agent:router-executor:task:<uuid>` — one session per dispatched job
- Gateway resolves `router-executor` → empty workspace → clean execution context

#### Template as complete context

The tier templates become the executor's **entire instruction set**:

```
templates/
  haiku/agent_run.md    → Explicit, structured, step-by-step. "You are a task
                           executor. Answer concisely. No tools. Task: {task}"
  sonnet/agent_run.md   → Balanced guidance, room for reasoning. Task: {task}
  opus/agent_run.md     → Minimal scaffolding, trust the model. Task: {task}
```

The `{task}` variable contains only the specific task from the issuer — no parent conversation history, no memory, no personal context. The template controls exactly what the executor knows.

#### Isolation guarantees

| What | Isolated? | How |
|------|-----------|-----|
| Parent conversation history | ✅ Yes | New session per task |
| Agent personality (SOUL.md) | ✅ Yes | Empty workspace |
| Agent memory (MEMORY.md) | ✅ Yes | Empty workspace |
| User profile (USER.md) | ✅ Yes | Empty workspace |
| Tools & skills | ✅ Yes | Disabled in agent config |
| Memory search (embeddings) | ✅ Yes | Disabled in agent config |
| Sub-agent spawning | ✅ Yes | maxConcurrent: 0 |
| API credentials | Shared | Same auth-profiles.json |

#### Auth sharing

The executor agent reuses the main agent's API credentials. Auth profiles are per-agent-directory (`agents/<id>/agent/auth-profiles.json`). The executor's auth file is a copy of the main agent's — both use the same Anthropic API keys/tokens.

When the main agent's OAuth tokens rotate, the executor's copy must be updated. Options:
- **Symlink** (preferred on Linux/Mac) — always in sync
- **Copy** (Windows) — needs periodic sync or a startup hook
- **Shared auth resolution** (future) — gateway resolves auth from a common pool

---

## 4. Checkpoints & Hang Detection

### Worker Heartbeat
Every **30 seconds**, the worker updates the job row:
```sql
UPDATE jobs SET last_checkpoint = datetime('now'), checkpoint_data = ? WHERE id = ?
```

`checkpoint_data` is JSON containing partial progress:
- Tool calls completed so far
- Intermediate results
- Current step description
- Token usage so far

### Watchdog
A timer in the Router Loop scans `in_execution` jobs every **30 seconds**:

```
for each job WHERE status = 'in_execution':
  if now - last_checkpoint > 90 seconds:
    job is hung → handle as failure
    if retry_count < 2:
      reset to 'pending', increment retry_count (re-dispatch)
    else:
      mark 'failed', error = 'hung: no checkpoint for 90s'
```

### Why this matters
- Detects hung agents without waiting for gateway crash
- Enables resume from last checkpoint (future: feed checkpoint_data back to the new worker as context)
- Gives observability into in-flight jobs (what's the agent doing right now?)

## 5. Crash Recovery

On gateway startup:
1. Jobs in `evaluating` → reset to `in_queue` (re-evaluate)
2. Jobs in `in_execution` → check `last_checkpoint`:
   - If checkpoint exists and retry_count < 2 → reset to `pending` (re-dispatch with same tier)
   - If retry_count >= 2 → mark `failed`
3. Jobs in `pending` → pick up normally
4. Jobs in `completed`/`failed` with no `delivered_at` → re-emit notification

This is why SQLite matters — the queue state persists through crashes.

---

## 5. Concurrency

- **Router Loop:** Single loop, processes one job at a time for evaluation
- **Workers:** Multiple concurrent workers (configurable, default from `agents.defaults.maxConcurrent`)
- **SQLite locking:** WAL mode allows concurrent reads; writes are serialized (fine for this throughput)

---

## 6. Integration Point

**Single intercept: `routerCallGateway()` in `subagent-spawn.ts`**

The Router intercepts `method: "agent"` calls in `subagent-spawn.ts`:

```
Before:  subagent-spawn → callGateway({ method: "agent" }) → agent runs on main agent session
After:   subagent-spawn → routerCallGateway() → evaluate → enqueue → Router pipeline
```

**`routerCallGateway()` flow:**

1. **Intercept** — only `method: "agent"` calls are candidates. Admin calls (`sessions.patch`, `sessions.delete`) pass through directly.
2. **Evaluate** — Ollama scores complexity (+ Sonnet verification if weight > 3)
3. **Enqueue** — job created in SQLite with weight, tier, model, payload
4. **Return immediately** — issuer gets a job acknowledgment, nobody waits for execution
5. **Router Loop picks up** → Dispatcher resolves tier → Worker executes on `agent:router-executor:task:<uuid>` session
6. **Worker completes** → updates SQLite → Notifier delivers result to issuer

**Execution isolation:** The Worker creates sessions under the `router-executor` agent (§3.8), NOT the `main` agent. The executor sees only the template-rendered prompt — no parent context, no memory, no personality files.

**Delivery:** The Notifier pushes the result back to the issuer's session as a system message. For `enqueueAndWait()` callers, the held Promise resolves. For `enqueue()` callers, a system message is pushed.

- `sessions_spawn` with `mode="run"` → `enqueueAndWait()` (holds Promise until completion)
- `sessions_spawn` with `mode="session"` → `enqueue()` (async, result pushed later)



---

## 7. Job Types

| Type | Description | Tier |
|------|-------------|------|
| `agent_run` | Subagent task (from sessions_spawn) | Evaluated per task |

---

## 8. Observability

- All state transitions logged with timestamps in the jobs table
- Gateway can query queue status: pending count, in-flight count, avg completion time
- Failed jobs retain error details for debugging

---

## 9. Design Decisions (Resolved)

1. **Evaluator cost tracking:** Not needed for now — overhead is negligible.
2. **Tier override:** No. The Router always decides the tier. Issuers cannot bypass the evaluator.
3. **Retry policy:** Retry once after 5-second wait (2 attempts total). If both fail, mark as `failed` and let the issuer deal with it.
4. **Priority queues:** No urgent lane. All tasks wait in the queue in FIFO order.
5. **Rate limiting:** Not yet. No max queue depth or per-issuer caps.
6. **Full context isolation:** Executor runs under a dedicated `router-executor` agent with an empty workspace. No SOUL.md, AGENTS.md, USER.md, MEMORY.md, or tools. The Router's tier template is the executor's only instruction set. This prevents token waste and context leakage.
7. **Auth sharing via copy:** On Windows, `auth-profiles.json` is copied (not symlinked) from the main agent to the executor agent. A startup hook syncs changes.
8. **Two-stage evaluator:** Ollama (local, free) scores first. Scores ≤3 → trusted, routed to Haiku. Scores >3 → verified by Sonnet via `callGateway`. Saves API calls for trivial tasks.
9. **Async execution:** The executor fires and nobody waits. `routerCallGateway()` enqueues and returns. The Notifier delivers results when execution completes — even on failure.

---

## 10. File Structure

```
src/router/
  index.ts               -- Router service entry (start/stop)
  queue.ts               -- SQLite queue operations
  loop.ts                -- Main processing loop
  evaluator.ts           -- Two-stage complexity scoring (Ollama + Sonnet)
  dispatcher.ts          -- Template application + worker dispatch
  worker.ts              -- Agent execution wrapper (isolated sessions)
  notifier.ts            -- Result delivery + cleanup
  recovery.ts            -- Crash recovery logic
  types.ts               -- Job types, statuses, interfaces
  gateway-integration.ts -- Gateway ↔ Router bridge (routerCallGateway)
  templates/
    index.ts             -- Template registry
    haiku/
      agent_run.md       -- Explicit, structured, concise instructions
    sonnet/
      agent_run.md       -- Balanced guidance, reasoning room
    opus/
      agent_run.md       -- Minimal scaffolding, trust the model

~/.openclaw/
  agents/
    router-executor/
      agent/
        auth-profiles.json  -- Copied from main agent (shared API keys)
  workspace-router-executor/   -- EMPTY (no context files = full isolation)
  router/
    config.json              -- Router config (if not in openclaw.json)
    queue.sqlite             -- Persistent job queue (WAL mode)
```
