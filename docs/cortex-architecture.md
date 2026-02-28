# Cortex Architecture

Cortex is OpenClaw's unified processing brain. Every inbound message — regardless of channel — enters a single session, gets assembled into a layered context, and is processed by one LLM call at a time.

## Core Principles

1. **One session, all channels.** Messages from webchat, WhatsApp, Telegram, cron, Router results — all land in the same session history, tagged with channel metadata.
2. **Strict serialization.** One message processed at a time. No parallel LLM calls. This prevents race conditions and guarantees deterministic ordering.
3. **Crash durability.** Every completed turn is checkpointed to SQLite. On restart, unprocessed messages are recovered and retried.
4. **Safety modes.** Each channel is independently `off`, `shadow` (observe only), or `live` (full send). Shadow mode lets you test Cortex decisions without affecting real conversations.

## System Overview

```
                    ┌──────────────────────────────────┐
                    │  Gateway (gateway-bridge.ts)     │
                    │  Config, adapters, Router events  │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │  Cortex Instance (index.ts)      │
                    │  Singleton, init, public API      │
                    └──────────────┬───────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
    ┌─────────▼──────┐  ┌─────────▼──────┐  ┌──────────▼─────────┐
    │  Bus (bus.ts)   │  │ Session        │  │ Hippocampus        │
    │  SQLite queue   │  │ (session.ts)   │  │ (hippocampus.ts)   │
    │  Priority-      │  │ Unified        │  │ Hot memory (flat)  │
    │  ordered,       │  │ history,       │  │ Cold storage       │
    │  WAL mode       │  │ channel state, │  │ (sqlite-vec KNN)   │
    └─────────┬──────┘  │ pending ops    │  └──────────┬─────────┘
              │          └─────────┬──────┘             │
              │                    │                     │
    ┌─────────▼────────────────────▼─────────────────────▼────────┐
    │  Processing Loop (loop.ts)                                  │
    │  Dequeue → Context → LLM → Tools → Output → Checkpoint     │
    └─────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
    ┌─────────▼──────┐ ┌─────▼──────┐ ┌──────▼─────────┐
    │ LLM Caller     │ │ Sync Tools │ │ Async Tools    │
    │ (llm-caller.ts)│ │ (tools.ts) │ │ sessions_spawn │
    │ pi-ai + OAuth  │ │ fetch_chat │ │ → Router       │
    │ Claude models  │ │ memory_q   │ │   delegation   │
    └────────────────┘ └────────────┘ └────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point. Singleton guard, init all subsystems, public API (`enqueue`, `registerAdapter`, `stop`, `stats`). |
| `loop.ts` | Main processing loop. Dequeue → context → LLM → tools → output → checkpoint. Max 5 sync tool rounds per message. |
| `bus.ts` | SQLite message queue. Priority-ordered (`urgent > normal > background`), FIFO within tier. WAL mode for durability. |
| `session.ts` | Unified session history, channel state tracking, pending operations lifecycle. |
| `context.ts` | 4-layer context assembly (system floor, foreground, background, archived). Token budgeting. |
| `llm-caller.ts` | Real LLM calls via pi-ai streaming (OAuth, Claude Code identity). Also gardener LLM and stub for tests. |
| `output.ts` | Parse LLM response → `CortexOutput`. Route to adapters. Handle silence, cross-channel directives. |
| `types.ts` | Core types: `CortexEnvelope`, `BusMessage`, `CortexOutput`, `PendingOperation`, `ChannelState`. |
| `gateway-bridge.ts` | Gateway integration. Config loading, adapter registration, Router event subscription, startup cleanup. |
| `hippocampus.ts` | Hot memory (flat table, hit-count ranked) + cold storage (sqlite-vec vector search). |
| `gardener.ts` | Background maintenance: channel compaction, fact extraction, vector eviction, op harvesting. |
| `tools.ts` | Sync tool definitions (`fetch_chat_history`, `memory_query`) and executors. |
| `channel-adapter.ts` | Adapter registry — channel-specific send implementations. |
| `shadow.ts` | Shadow mode hook — observe without sending. |

## Processing Loop

Each tick of the loop (`loop.ts`) processes exactly one message:

```
1. DEQUEUE         dequeueNext(db) — priority-ordered, FIFO within tier
2. MARK PROCESSING markProcessing(db, id) — state: pending → processing
3. APPEND SESSION  appendToSession(db, envelope) — record inbound message
4. ASSEMBLE        assembleContext() — build 4-layer context
5. CALL LLM        callLLM(context) — returns text + tool calls
  5a. SYNC TOOLS   Up to 5 rounds of fetch_chat_history / memory_query
  5b. ASYNC TOOLS  sessions_spawn → addPendingOp → fire to Router
