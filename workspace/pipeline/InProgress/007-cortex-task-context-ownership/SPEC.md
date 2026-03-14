---
id: "007"
title: "Cortex task dispatch context — correlation-based execution"
created: "2026-03-14"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "critical"
status: "in-progress"
moved_at: "2026-03-14T10:57"
---

# 007 — Cortex Task Dispatch Context

## Model

Cortex is an agent that holds conversations and delegates work. The pattern is always the same, regardless of who Cortex is talking to or through which channel:

1. **Cortex is in a conversation** with some counterpart — a human, another agent, a cron trigger, a system process. The conversation happens through a channel (WhatsApp, webchat, Telegram, IPC, any future channel). The channel has its own addressing attributes (chatId, topicId, guildId, etc.).

2. **Cortex decides to spawn a task** as a result of that conversation. This is a deliberate decision: something in the discussion led Cortex to conclude it needs external work done.

3. **The task executes and returns.** When results arrive, Cortex must be able to **link them back to the original decision point**: who was it talking to, through which channel, in what conversation context, when and why it decided to kick off this task. Only then can Cortex interpret the results and act: reply to the counterpart, retry with more detail, store silently, or spawn a follow-up.

## Problem

The current architecture pushes reply metadata (channel, addressing attributes) through the execution pipeline: `loop.ts → onSpawn → Router payload → job:delivered → ops-trigger → effectiveEnvelope → adapter`. The execution pipeline carries context that belongs to Cortex.

This breaks in practice — the WhatsApp `threadId` (chatId) is lost in transit, so responses to async tasks are silently dropped. But the real problem is architectural: the execution pipeline should not carry conversation context. Adding any new channel requires threading its specific attributes through 4+ files in the pipeline.

## Design Principle

> **Cortex owns its dispatch context. The execution pipeline is stateless. Results correlate back by taskId.**

- At spawn time, Cortex records everything about the conversation state: who, where, which channel, what addressing attributes, which conversation shard, why it's spawning.
- The execution pipeline receives only: `{ taskId, task, priority }`. No channel info. No addressing. No reply context.
- When results arrive, Cortex looks up its own dispatch record by `taskId`. It now has the full context to decide what to do next.

## Schema

### Drop `cortex_pending_ops`, create `cortex_task_dispatch`

