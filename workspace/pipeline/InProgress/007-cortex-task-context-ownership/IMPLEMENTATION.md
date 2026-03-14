# 007 — Implementation Guide

Read `SPEC.md` first for the full architecture. This document has the exact code changes.

## File 1: `src/cortex/session.ts`

### 1a. Schema migration

In `_migrateSchema(db)`, add at the end (after existing migrations):

```typescript
// 007: Drop dead cortex_pending_ops, create cortex_task_dispatch
// cortex_pending_ops has no production readers/writers — safe to drop.
// Check if cortex_task_dispatch already exists to make migration idempotent.
const dispatchExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_task_dispatch'`
).get();
if (!dispatchExists) {
  db.exec(`DROP TABLE IF EXISTS cortex_pending_ops`);
  db.exec(`
    CREATE TABLE cortex_task_dispatch (
      task_id          TEXT PRIMARY KEY,
      channel          TEXT NOT NULL,
      channel_context  TEXT,
      counterpart_id   TEXT,
      counterpart_name TEXT,
      shard_id         TEXT,
      task_summary     TEXT,
      dispatched_at    TEXT NOT NULL,
      priority         TEXT DEFAULT 'normal',
      executor         TEXT,
      issuer           TEXT,
      status           TEXT DEFAULT 'pending',
      completed_at     TEXT,
      result           TEXT,
      error            TEXT
    )
  `);
}
```

### 1b. Type definition

Add near the top of session.ts (or in types.ts if preferred):

```typescript
export interface TaskDispatch {
  taskId: string;
  channel: string;
  channelContext: Record<string, unknown> | null;
  counterpartId: string | null;
  counterpartName: string | null;
  shardId: string | null;
  taskSummary: string | null;
  dispatchedAt: string;
  priority: string;
  executor: string | null;
  issuer: string | null;
  status: string;
  completedAt: string | null;
  result: string | null;
  error: string | null;
}
```

### 1c. storeDispatch function

```typescript
/** Record dispatch context when Cortex spawns a task. */
export function storeDispatch(db: DatabaseSync, params: {
  taskId: string;
  channel: string;
  channelContext?: Record<string, unknown> | null;
  counterpartId?: string | null;
  counterpartName?: string | null;
  shardId?: string | null;
  taskSummary: string;
  priority?: string;
  executor?: string | null;
  issuer?: string;
}): void {
  db.prepare(`
    INSERT INTO cortex_task_dispatch
      (task_id, channel, channel_context, counterpart_id, counterpart_name,
       shard_id, task_summary, dispatched_at, priority, executor, issuer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.taskId,
    params.channel,
    params.channelContext ? JSON.stringify(params.channelContext) : null,
    params.counterpartId ?? null,
    params.counterpartName ?? null,
    params.shardId ?? null,
    params.taskSummary,
    new Date().toISOString(),
    params.priority ?? "normal",
    params.executor ?? null,
    params.issuer ?? "agent:main:cortex",
  );
}
```

### 1d. getDispatch function

```typescript
/** Look up dispatch context by taskId. Returns null if not found. */
export function getDispatch(db: DatabaseSync, taskId: string): TaskDispatch | null {
  const row = db.prepare(
    `SELECT * FROM cortex_task_dispatch WHERE task_id = ?`
  ).get(taskId) as Record<string, unknown> | undefined;

  if (!row) return null;

  let channelContext: Record<string, unknown> | null = null;
  if (typeof row.channel_context === "string") {
    try { channelContext = JSON.parse(row.channel_context); } catch { /* best-effort */ }
  }

  return {
    taskId: row.task_id as string,
    channel: row.channel as string,
    channelContext,
    counterpartId: (row.counterpart_id as string) ?? null,
    counterpartName: (row.counterpart_name as string) ?? null,
    shardId: (row.shard_id as string) ?? null,
    taskSummary: (row.task_summary as string) ?? null,
    dispatchedAt: row.dispatched_at as string,
    priority: (row.priority as string) ?? "normal",
    executor: (row.executor as string) ?? null,
    issuer: (row.issuer as string) ?? null,
    status: (row.status as string) ?? "pending",
    completedAt: (row.completed_at as string) ?? null,
    result: (row.result as string) ?? null,
    error: (row.error as string) ?? null,
  };
}
```

### 1e. completeDispatch function

```typescript
/** Update dispatch record when a task completes or fails. */
export function completeDispatch(
  db: DatabaseSync,
  taskId: string,
  status: "completed" | "failed",
  result?: string,
  error?: string,
): void {
  db.prepare(`
    UPDATE cortex_task_dispatch
    SET status = ?, completed_at = ?, result = ?, error = ?
    WHERE task_id = ?
  `).run(status, new Date().toISOString(), result ?? null, error ?? null, taskId);
}
```

### 1f. Export the new functions

Add `storeDispatch`, `getDispatch`, `completeDispatch`, and `TaskDispatch` to the module exports.

### 1g. Clean up dead references

The comment at line ~160 mentions `cortex_pending_ops`. Update it:
```
// Old: "This replaces the old cortex_pending_ops → System Floor path..."
// New: "Task results are written directly to cortex_session as foreground messages."
```

---

## File 2: `src/cortex/loop.ts`

### 2a. Add import

Add to existing imports from `./session.js`:
```typescript
import { ..., storeDispatch, getDispatch } from "./session.js";
```

### 2b. sessions_spawn handler (~line 555-610)

Find the `sessions_spawn` block inside the async tool handling section (look for `} else if (tc.name === "sessions_spawn" && onSpawn) {`).

**Remove** the `replyChannel` line:
```typescript
// DELETE THIS LINE:
const replyChannel = (msg.envelope.channel !== "router" && msg.envelope.channel !== "cron")
  ? msg.envelope.channel : null;
```

**After** `const taskId = crypto.randomUUID();`, **add** the storeDispatch call:
```typescript
// Record dispatch context — stays in Cortex, never enters the pipeline
storeDispatch(db, {
  taskId,
  channel: msg.envelope.channel,
  channelContext: {
    threadId: msg.envelope.replyContext?.threadId,
    accountId: msg.envelope.replyContext?.accountId,
    messageId: msg.envelope.replyContext?.messageId,
  },
  counterpartId: msg.envelope.sender?.id,
  counterpartName: msg.envelope.sender?.name,
  shardId: assignedShardId,
  taskSummary: task.slice(0, 200),
  priority: resultPriority,
  executor: executor ?? null,
  issuer,
});
```

**Update** the `onSpawn` call — remove `replyChannel` from params:
```typescript
// BEFORE:
const jobId = onSpawn({ task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId, ... });
// AFTER:
const jobId = onSpawn({ task, resultPriority, envelopeId: msg.envelope.id, taskId, ... });
```

**Important:** Also check the failure branch (when `!jobId`). Currently it uses `replyChannel`:
```typescript
// BEFORE:
channel: replyChannel ?? msg.envelope.channel,
// AFTER (use channel directly):
channel: msg.envelope.channel,
```

### 2c. library_ingest handler (~line 490-540)

Find the `library_ingest` block. It also has:
```typescript
const replyChannel = (msg.envelope.channel !== "router" && msg.envelope.channel !== "cron")
  ? msg.envelope.channel : null;
```

Apply the same pattern: remove `replyChannel`, add `storeDispatch` before `onSpawn`, remove `replyChannel` from `onSpawn` params.

### 2d. Ops-trigger handling (~line 145-175)

Find the `if (isOpsTrigger)` block that builds `appendedContent` and sets `effectiveEnvelope`.

**Current code** (around line 145-175) does two things:
1. Builds `appendedContent` from trigger metadata (`meta.taskResult`, `meta.taskDescription`, etc.)
2. Overrides `effectiveEnvelope.replyContext.channel` from `meta.replyChannel`

**Change the replyContext override** (around line 640-650, the second `if (isOpsTrigger)` block):

```typescript
// BEFORE:
if (isOpsTrigger) {
  const replyChannel = msg.envelope.metadata?.replyChannel as string | undefined;
  if (replyChannel) {
    effectiveEnvelope = {
      ...msg.envelope,
      replyContext: { ...msg.envelope.replyContext, channel: replyChannel },
    };
  }
}

// AFTER:
if (isOpsTrigger) {
  const taskId = msg.envelope.metadata?.taskId as string;
  const dispatch = taskId ? getDispatch(db, taskId) : null;

  if (dispatch) {
    const ctx = dispatch.channelContext ?? {};
    effectiveEnvelope = {
      ...msg.envelope,
      replyContext: {
        channel: dispatch.channel as ChannelId,
        ...ctx,
      },
    };
  } else {
    // Fallback for in-flight tasks spawned before upgrade
    const replyChannel = msg.envelope.metadata?.replyChannel as string | undefined;
    if (replyChannel) {
      effectiveEnvelope = {
        ...msg.envelope,
        replyContext: { ...msg.envelope.replyContext, channel: replyChannel },
      };
    }
  }
}
```

**For appendedContent** — the trigger metadata still carries `taskResult`, `taskDescription`, `taskStatus` for the LLM prompt. Keep this for now; it works independently of the dispatch table. In a future iteration, the loop could read the result from `getDispatch` instead.

### 2e. SpawnParams interface

In `loop.ts` (or wherever `SpawnParams` is defined — check top of file), remove `replyChannel` from the interface:

```typescript
// BEFORE:
export interface SpawnParams {
  task: string;
  replyChannel: string | null;
  resultPriority: "urgent" | "normal" | "background";
  // ...
}

// AFTER:
export interface SpawnParams {
  task: string;
  resultPriority: "urgent" | "normal" | "background";
  // ...
}
```

---

## File 3: `src/cortex/gateway-bridge.ts`

### 3a. Add import

```typescript
import { ..., getDispatch, completeDispatch } from "./session.js";
```

### 3b. onSpawn callback (~line 198)

**Remove** `replyChannel` from the destructured params and from `payload.context`:

```typescript
// BEFORE:
onSpawn: ({ task, replyChannel, resultPriority, taskId, resources, executor }) => {
  // ...
  const payload = {
    message: task,
    context: JSON.stringify({ replyChannel, resultPriority, source: "cortex" }),
  };

// AFTER:
onSpawn: ({ task, resultPriority, taskId, resources, executor }) => {
  // ...
  const payload = {
    message: task,
    context: JSON.stringify({ source: "cortex" }),
  };
```

### 3c. onJobDelivered handler (~line 400-500)

Find `const onJobDelivered`. Currently it parses `replyChannel` from the Router payload context:

```typescript
// FIND AND REPLACE this section:
let replyChannel = "webchat";
let taskDescription = "";
try {
  const payload = JSON.parse(job.payload ?? "{}");
  taskDescription = payload.message ?? "";
  const ctx = JSON.parse(payload.context ?? "{}");
  replyChannel = ctx.replyChannel ?? "webchat";
} catch { /* best-effort parse */ }

// REPLACE WITH:
let taskDescription = "";
try {
  const payload = JSON.parse(job.payload ?? "{}");
  taskDescription = payload.message ?? "";
} catch { /* best-effort parse */ }

// Restore channel from dispatch context (owned by Cortex, not the pipeline)
const dispatch = getDispatch(instance.db, jobId);
const replyChannel = dispatch?.channel ?? "webchat";
```

### 3d. After appendTaskResult, add completeDispatch (~line 440)

Right after the `appendTaskResult` call (both the completed and failed branches), add:

```typescript
// Update dispatch lifecycle
completeDispatch(instance.db, jobId,
  job.status === "completed" ? "completed" : "failed",
  job.result,
  job.error,
);
```

### 3e. Simplify trigger metadata (~line 450)

**Keep taskResult/taskDescription in trigger metadata for now** — the loop.ts ops-trigger handler uses them to build `appendedContent` for the LLM. Removing them is a separate follow-up (it would require the loop to read results from the dispatch table instead).

The key change is that the trigger no longer needs `replyChannel` — the loop reads it from `getDispatch`:

```typescript
// The trigger still carries result data for the LLM prompt, but
// replyChannel is now restored from cortex_task_dispatch, not metadata.
// replyChannel in metadata is kept temporarily for the fallback path
// (in-flight tasks spawned before this upgrade).
```

---

## File 4: `src/cortex/types.ts`

### 4a. SpawnParams interface

If `SpawnParams` is defined here (check — it might be in loop.ts), remove `replyChannel`:

```typescript
// Remove: replyChannel: string | null;
```

---

## File 5: `src/cortex/__tests__/e2e-op-lifecycle.test.ts`

### 5a. Update or replace the skipped test

The test currently has:
```typescript
it.skip("cortex_pending_ops table has been removed — tests no longer applicable", () => {});
```

Replace with a new test for `cortex_task_dispatch`:

```typescript
describe("cortex_task_dispatch lifecycle", () => {
  it("storeDispatch + getDispatch round-trips correctly", () => {
    // Create an in-memory DB, run migrations
    // Call storeDispatch with sample data including channelContext JSON
    // Call getDispatch, verify all fields including deserialized channelContext
  });

  it("completeDispatch updates status and result", () => {
    // storeDispatch, then completeDispatch with "completed" + result
    // Verify status, completedAt, result are set
  });

  it("getDispatch returns null for unknown taskId", () => {
    // Verify null return, no crash
  });

  it("channelContext handles null gracefully", () => {
    // storeDispatch with channelContext: null
    // getDispatch should return channelContext: null
  });
});
```

---

## Build verification

After all changes, run:
```bash
cd ~/.openclaw && pnpm build
```

The build must succeed with zero errors. The project uses TypeScript strict mode.

---

## What NOT to change

- **Do NOT modify** `src/cortex/output.ts` — `parseResponse` works with whatever `replyContext` it receives.
- **Do NOT modify** `src/cortex/adapters/whatsapp.ts` or `src/cortex/adapters/webchat.ts` — the adapters are consumers, not producers of context.
- **Do NOT modify** Router code (`src/router/`) — the Router is deliberately kept stateless.
- **Do NOT remove** `taskResult`/`taskDescription`/`taskStatus` from ops-trigger metadata yet — the loop still uses them for `appendedContent`. That's a follow-up refactor.
- **Do NOT remove** the `replyChannel` from trigger metadata yet — it serves as the fallback for in-flight tasks (see loop.ts 2d fallback branch).