6. PARSE           parseResponse() → CortexOutput (targets, silence, cross-channel)
7. ROUTE           routeOutput() → send via adapters
8. RECORD          appendResponse(db, output) — record Cortex's reply
8b. ACKNOWLEDGE    acknowledgeCompletedOps(db) — mark results as "read"
9. CHECKPOINT      markCompleted(db, id) — state: processing → completed
```

### Tool Rounds

The loop supports up to `MAX_TOOL_ROUNDS = 5` sync tool round-trips per message. After the LLM responds with a tool call (`fetch_chat_history` or `memory_query`), the tool is executed and the result is fed back to the LLM for another turn.

The async tool `sessions_spawn` is fire-and-forget — it submits work to the Router and tracks it as a pending operation.

## Context Assembly

Context is assembled in 4 layers with token budgeting (`context.ts`):

### Layer 1: System Floor (always loaded)
- `SOUL.md` — agent identity and personality
- `IDENTITY.md` — agent capabilities
- `USER.md` — user preferences
- `MEMORY.md` — persistent memory
- **Active Operations** — pending, completed (unread), and failed (unread) ops
- **Known Facts** — hot memory facts (when Hippocampus enabled)

### Layer 2: Foreground (demand-based)
- Full conversation history from the trigger channel
- Gets remaining token budget after system floor and background
- When Hippocampus enabled: soft cap of 20 messages / 4000 tokens

### Layer 3: Background (compressed)
- One-line summaries of other active channels
- Format: `[channel] summary (last: timestamp)`
- Archived channels excluded
- When Hippocampus enabled: channels idle >24h excluded

### Layer 4: Archived (zero cost)
- Inactive channels — not in context at all

## Pending Operations Lifecycle

Operations dispatched to the Router follow this lifecycle:

```
                    ┌──────────┐
                    │ pending  │  Waiting for result
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │ success              │ failure
              ▼                      ▼
        ┌───────────┐         ┌──────────┐
        │ completed │         │  failed  │
        │ (unread)  │         │ (unread) │
        └─────┬─────┘         └────┬─────┘
              │                    │
              │  acknowledgeCompletedOps()
              │  (after LLM turn)  │
              ▼                    ▼
        ┌───────────┐         ┌──────────┐
        │ completed │         │  failed  │
        │ (read)    │         │  (read)  │
        └─────┬─────┘         └──────────┘
              │                    │
              │  Op Harvester      │ (no harvesting)
              ▼                    │
        ┌───────────┐              │
        │ gardened  │              │
        └─────┬─────┘              │
              │                    │
              │  7+ days           │
              ▼                    │
        ┌───────────┐              │
        │ archived  │              │
        └───────────┘              │
                                   │
                          Stays in DB for audit