`cortex_pending_ops` is dead code — no production code reads or writes to it (confirmed: only a skip'd test and a comment reference it). Drop it and create a clean table that matches the dispatch model:

```sql
DROP TABLE IF EXISTS cortex_pending_ops;

CREATE TABLE cortex_task_dispatch (
  task_id          TEXT PRIMARY KEY,

  -- The conversation: who, where, how
  channel          TEXT NOT NULL,       -- "whatsapp", "webchat", "telegram", "ipc", ...
  channel_context  TEXT,                -- JSON: channel-specific addressing attributes
  counterpart_id   TEXT,                -- who Cortex was talking to (channel-agnostic identity)
  counterpart_name TEXT,                -- display name

  -- The decision point: when and why
  shard_id         TEXT,                -- conversation shard at spawn time (links back to cortex_session)
  task_summary     TEXT,                -- what Cortex asked the executor to do (first ~200 chars)
  dispatched_at    TEXT NOT NULL,       -- when Cortex made the decision

  -- Execution metadata
  priority         TEXT DEFAULT 'normal',  -- urgent/normal/background
  executor         TEXT,                   -- "coding" or null (standard)
  issuer           TEXT,                   -- Cortex session key

  -- Lifecycle (updated on completion)
  status           TEXT DEFAULT 'pending', -- pending/completed/failed
  completed_at     TEXT,
  result           TEXT,
  error            TEXT
);
```

`channel_context` is a JSON blob holding all channel-specific addressing attributes. Each channel stores what it needs — no schema changes when adding channels:

```jsonc
// WhatsApp
{ "threadId": "+40751845717", "accountId": "default" }

// Telegram
{ "chatId": -100123456, "topicId": 42, "botToken": "prod" }

// Discord
{ "guildId": "123", "channelId": "456", "threadId": "789" }

// Webchat
{ "sessionId": "abc-def" }

// Future channel X
{ "whatever": "it needs" }
```

When results arrive, Cortex reads `channel` to know the type, deserializes `channel_context` to get the addressing, and replies. Zero coupling between the dispatch table and any specific channel's attributes.

Every column serves the three-part model:
- **Conversation context** (`channel`, `channel_context`, `counterpart_id`, `counterpart_name`): who was Cortex talking to and how to reach them → enables replying to the right place through the right channel
- **Decision point** (`shard_id`, `task_summary`, `dispatched_at`): when and why → enables linking results to the conversation moment. `shard_id` is the key — from it, Cortex can query `cortex_session` to reconstruct the full conversation context at decision time
- **Lifecycle** (`status`, `completed_at`, `result`, `error`): what happened → enables interpretation and audit

## Implementation

### Phase 1: Schema (session.ts)

Migration in `_migrateSchema`:

```typescript
// Drop dead table, create dispatch context table
db.exec(`DROP TABLE IF EXISTS cortex_pending_ops`);
db.exec(`
  CREATE TABLE IF NOT EXISTS cortex_task_dispatch (
    task_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    channel_context TEXT,
    counterpart_id TEXT,
    counterpart_name TEXT,
    shard_id TEXT,
    task_summary TEXT,
    dispatched_at TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    executor TEXT,
    issuer TEXT,
    status TEXT DEFAULT 'pending',
    completed_at TEXT,
    result TEXT,
    error TEXT
  )
`);
```

New functions:

```typescript
export function storeDispatch(db, params: {
  taskId: string;
  channel: string;
  channelContext?: Record<string, unknown> | null;  // channel-specific addressing, stored as JSON
  counterpartId?: string | null;
  counterpartName?: string | null;
  shardId?: string | null;
  taskSummary: string;
  priority?: string;
  executor?: string | null;
  issuer?: string;
}): void { /* INSERT INTO cortex_task_dispatch, JSON.stringify(channelContext) */ }

export function getDispatch(db, taskId: string): TaskDispatch | null {
  /* SELECT, JSON.parse(channel_context) */
}

export function completeDispatch(db, taskId: string, status: "completed" | "failed", result?: string, error?: string): void {
  /* UPDATE status, completed_at, result, error */
}
```

### Phase 2: Store context at spawn (loop.ts)

**Current:**
```typescript
const replyChannel = (msg.envelope.channel !== "router" && msg.envelope.channel !== "cron")
  ? msg.envelope.channel : null;
const taskId = crypto.randomUUID();
const jobId = onSpawn({ task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId, ... });
```

**New:**
```typescript
const taskId = crypto.randomUUID();

// Record the dispatch context — stays in Cortex, never enters the pipeline
storeDispatch(db, {
  taskId,
  channel: msg.envelope.channel,
  channelContext: {
    threadId: msg.envelope.replyContext?.threadId,
    accountId: msg.envelope.replyContext?.accountId,
    messageId: msg.envelope.replyContext?.messageId,
    // Each channel adapter populates replyContext with its own attributes.
    // They all end up here as-is. No per-channel column mapping.
  },
  counterpartId: msg.envelope.sender?.id,
  counterpartName: msg.envelope.sender?.name,
  shardId: assignedShardId,
  taskSummary: task.slice(0, 200),
  priority: resultPriority,
  executor: executor ?? null,
  issuer,
});

// Pipeline only gets taskId + task + priority
const jobId = onSpawn({ task, taskId, resultPriority, envelopeId: msg.envelope.id, ... });
```

Same for `library_ingest` — it also spawns tasks.

### Phase 3: Strip metadata from pipeline (gateway-bridge.ts)

**onSpawn callback — current:**
```typescript
context: JSON.stringify({ replyChannel, resultPriority, source: "cortex" })
```

**New:**
```typescript
context: JSON.stringify({ source: "cortex" })
```

The Router doesn't need channel info. It just runs the task.

**onJobDelivered — current:**
```typescript
const ctx = JSON.parse(payload.context ?? "{}");
replyChannel = ctx.replyChannel ?? "webchat";
```

**New:**
```typescript
const dispatch = getDispatch(instance.db, jobId);
const replyChannel = dispatch?.channel ?? "webchat";
```

### Phase 4: Simplify ops-trigger (gateway-bridge.ts + loop.ts)

**Trigger creation — current** (carries full result + channel metadata):
```typescript
const triggerMeta = {
  ops_trigger: true, replyChannel, taskId, taskDescription,
  taskStatus, taskResult, taskError,
};
```

**New** — minimal wake-up signal:
```typescript
const triggerMeta = {
  ops_trigger: true,
  taskId: jobId,
  taskStatus: job.status,
};
```

The result is already stored via `completeDispatch()` + `appendTaskResult()`. The trigger only needs to wake Cortex and point to the task.

**Loop ops-trigger handling — current:**
```typescript
if (isOpsTrigger) {
  const replyChannel = msg.envelope.metadata?.replyChannel;
  effectiveEnvelope = {
    ...msg.envelope,
    replyContext: { ...msg.envelope.replyContext, channel: replyChannel },
  };
}
```

**New:**
```typescript
if (isOpsTrigger) {
  const taskId = msg.envelope.metadata?.taskId as string;
  const dispatch = getDispatch(db, taskId);

  if (dispatch) {
    // Restore replyContext from channel + deserialized channel_context
    const ctx = dispatch.channelContext ?? {};
    effectiveEnvelope = {
      ...msg.envelope,
      replyContext: {
        channel: dispatch.channel as ChannelId,
        ...ctx,  // threadId, accountId, messageId — whatever the channel stored
      },
    };
  }
}
```

Cortex restores the full conversation context from its own records. No metadata threading.

### Phase 5: Complete lifecycle (gateway-bridge.ts)

In `onJobDelivered`, after writing to `cortex_session`:
```typescript
completeDispatch(instance.db, jobId,
  job.status === "completed" ? "completed" : "failed",
  job.result,
  job.error,
);
```

## Files Changed

| File | Change |
|------|--------|
| `src/cortex/session.ts` | Drop `cortex_pending_ops`, create `cortex_task_dispatch`, add `storeDispatch()` / `getDispatch()` / `completeDispatch()`. `channel_context` stored as `JSON.stringify()`, parsed on read. |
| `src/cortex/loop.ts` | Store dispatch at spawn, restore context at ops-trigger, remove metadata from `onSpawn` params |
| `src/cortex/gateway-bridge.ts` | Strip metadata from Router payload, use `getDispatch` in `onJobDelivered`, simplify trigger, call `completeDispatch` |
| `src/cortex/types.ts` | Remove `replyChannel` from `SpawnParams` interface |
| `src/cortex/output.ts` | No changes — `parseResponse` works with whatever `replyContext` it gets |

## What This Fixes

1. **Broken async delivery** — channel addressing attributes are preserved as JSON in `cortex_task_dispatch.channel_context`, restored when results arrive. Works for any channel, current or future.
2. **Fragile metadata threading** — new channels require zero pipeline changes and zero schema changes. Cortex serializes their attributes at dispatch; the pipeline never sees them.
3. **No audit trail** — full task lifecycle with correlation: who was Cortex talking to, through which channel, what it spawned, when, result, duration.
4. **Responsibility inversion** — the execution pipeline no longer carries conversation context. Cortex owns it.

## What This Doesn't Change

- Router architecture (enqueue/dequeue/execute) — untouched
- Executor templates — untouched
- Channel adapter interfaces — untouched
- Shard assignment for ops-triggers — reads `shard_id` from dispatch record
- `appendTaskResult` — still writes to `cortex_session` for conversation history

## Testing

1. Spawn via WhatsApp → verify result delivered to correct chatId
2. Spawn via webchat → verify result delivered via broadcast
3. Cross-channel isolation: conversation on WhatsApp, result doesn't leak to webchat
4. `cortex_task_dispatch` lifecycle: pending → completed, all fields populated
5. Failure path: executor fails → error delivered to correct channel
6. Library ingestion: `library_ingest` tasks also store/restore dispatch context
7. Cron/system triggers: tasks spawned without a counterpart still complete cleanly (thread_id = null is valid)

## Risks

- **In-flight tasks**: Tasks spawned before upgrade won't have a `cortex_task_dispatch` row. Fallback: if `getDispatch` returns null, use legacy `replyChannel` from trigger metadata. Remove fallback after one release cycle.
