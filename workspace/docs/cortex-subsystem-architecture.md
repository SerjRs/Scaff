# Cortex Subsystem Architecture — From Monolith to Supervisor

> **Status:** Draft v1.0  
> **Author:** Scaff + Serj  
> **Date:** 2026-03-11  
> **Related:** Executor Architecture v2, Library Architecture, SAGE Papers 2–4  
> **Depends on:** Router (existing), Cortex Loop (existing), Hippocampus (existing)

---

## 1. Problem Statement

Cortex is a monolith. Every action flows through the LLM:

```
User message → LLM → tool call → Router → executor → result → LLM → user response
```

The LLM is in the critical path for everything — task dispatch, result processing, delivery. This creates three fundamental constraints:

1. **No programmatic task spawning.** `sessions_spawn` is an LLM tool, not an API. Code cannot spawn tasks — only the LLM can, by emitting a tool call. A subsystem like the Night Scholar cannot independently dispatch work.

2. **No result routing.** Task completion always wakes the Cortex LLM via ops-trigger. There is no mechanism to route results to different consumers. Every task completion costs a full LLM invocation even when the result doesn't need LLM involvement.

3. **No subsystem autonomy.** Any periodic or autonomous behavior (fact extraction, knowledge curation, health monitoring) must either run inline (like the Gardener's `setInterval`) or go through the LLM. There is no middle ground — no way for a subsystem to have its own lifecycle, spawn its own tasks, process its own results, while remaining visible to Cortex for diagnosis.

As Cortex stabilizes, the natural evolution is to add narrow-purpose subsystems: the Night Scholar (nightly knowledge evaluation), the Librarian (link ingestion), health monitors, auto-maintenance workers. Each has its own goals, its own schedule, its own logic. They don't need the LLM for every action — but Cortex should know about them, observe them, and diagnose them when asked.

### What we want

```
Cortex (supervisor — observes, diagnoses, intervenes)
  ├── Night Scholar     (nightly cron, spawns evaluations, writes learning notes)
  ├── Librarian         (on-demand, reads URLs, categorizes, stores in Library)
  ├── Gardener          (periodic, extracts facts, compacts, evicts — already exists)
  ├── Health Monitor    (periodic, checks gateway, adapters, queue health)
  └── [future subsystems]

Each subsystem:
  - Has its own lifecycle (start, stop, health)
  - Can spawn tasks through the Router independently
  - Receives its own results without waking the LLM
  - Is visible to Cortex for observation and diagnosis
  - Can be started/stopped/restarted by Cortex or the user
```

This is the shift from **Cortex as monolith** to **Cortex as supervisor**. The Erlang OTP supervisor pattern — applied not at the process level (that's the Executor Architecture v2), but at the subsystem level.

---

## 2. Design Principles

1. **The LLM is a participant, not the bus.** The LLM handles conversation, reasoning, and user interaction. It does not handle task routing, result delivery, or subsystem coordination. Those are infrastructure concerns.

2. **Subsystems are autonomous but supervised.** Each subsystem runs its own logic, spawns its own tasks, processes its own results. Cortex (the LLM) can observe and diagnose, but is not in the critical path.

3. **The Router is the shared execution layer.** All subsystems spawn work through the same Router. The Router doesn't care who the issuer is — it executes tasks and emits events. Result routing is a layer above the Router.

4. **Visibility without coupling.** Cortex can see every subsystem's status, recent tasks, errors, and metrics. But it doesn't need to process every event. Observation is pull-based (diagnostic tools), not push-based (ops-triggers for everything).

5. **Graceful degradation.** If a subsystem crashes or stalls, Cortex and other subsystems continue operating. The supervisor detects the failure and can alert the user or attempt recovery.

6. **Progressive adoption.** Existing components (Gardener, LLM task dispatch) continue working. Subsystems are additive — they don't require rewriting the existing loop. The monolith path remains available for tasks that genuinely need LLM involvement.

---

## 3. Architecture Overview

### 3.1 Current Architecture (Monolith)

```
┌────────────────────────────────────────────────────┐
│                    CORTEX LOOP                      │
│                                                     │
│  User msg → Bus → Loop → LLM → tool calls          │
│                           │                         │
│                    ┌──────┴──────┐                  │
│                    │sessions_spawn│                  │
│                    └──────┬──────┘                  │
│                           │                         │
│                    ┌──────▼──────┐                  │
│                    │   ROUTER    │                  │
│                    │  (execute)  │                  │
│                    └──────┬──────┘                  │
│                           │                         │
│                    job:delivered                     │
│                           │                         │
│                    ┌──────▼──────┐                  │
│                    │ gateway-    │                  │
│                    │ bridge.ts   │                  │
│                    └──────┬──────┘                  │
│                           │                         │
│                    ops-trigger                       │
│                           │                         │
│                    ┌──────▼──────┐                  │
│                    │    LLM      │ ← EVERY result  │
│                    │ (summarize) │   goes through   │
│                    └──────┬──────┘   the LLM        │
│                           │                         │
│                    response to user                  │
└────────────────────────────────────────────────────┘
```

**Problem:** The LLM is called twice per task (dispatch + result). No way for code to dispatch tasks. No routing.

### 3.2 Target Architecture (Supervisor)

```
┌─────────────────────────────────────────────────────────────────┐
│                     CORTEX SUPERVISOR                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 SUBSYSTEM REGISTRY                       │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │   │
│  │  │ LLM      │ │ Night    │ │ Librarian│ │ Gardener  │  │   │
│  │  │ (conv.)  │ │ Scholar  │ │          │ │           │  │   │
│  │  │ issuer:  │ │ issuer:  │ │ issuer:  │ │ (inline)  │  │   │
│  │  │ cortex:  │ │ cortex:  │ │ cortex:  │ │           │  │   │
│  │  │ main     │ │ scholar  │ │ library  │ │           │  │   │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────┘  │   │
│  └───────┼─────────────┼───────────┼───────────────────────┘   │
│          │             │           │                             │
│          ▼             ▼           ▼                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    TASK SPAWNER API                       │   │
│  │           router.enqueue(type, payload, issuer)          │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      ROUTER                              │   │
│  │              (execute → job:completed)                    │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                    job:delivered                                 │
│                           │                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   RESULT ROUTER                          │   │
│  │          Route by issuer → correct consumer              │   │
│  │                                                          │   │
│  │  issuer = cortex:main    → ops-trigger → LLM             │   │
│  │  issuer = cortex:scholar → Night Scholar callback        │   │
│  │  issuer = cortex:library → Librarian callback            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 DIAGNOSTIC LAYER                          │   │
│  │         LLM tool: get_subsystem_status                   │   │
│  │         Registry queries, health checks, task history    │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Key change:** The Result Router replaces the hardcoded `if (job.issuer !== cortexIssuer) return` in gateway-bridge. Each subsystem registers its own result handler. The LLM is only called when a human-facing response is needed.

---

## 4. Core Components

### 4.1 Subsystem Abstraction

A **subsystem** is a self-contained unit of autonomous behavior within Cortex. It has:

- **Identity** — unique issuer ID (e.g., `cortex:scholar`, `cortex:library`)
- **Lifecycle** — start, stop, health check, restart
- **Trigger** — what causes it to run (cron, event, on-demand via LLM)
- **Task spawning** — can enqueue jobs in the Router under its own issuer
- **Result handling** — callback that receives its own task results
- **State** — persistent state in its own DB table or file
- **Metrics** — task count, success rate, last run, errors

```typescript
interface Subsystem {
  /** Unique identifier — used as Router issuer */
  id: string;

  /** Human-readable name */
  name: string;

  /** Current status */
  status: 'starting' | 'running' | 'stopped' | 'error';

  /** Description of what this subsystem does */
  description: string;

  /** Start the subsystem — register triggers, callbacks */
  start(ctx: SubsystemContext): Promise<void>;

  /** Stop the subsystem — clean up timers, listeners */
  stop(): Promise<void>;

  /** Health check — returns OK or error details */
  health(): SubsystemHealth;

  /** Handle a completed task result (called by Result Router) */
  onTaskResult?(jobId: string, job: RouterJob): Promise<void>;

  /** Optional: handle a message from the LLM (for LLM-initiated actions) */
  onLLMRequest?(action: string, params: Record<string, unknown>): Promise<string>;
}

interface SubsystemContext {
  /** Spawn a task in the Router under this subsystem's issuer */
  spawnTask(task: string, options?: SpawnOptions): Promise<string>;

  /** Access the shared Cortex database */
  db: DatabaseSync;

  /** Logger scoped to this subsystem */
  log: Logger;

  /** Read Cortex state (goals, active issues, recent memory) */
  getGoals(): Promise<string[]>;
  getActiveIssues(): Promise<string>;

  /** Write to a subsystem-specific state store */
  setState(key: string, value: unknown): void;
  getState(key: string): unknown;
}

interface SubsystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastRun?: string;         // ISO timestamp
  lastError?: string;
  taskCount: number;        // total tasks spawned
  successRate: number;      // 0.0-1.0
  uptime: number;           // milliseconds since start
  details?: string;         // free-form diagnostic info
}

interface SpawnOptions {
  priority?: 'urgent' | 'normal' | 'background';
  model?: string;
  resources?: ResolvedResource[];
  timeout?: number;          // ms
}
```

### 4.2 Task Spawner API

Currently, task spawning is buried inside the Cortex loop's async tool call handler. The Task Spawner API extracts this into a reusable function that any subsystem can call.

```typescript
/**
 * Spawn a task in the Router.
 *
 * This is the programmatic equivalent of the LLM's sessions_spawn tool call.
 * Any subsystem can call this with its own issuer ID.
 *
 * @param router   - Router instance
 * @param issuer   - Subsystem issuer ID (e.g., "cortex:scholar")
 * @param task     - Task description / prompt for the executor
 * @param options  - Priority, model, resources, timeout
 * @returns taskId - UUID for tracking
 */
function spawnTask(
  router: Router,
  issuer: string,
  task: string,
  options?: SpawnOptions,
): string {
  const taskId = crypto.randomUUID();

  const payload: Record<string, unknown> = {
    message: task,
    context: JSON.stringify({
      source: issuer,
      priority: options?.priority ?? 'normal',
    }),
  };

  if (options?.resources?.length) {
    payload.resources = options.resources;
  }

  router.enqueue('agent_run', payload, issuer, taskId);

  return taskId;
}
```

This is essentially what `onSpawn` in `gateway-bridge.ts:184` does today — but extracted, parameterized by issuer, and callable from anywhere.

### 4.3 Result Router

The Result Router replaces the hardcoded `job:delivered` listener in `gateway-bridge.ts`. Instead of checking `if (job.issuer !== cortexIssuer) return`, it routes results to the correct consumer based on the issuer prefix.

```typescript
/**
 * Result Router — routes job:delivered events to the correct consumer.
 *
 * Replaces the monolithic gateway-bridge listener.
 * Each subsystem registers its handler. The LLM path (ops-trigger)
 * becomes just one of many handlers.
 */
class ResultRouter {
  private handlers = new Map<string, ResultHandler>();
  private fallbackHandler?: ResultHandler;

  /**
   * Register a handler for a specific issuer.
   * When a job with this issuer completes, the handler is called.
   */
  register(issuer: string, handler: ResultHandler): void {
    this.handlers.set(issuer, handler);
  }

  /**
   * Set a fallback handler for unregistered issuers.
   * Used for the LLM path (cortex:main) to maintain backward compatibility.
   */
  setFallback(handler: ResultHandler): void {
    this.fallbackHandler = handler;
  }

  /**
   * Route a delivered job to its handler.
   * Called from the job:delivered event listener.
   */
  route(jobId: string, job: RouterJob): void {
    const handler = this.handlers.get(job.issuer) ?? this.fallbackHandler;
    if (!handler) {
      log.warn(`[result-router] No handler for issuer ${job.issuer}, job ${jobId} dropped`);
      return;
    }

    try {
      handler(jobId, job);
    } catch (err) {
      log.warn(`[result-router] Handler error for ${job.issuer}: ${err}`);
    }
  }
}

type ResultHandler = (jobId: string, job: RouterJob) => void | Promise<void>;
```

**Registration at startup:**

```typescript
const resultRouter = new ResultRouter();

// LLM path — existing behavior (ops-trigger → LLM → user)
resultRouter.register(cortexIssuer, (jobId, job) => {
  appendTaskResult(db, { ... });
  instance.enqueue(opsTrigger);
});

// Night Scholar — direct callback, no LLM involvement
resultRouter.register('cortex:scholar', (jobId, job) => {
  nightScholar.onTaskResult(jobId, job);
});

// Librarian — direct callback, no LLM involvement
resultRouter.register('cortex:library', (jobId, job) => {
  librarian.onTaskResult(jobId, job);
});

// Wire into Router events
routerEvents.on('job:delivered', ({ jobId, job }) => {
  resultRouter.route(jobId, job);
});
```

**The LLM path is now just one handler** — not the only path. Subsystems that don't need LLM involvement get their results directly.

### 4.4 Subsystem Registry

The registry tracks all registered subsystems, their status, and provides the diagnostic interface that the LLM can query.

```typescript
class SubsystemRegistry {
  private subsystems = new Map<string, RegisteredSubsystem>();

  /** Register a subsystem */
  register(subsystem: Subsystem): void {
    this.subsystems.set(subsystem.id, {
      subsystem,
      registeredAt: new Date().toISOString(),
      taskHistory: [],
    });
  }

  /** Start all registered subsystems */
  async startAll(ctx: SubsystemContext): Promise<void> {
    for (const [id, entry] of this.subsystems) {
      try {
        await entry.subsystem.start(ctx);
        log.info(`[registry] Subsystem ${id} started`);
      } catch (err) {
        log.warn(`[registry] Subsystem ${id} failed to start: ${err}`);
        entry.subsystem.status = 'error';
      }
    }
  }

  /** Stop all registered subsystems */
  async stopAll(): Promise<void> {
    for (const [id, entry] of this.subsystems) {
      try {
        await entry.subsystem.stop();
        log.info(`[registry] Subsystem ${id} stopped`);
      } catch (err) {
        log.warn(`[registry] Subsystem ${id} failed to stop: ${err}`);
      }
    }
  }

  /** Get health of all subsystems (for LLM diagnostic tool) */
  getHealthReport(): SubsystemHealthReport[] {
    return Array.from(this.subsystems.entries()).map(([id, entry]) => ({
      id,
      name: entry.subsystem.name,
      status: entry.subsystem.status,
      health: entry.subsystem.health(),
      registeredAt: entry.registeredAt,
    }));
  }

  /** Get detailed status for a specific subsystem */
  getSubsystemDetail(id: string): SubsystemDetail | null {
    const entry = this.subsystems.get(id);
    if (!entry) return null;

    return {
      id,
      name: entry.subsystem.name,
      description: entry.subsystem.description,
      status: entry.subsystem.status,
      health: entry.subsystem.health(),
      recentTasks: entry.taskHistory.slice(-10),
      registeredAt: entry.registeredAt,
    };
  }

  /** Record a task spawn for a subsystem (for tracking) */
  recordTask(issuerId: string, taskId: string, description: string): void {
    const entry = this.subsystems.get(issuerId);
    if (!entry) return;
    entry.taskHistory.push({
      taskId,
      description: description.slice(0, 200),
      spawnedAt: new Date().toISOString(),
      status: 'pending',
    });
    // Keep only last 50 tasks in memory
    if (entry.taskHistory.length > 50) {
      entry.taskHistory = entry.taskHistory.slice(-50);
    }
  }

  /** Update task status in a subsystem's history */
  updateTask(issuerId: string, taskId: string, status: string, result?: string): void {
    const entry = this.subsystems.get(issuerId);
    if (!entry) return;
    const task = entry.taskHistory.find(t => t.taskId === taskId);
    if (task) {
      task.status = status;
      task.completedAt = new Date().toISOString();
      if (result) task.result = result.slice(0, 200);
    }
  }
}

interface RegisteredSubsystem {
  subsystem: Subsystem;
  registeredAt: string;
  taskHistory: TaskRecord[];
}

interface TaskRecord {
  taskId: string;
  description: string;
  spawnedAt: string;
  completedAt?: string;
  status: string;
  result?: string;
}
```

### 4.5 Diagnostic Layer (LLM Tools)

The LLM gets a new tool to observe subsystems. This is read-only — Cortex can look but doesn't need to act unless the user asks.

```typescript
const GET_SUBSYSTEM_STATUS_TOOL = {
  name: "get_subsystem_status",
  description: `Check the health and status of Cortex subsystems. Returns status, health metrics, \
and recent task history for all subsystems or a specific one. Use when diagnosing issues, \
checking on autonomous processes, or when the user asks about system health.`,
  parameters: {
    type: "object",
    properties: {
      subsystemId: {
        type: "string",
        description: "Optional: specific subsystem ID (e.g., 'cortex:scholar'). Omit for all.",
      },
      includeTaskHistory: {
        type: "boolean",
        description: "Include recent task history (last 10 tasks). Default: false.",
      },
    },
    required: [],
  },
};
```

**Example LLM interaction:**

```
User: "How's the Night Scholar doing?"

LLM calls get_subsystem_status({ subsystemId: "cortex:scholar", includeTaskHistory: true })

Result: {
  "id": "cortex:scholar",
  "name": "Night Scholar",
  "status": "running",
  "health": {
    "status": "healthy",
    "lastRun": "2026-03-11T01:30:00Z",
    "taskCount": 47,
    "successRate": 0.96,
    "uptime": 86400000,
    "details": "Last run evaluated 12 items, produced 4 learning notes, 1 diversity alert"
  },
  "recentTasks": [
    { "taskId": "abc123", "description": "Evaluate library item: Erlang Supervisor...", "status": "completed", ... },
    { "taskId": "def456", "description": "Evaluate library item: RAG Patterns...", "status": "completed", ... }
  ]
}

LLM: "Night Scholar is healthy. Last ran at 3:30 AM, evaluated 12 library items, produced 
      4 learning notes. 96% success rate across 47 total tasks. There was 1 diversity alert — 
      probably a category imbalance. Want me to dig into that?"
```

### 4.6 LLM-to-Subsystem Communication

Sometimes the LLM needs to trigger a subsystem action — not spawn a task, but tell a subsystem to do something. For example, when the user drops a link and says "add to library," the LLM needs to tell the Librarian subsystem to process it.

This is handled via the `onLLMRequest` method on the subsystem interface:

```typescript
const SUBSYSTEM_ACTION_TOOL = {
  name: "subsystem_action",
  description: `Send a command to a Cortex subsystem. Use when the user explicitly requests \
something that a subsystem handles. For example: "add this to the library" → subsystem_action \
with subsystemId="cortex:library", action="ingest", params={url: "..."}.`,
  parameters: {
    type: "object",
    properties: {
      subsystemId: {
        type: "string",
        description: "Target subsystem ID",
      },
      action: {
        type: "string",
        description: "Action name (subsystem-specific)",
      },
      params: {
        type: "object",
        description: "Action parameters (subsystem-specific)",
      },
    },
    required: ["subsystemId", "action"],
  },
};
```

**Flow:**

```
User: "Read this: https://example.com/article"
LLM calls subsystem_action({ subsystemId: "cortex:library", action: "ingest", params: { url: "..." } })
  → Registry finds Librarian subsystem
  → Calls librarian.onLLMRequest("ingest", { url: "..." })
  → Librarian spawns a task via ctx.spawnTask(...)
  → Returns: "Ingesting. Will process in background."
LLM: "Got it, sending to the Library. I'll have it catalogued shortly."
```

The LLM triggers the action, but the Librarian handles execution independently. The LLM doesn't wait for the result — the Librarian's `onTaskResult` callback will handle it when the executor finishes.

---

## 5. Subsystem Lifecycle

### 5.1 Registration

Subsystems are registered at gateway startup, before the Cortex loop starts:

```typescript
// In gateway startup (after Router, before Cortex loop)
const registry = new SubsystemRegistry();
const resultRouter = new ResultRouter();

// Register built-in subsystems
registry.register(nightScholar);
registry.register(librarian);
registry.register(gardenerSubsystem);  // Gardener wrapped as subsystem

// Register result handlers
resultRouter.register(cortexIssuer, llmResultHandler);
resultRouter.register('cortex:scholar', (jobId, job) => {
  registry.updateTask('cortex:scholar', jobId, job.status, job.result);
  nightScholar.onTaskResult(jobId, job);
});
resultRouter.register('cortex:library', (jobId, job) => {
  registry.updateTask('cortex:library', jobId, job.status, job.result);
  librarian.onTaskResult(jobId, job);
});

// Wire Router events to Result Router
routerEvents.on('job:delivered', ({ jobId, job }) => {
  resultRouter.route(jobId, job);
});

// Start all subsystems
await registry.startAll(subsystemContext);
```

### 5.2 Health Monitoring

The registry runs a periodic health check (every 5 minutes) across all subsystems:

```typescript
setInterval(() => {
  for (const [id, entry] of registry.subsystems) {
    const health = entry.subsystem.health();

    if (health.status === 'unhealthy') {
      log.warn(`[registry] Subsystem ${id} unhealthy: ${health.details}`);

      // Auto-restart with backoff
      if (entry.restartCount < MAX_RESTARTS) {
        entry.subsystem.stop().then(() => entry.subsystem.start(ctx));
        entry.restartCount++;
      } else {
        log.error(`[registry] Subsystem ${id} exceeded restart limit, marking dead`);
        entry.subsystem.status = 'error';
        // Alert will surface in LLM's next health check or heartbeat
      }
    }
  }
}, HEALTH_CHECK_INTERVAL_MS);
```

### 5.3 Graceful Shutdown

On gateway stop/restart:

```typescript
async function shutdown() {
  // 1. Stop accepting new messages
  cortexLoop.stop();

  // 2. Stop all subsystems (they'll finish current work)
  await registry.stopAll();

  // 3. Stop Router (drain executing jobs)
  await router.drain();

  // 4. Close databases
  db.close();
}
```

---

## 6. Concrete Subsystems

### 6.1 Night Scholar (Subsystem)

```typescript
const nightScholar: Subsystem = {
  id: 'cortex:scholar',
  name: 'Night Scholar',
  status: 'stopped',
  description: 'Nightly evaluation of Library items against current goals. Produces learning notes.',

  async start(ctx) {
    this.status = 'running';
    this.ctx = ctx;

    // Schedule via cron or internal timer
    // Night Scholar runs at 3:30 AM (after code index at 3:00 AM)
    this.cronCleanup = scheduleDaily('03:30', () => this.runEvaluation());
  },

  async stop() {
    this.status = 'stopped';
    if (this.cronCleanup) this.cronCleanup();
  },

  health() {
    return {
      status: this.lastError ? 'degraded' : 'healthy',
      lastRun: this.lastRunAt,
      lastError: this.lastError,
      taskCount: this.totalTasks,
      successRate: this.totalTasks > 0 ? this.successfulTasks / this.totalTasks : 1.0,
      uptime: Date.now() - this.startedAt,
      details: `Last run: ${this.lastItemsEvaluated} items evaluated, ${this.lastNotesProduced} notes produced`,
    };
  },

  async runEvaluation() {
    // 1. Read current goals
    const goals = await this.ctx.getActiveIssues();

    // 2. Query Library for items needing evaluation
    const items = this.getItemsForEvaluation();

    // 3. For each item, spawn an evaluation task
    for (const item of items) {
      const taskId = await this.ctx.spawnTask(
        `Evaluate this library item against current goals:\n\nItem: ${item.title}\nSummary: ${item.summary}\n\nGoals:\n${goals}\n\nScore relevance 0.0-1.0 and produce a learning note if relevant.`,
        { priority: 'background', model: 'anthropic/claude-sonnet-4-20250514' }
      );
      this.pendingEvaluations.set(taskId, item.id);
    }
  },

  async onTaskResult(jobId, job) {
    const itemId = this.pendingEvaluations.get(jobId);
    if (!itemId) return;
    this.pendingEvaluations.delete(jobId);

    if (job.status === 'completed') {
      // Parse evaluation result, update Library DB
      const evaluation = parseEvaluation(job.result);
      updateItemRelevance(this.ctx.db, itemId, evaluation.relevanceScore);
      if (evaluation.learningNote) {
        insertLearningNote(this.ctx.db, itemId, evaluation.learningNote);
      }
      this.successfulTasks++;
    } else {
      this.lastError = job.error;
    }
    this.totalTasks++;
  },
};
```

**Key difference from current architecture:** The Night Scholar spawns tasks and processes results WITHOUT the LLM being involved. No ops-trigger, no LLM call, no token cost for the evaluation pipeline. The LLM only gets involved when the user asks about the Night Scholar's health or when the next morning's brief is assembled.

### 6.2 Librarian (Subsystem)

```typescript
const librarian: Subsystem = {
  id: 'cortex:library',
  name: 'Librarian',
  status: 'stopped',
  description: 'Processes URLs into structured knowledge entries in the Library.',

  async start(ctx) {
    this.status = 'running';
    this.ctx = ctx;
  },

  async stop() {
    this.status = 'stopped';
  },

  health() {
    return {
      status: 'healthy',
      lastRun: this.lastIngestAt,
      taskCount: this.totalIngested,
      successRate: this.totalIngested > 0 ? this.successfulIngests / this.totalIngested : 1.0,
      uptime: Date.now() - this.startedAt,
    };
  },

  // Called when LLM triggers: subsystem_action("cortex:library", "ingest", { url })
  async onLLMRequest(action, params) {
    if (action === 'ingest') {
      const url = params.url as string;
      if (!url) return 'No URL provided.';

      const taskId = await this.ctx.spawnTask(
        `Read and catalog this URL for the Library:\n${url}\n\n` +
        `Extract: title, 200-500 word summary, 3-7 key concepts, category ` +
        `(architecture|tooling|skills|research|patterns|openclaw|operations|security), ` +
        `3-10 tags (kebab-case), content type, source quality.\n` +
        `Return as JSON.`,
        { priority: 'normal' }
      );

      this.pendingIngests.set(taskId, url);
      return `Ingesting ${url}. Task ID: ${taskId}`;
    }

    if (action === 'search') {
      const query = params.query as string;
      return this.searchLibrary(query);
    }

    return `Unknown action: ${action}`;
  },

  async onTaskResult(jobId, job) {
    const url = this.pendingIngests.get(jobId);
    if (!url) return;
    this.pendingIngests.delete(jobId);

    if (job.status === 'completed') {
      // Parse executor result, store in Library DB
      const entry = parseLibraryEntry(job.result);
      insertLibraryItem(this.ctx.db, url, entry);

      // Generate embedding for novelty checking
      const embedding = await embedViaOllama(entry.summary);
      insertItemEmbedding(this.ctx.db, entry.id, embedding);

      // Notify Cortex (optional — light notification, not ops-trigger)
      this.ctx.log.info(`[librarian] Stored: "${entry.title}" — ${entry.category}`);
      this.successfulIngests++;
    } else {
      this.ctx.log.warn(`[librarian] Ingest failed for ${url}: ${job.error}`);
    }
    this.totalIngested++;
  },
};
```

### 6.3 Gardener (Migration)

The Gardener already runs as `setInterval` in the Cortex process. Wrapping it as a subsystem is a thin adapter — same logic, but now visible to the registry for health monitoring and diagnostics.

```typescript
const gardenerSubsystem: Subsystem = {
  id: 'cortex:gardener',
  name: 'Gardener',
  status: 'stopped',
  description: 'Hippocampus maintenance: fact extraction, compaction, eviction.',

  async start(ctx) {
    this.status = 'running';
    // Gardener doesn't spawn Router tasks — it runs inline
    // Just wrap the existing setInterval logic
    this.intervals = startGardenerWorkers(ctx.db);
  },

  async stop() {
    this.status = 'stopped';
    this.intervals.forEach(clearInterval);
  },

  health() {
    const stats = getGardenerStats(this.db);
    return {
      status: stats.lastError ? 'degraded' : 'healthy',
      lastRun: stats.lastRunAt,
      lastError: stats.lastError,
      taskCount: stats.totalExtractions,
      successRate: stats.successRate,
      uptime: Date.now() - this.startedAt,
      details: `Hot facts: ${stats.hotFactCount}, Extractions today: ${stats.extractionsToday}`,
    };
  },

  // Gardener doesn't use Router tasks — no onTaskResult needed
};
```

### 6.4 Future Subsystems

| Subsystem | Trigger | Tasks | Uses Router? |
|-----------|---------|-------|--------------|
| Health Monitor | Every 5 min | Check gateway, adapters, queue, disk | No (inline) |
| Auto-Committer | Every 6 hours | Git add + commit workspace changes | No (inline) |
| Inbox Watcher | Cron | Check email, summarize unread | Yes (Sonnet executor) |
| Skill Updater | Weekly | Check ClawHub for updates, install | Yes (executor) |
| Memory Curator | Weekly | Review daily logs, update MEMORY.md | Yes (Sonnet executor) |

---

## 7. Database Changes

### 7.1 Subsystem State Table

A lightweight table in `cortex/bus.sqlite` for persisting subsystem state across restarts:

```sql
CREATE TABLE cortex_subsystems (
  id            TEXT PRIMARY KEY,              -- e.g. 'cortex:scholar'
  name          TEXT NOT NULL,
  status        TEXT DEFAULT 'stopped',        -- running|stopped|error
  config        TEXT,                          -- JSON config
  state         TEXT,                          -- JSON persistent state
  last_run_at   TEXT,
  last_error    TEXT,
  task_count    INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Task history for diagnostics (last 100 per subsystem)
CREATE TABLE cortex_subsystem_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subsystem_id  TEXT NOT NULL REFERENCES cortex_subsystems(id),
  task_id       TEXT NOT NULL,                -- Router job ID
  description   TEXT,
  status        TEXT DEFAULT 'pending',       -- pending|completed|failed
  result        TEXT,                         -- truncated result
  spawned_at    TEXT NOT NULL,
  completed_at  TEXT,
  FOREIGN KEY (subsystem_id) REFERENCES cortex_subsystems(id) ON DELETE CASCADE
);

CREATE INDEX idx_subsystem_tasks_sub ON cortex_subsystem_tasks(subsystem_id);
CREATE INDEX idx_subsystem_tasks_spawned ON cortex_subsystem_tasks(spawned_at);

-- Auto-trim: keep last 100 per subsystem
CREATE TRIGGER trim_subsystem_tasks AFTER INSERT ON cortex_subsystem_tasks
BEGIN
  DELETE FROM cortex_subsystem_tasks
  WHERE subsystem_id = NEW.subsystem_id
    AND id NOT IN (
      SELECT id FROM cortex_subsystem_tasks
      WHERE subsystem_id = NEW.subsystem_id
      ORDER BY id DESC
      LIMIT 100
    );
END;
```

### 7.2 Router Queue — Issuer Awareness

The existing `jobs` table already has an `issuer` column. No schema change needed. The only change is in result routing — `gateway-bridge.ts` uses the issuer to route instead of filtering for a single value.

---

## 8. Migration Path

### 8.1 What Changes

| Component | Current | Target |
|-----------|---------|--------|
| `gateway-bridge.ts` `job:delivered` listener | Hardcoded `cortexIssuer` check | Result Router with per-issuer handlers |
| `loop.ts` `sessions_spawn` handler | Inline in loop, `onSpawn` callback | Still available (LLM path unchanged), subsystems use Task Spawner API directly |
| `tools.ts` `get_task_status` | Queries Router DB | Still works (queries same DB, subsystem tasks are Router tasks) |
| Gardener | `setInterval` in cortex process | Same logic, wrapped as Subsystem for visibility |
| Notifier | Shared abstraction for job delivery | Unchanged — feeds into Result Router |

### 8.2 What Doesn't Change

- **The Cortex loop** — still processes messages, calls LLM, handles tools. The monolith path is preserved for conversation and LLM-initiated tasks.
- **Router** — still executes tasks, emits events. Doesn't know or care about subsystems.
- **Notifier** — still delivers results, emits `job:delivered`. The Result Router is a consumer of these events, not a replacement for the Notifier.
- **`sessions_spawn` tool** — LLM can still spawn tasks directly. These go through the LLM result handler as before.
- **Foreground sharding** — subsystem tasks don't write to `cortex_session` (unless the LLM explicitly requests results). No shard impact.

### 8.3 Backward Compatibility

The entire subsystem layer is additive. If zero subsystems are registered, the Result Router falls back to the existing gateway-bridge handler. The system behaves identically to today.

---

## 9. Implementation Phases

### Phase 1: Foundation (Result Router + Subsystem Interface)
**Effort:** 2-3 sessions

- [ ] Define `Subsystem` interface and `SubsystemContext` in `src/cortex/subsystem.ts`
- [ ] Implement `ResultRouter` class
- [ ] Implement `SubsystemRegistry` class
- [ ] Implement `spawnTask()` API (extract from `onSpawn`)
- [ ] Refactor `gateway-bridge.ts`: replace hardcoded `cortexIssuer` filter with `ResultRouter.route()`
- [ ] Register existing LLM handler as `resultRouter.register(cortexIssuer, ...)`
- [ ] Create `cortex_subsystems` and `cortex_subsystem_tasks` tables
- [ ] Verify: existing LLM task spawn + result path still works identically

**Deliverable:** Infrastructure ready. No visible behavior change. Subsystems can be registered.

### Phase 2: Diagnostic Layer
**Effort:** 1 session

- [ ] Implement `get_subsystem_status` tool
- [ ] Implement `subsystem_action` tool
- [ ] Add both to `CORTEX_TOOLS` array
- [ ] Wire `executeGetSubsystemStatus()` to registry
- [ ] Wire `executeSubsystemAction()` to registry → subsystem.onLLMRequest
- [ ] Verify: LLM can query subsystem health, send actions

**Deliverable:** LLM can observe and interact with subsystems.

### Phase 3: Gardener Migration
**Effort:** 1 session

- [ ] Wrap existing Gardener as `Subsystem` (thin adapter)
- [ ] Register in startup sequence
- [ ] Expose health metrics (hot fact count, extraction rate, last error)
- [ ] Verify: Gardener works identically, now visible via diagnostic tool

**Deliverable:** First subsystem live. Proof of concept.

### Phase 4: Librarian Subsystem
**Effort:** 2-3 sessions

- [ ] Implement Librarian subsystem (see §6.2)
- [ ] Register result handler with Result Router
- [ ] Create Library DB schema (from library-architecture.md §4.2)
- [ ] Implement `onLLMRequest("ingest", { url })` — spawn task, process result
- [ ] Implement `onLLMRequest("search", { query })` — query Library
- [ ] Implement novelty checking on ingestion
- [ ] Verify: user drops link → LLM calls subsystem_action → Librarian spawns task → result stored in Library DB

**Deliverable:** Library ingestion pipeline working end-to-end.

### Phase 5: Night Scholar Subsystem
**Effort:** 2-3 sessions

- [ ] Implement Night Scholar subsystem (see §6.1)
- [ ] Schedule nightly cron (3:30 AM)
- [ ] Implement evaluation loop: read goals, query Library, spawn evaluation tasks
- [ ] Implement learning note generation from evaluation results
- [ ] Implement diversity audit (from library-architecture.md §8)
- [ ] Implement daily brief assembly + delivery to Cortex context
- [ ] Verify: Night Scholar runs autonomously, produces notes, Cortex sees brief on next session

**Deliverable:** Complete Library learning pipeline — Librarian ingests, Night Scholar evaluates, Cortex consumes.

### Phase 6: Health Monitoring + Hardening
**Effort:** 1-2 sessions

- [ ] Implement periodic health checks in registry
- [ ] Implement auto-restart with backoff
- [ ] Implement graceful shutdown
- [ ] Add health summary to heartbeat (if any subsystem unhealthy, include in HEARTBEAT.md check)
- [ ] Stress test: kill a subsystem mid-task, verify recovery

**Deliverable:** Production-grade subsystem lifecycle management.

---

## 10. Cost Impact

### Task spawning costs (per subsystem task)

| Subsystem | Tasks/day | Model | Cost/task | Daily cost |
|-----------|-----------|-------|-----------|------------|
| Librarian | ~1-3 | Sonnet | ~$0.01 | ~$0.03 |
| Night Scholar | ~10-20 | Sonnet | ~$0.008 | ~$0.12 |
| Gardener | 0 (inline) | Haiku | $0 (no Router) | $0 |
| Health Monitor | 0 (inline) | None | $0 | $0 |

### Savings from reduced LLM calls

Currently, every task result costs a full Cortex LLM invocation (Opus, full context window). With subsystem result routing:

- Night Scholar results: **0 LLM calls** (processed by subsystem callback)
- Librarian results: **0 LLM calls** (processed by subsystem callback)
- Only LLM-initiated tasks (user requests) trigger ops-trigger → LLM

**Estimated savings:** 10-20 Opus LLM calls/day avoided = **$0.50-$2.00/day saved** (depending on context size).

The subsystem architecture pays for itself — cheaper subsystem model calls replace expensive Opus LLM calls.

---

## 11. Relation to Other Architecture Docs

### Executor Architecture v2 (Process Isolation)

The Executor Architecture v2 describes process-level isolation: each executor runs in a forked Node.js process with IPC. The Subsystem Architecture operates one level above — subsystems are logical units that may spawn executors (which then run in isolated processes). The two are complementary:

```
Subsystem Architecture (logical supervision)
  └── Executor Architecture v2 (process isolation)
       └── Router (task queue + dispatch)
            └── Pi Agent (actual LLM execution)
```

### Library Architecture

The Library Architecture (library-architecture.md) describes the Librarian and Night Scholar as conceptual components. This document defines HOW they integrate with Cortex — as subsystems with the Subsystem interface, spawning tasks via the Task Spawner API, receiving results via the Result Router.

The Library Architecture is the **what**. This document is the **how**.

### SAGE Papers

SAGE Paper 3 describes "CEO agent" as a real-time organizational curator that tracks KPIs and submits operational lessons. In our architecture, this role is distributed across subsystems: the Night Scholar curates knowledge, the Health Monitor tracks system KPIs, and Cortex supervises them all. The subsystem architecture makes this distribution explicit and manageable.

---

## 12. Open Questions

1. **Should subsystems share a database or each have their own?** Currently proposed: shared `cortex/bus.sqlite` for the registry, separate `library/library.sqlite` for the Library. But the Night Scholar reads both the Library and the registry. Clear boundaries vs. convenience.

2. **Should the LLM be able to start/stop subsystems?** Current design: subsystems start at gateway boot. Should the LLM be able to `subsystem_action("cortex:scholar", "stop")` if the user asks? This adds complexity but increases control.

3. **Inter-subsystem communication.** If the Night Scholar finds something urgent in the Library, should it be able to alert the LLM directly (push)? Or only surface it in the next brief (pull)? Push is more responsive but adds complexity.

4. **Subsystem configuration.** Currently hardcoded in registration. Should there be a `cortex/subsystems.json` config file? Would allow users to enable/disable subsystems, adjust schedules, change models.

5. **Subsystem plugins.** Could third-party developers create subsystems as OpenClaw skills? A skill that registers a subsystem, with its own result handler and LLM actions. This would make the subsystem layer extensible.

6. **Task priority between subsystems.** Night Scholar runs background tasks. Librarian runs normal priority. What if the user asks Cortex to spawn an urgent task while 15 Night Scholar tasks are queued? Router priority handling exists but may need tuning for multi-issuer scenarios.

---

*This document is a living specification. It defines the expansion path from Cortex-as-monolith to Cortex-as-supervisor. Implementation is incremental — each phase delivers value independently.*