```

### System Floor Visibility

`getPendingOps()` returns ops that should appear in the System Floor:
- `status = 'pending'` — shown as `[PENDING]`
- `status = 'completed'` AND `acknowledged_at IS NULL` — shown as `[NEW RESULT]`
- `status = 'failed'` AND `acknowledged_at IS NULL` — shown as `[FAILED]`

After the LLM processes a turn, `acknowledgeCompletedOps()` stamps `acknowledged_at` on all completed/failed ops, removing them from future System Floor injections. This is the inbox read/unread pattern.

### Failure Handling

`failPendingOp(db, id, error)` sets:
- `status = 'failed'`
- `completed_at = now`
- `result = 'Error: {error}'`

It does NOT set `acknowledged_at`. The failed op remains visible in `getPendingOps()` so the LLM can see `[FAILED] ... Inform the user that this task failed.` and tell the user. It is only acknowledged (hidden) after the next LLM turn.

### Startup Cleanup

On gateway restart (`gateway-bridge.ts`), any ops still in `pending` status are orphans from a prior crash. They are failed with `"orphaned from prior session (startup cleanup)"` and remain visible for one LLM turn so the user is informed.

## Hippocampus Memory Subsystem

Optional subsystem (`hippocampusEnabled: true`) providing two-tier persistent memory:

### Hot Memory (`cortex_hot_memory`)
- Flat SQLite table, fast reads
- Ranked by `hit_count DESC, last_accessed_at DESC`
- Top 50 facts injected into System Floor as "Known Facts"
- Facts are "touched" when retrieved via `memory_query` tool

### Cold Storage (`cortex_cold_memory_vec`)
- sqlite-vec virtual table for KNN vector search
- Stores embeddings from evicted hot facts
- Searched via `memory_query` tool with cosine distance
- Retrieved cold facts are promoted back to hot memory

### Gardener (Background Workers)

Four automated maintenance tasks (`gardener.ts`):

| Task | Frequency | What it does |
|------|-----------|-------------|
| Channel Compactor | Hourly | Summarize idle foreground channels → demote to background |
| Fact Extractor | 6 hours | Extract persistent facts from recent session messages → hot memory |
| Vector Evictor | Weekly | Move stale hot facts (>14 days, <3 hits) → cold storage with embeddings |
| Op Harvester | 6 hours | Extract facts from completed ops → hot memory, mark ops as gardened |

## Channel Modes

Each channel is independently configured (`cortex/config.json`):

| Mode | Behavior |
|------|----------|
| `off` | No processing, no tracking |
| `shadow` | Cortex processes and records decisions, but does NOT send output. For safety testing. |
| `live` | Full processing with output delivery via adapters. |

Config example:
```json
{
  "enabled": true,
  "defaultMode": "off",
  "channels": {
    "webchat": "live",
    "whatsapp": "shadow",
    "router": "live"
  },
  "hippocampus": { "enabled": true }
}
```

## Output Routing

The LLM response is parsed into a `CortexOutput` (`output.ts`):

| Pattern | Behavior |
|---------|----------|
| `NO_REPLY` | Silence — no output sent, recorded as `[silence]` |
| `HEARTBEAT_OK` | Silence — heartbeat acknowledged |
| `[[send_to:channel]]` | Cross-channel — send to specified channel, strip directive |
| `[[reply_to_current]]` | Reply to source channel (stripped from output) |
| Default | Reply to the channel the message came from |

## LLM Integration

`llm-caller.ts` provides three caller types:

1. **Gateway LLM Caller** — Real calls via pi-ai streaming, OAuth token auth, tool support (`sessions_spawn`). Retries across auth profiles on failure.
2. **Gardener LLM Function** — Simple prompt→text for fact extraction and summarization. No tools.
3. **Stub LLM Caller** — Always returns `NO_REPLY`. For tests.

### Context-to-Messages Conversion

`contextToMessages()` converts the assembled context into Anthropic Messages API format:
- System floor + background → `system` parameter
- Foreground messages → `messages[]` array (user/assistant alternation)
- Tool round-trips → assistant `tool_use` + user `tool_result` continuation
- Consecutive same-role messages are consolidated (API requirement)

## SQLite Schema

### Bus (`cortex_bus`)
```sql
id, envelope (JSON), state, priority, enqueued_at,
processed_at, attempts, error, checkpoint_id
```
Index: `(state, priority, enqueued_at)`

### Session (`cortex_session`)
```sql
id, envelope_id, role, channel, sender_id, content, timestamp, metadata
```
Indexes: `(channel, timestamp)`, `(timestamp)`

### Channel States (`cortex_channel_states`)
```sql
channel (PK), last_message_at, unread_count, summary, layer
```

### Pending Ops (`cortex_pending_ops`)
```sql
id (PK), type, description, dispatched_at, expected_channel,
status, completed_at, result, gardened_at, acknowledged_at
```
Index: `(status)`

### Hot Memory (`cortex_hot_memory`)
```sql
id (PK), fact_text, created_at, last_accessed_at, hit_count
```

### Cold Memory (`cortex_cold_memory_vec` + `cortex_cold_memory`)
```sql
-- Virtual table (sqlite-vec)
cortex_cold_memory_vec(rowid INTEGER PRIMARY KEY, embedding FLOAT[768])

-- Metadata
cortex_cold_memory(rowid, fact_text, created_at, archived_at)
```

### Checkpoints (`cortex_checkpoints`)
```sql
id, created_at, session_snapshot, channel_states, pending_ops
```
