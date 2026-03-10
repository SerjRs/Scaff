# Memory Flow Architecture

*Version: 1.4 — 2026-03-03*
*Status: Approved*
*Ref: `cortex-architecture.md`, `router-architecture-v2.md`, `cortex-implementation-tasks.md`*

---

## 0. Safety Gate

All Hippocampus features activate only when `hippocampus.enabled: true` in `cortex/config.json`. Default is `false`. The flag is hot-reloadable — toggling it takes effect on the next message with no restart. When disabled, Cortex falls back to pre-Hippocampus context assembly. This ensures the existing working system is never at risk during implementation.

---

## 1. Overview & Philosophy

If Cortex is the brain and the Router is the hands, the Memory Flow Architecture is the hippocampus. It governs how information degrades gracefully from immediate conversational awareness into permanent, token-free cold storage, and how it gets surfaced back into the active context window.

**Core Principles:**
1. **Token Economy:** Retaining memories must not bankrupt the token budget. The context window is never "fully booked" by default.
2. **Graceful Degradation:** Facts move from high-resolution (verbatim chat) to medium-resolution (summaries) to low-resolution (bullet points) to cold storage (vectors).
3. **Smart Archival:** Hot memory is managed via a database table tracking hit counts and recency, removing guesswork from the background Gardener.
4. **Explicit Retrieval:** Deep memory searches are delegated to isolated Router workers to keep Cortex's active window clean.

---

## 2. The 4 Layers of Memory (Context Injection)

Cortex dynamically assembles its context window from four distinct layers. The Context Manager builds the prompt bottom-up.

### Layer 1: System Floor (Identity, Hot Memory & Active State)
* **What it is:** The unchangeable baseline context. Always loaded.
* **Components:**
  * **Identity Files:** `SOUL.md`, `IDENTITY.md`, `USER.md`. These rarely change.
  * **Pending Operations:** Records from `cortex_pending_ops`. Cortex never forgets a long-running task because it sits here permanently until completed. Pending ops follow a simple lifecycle (`pending` → `completed`/`failed` → copy to `cortex_session` + DELETE). Only ops still in the table are injected into the System Floor, using a consistent structured format:
    * `Pending:` `[TASK_ID]=<id>, Message='<task description>', Status=Pending, Channel=<channel>, DispatchedAt=<timestamp>`
    * `Completed:` `[TASK_ID]=<id>, Message='<task description>', Status=Completed, Channel=<channel>, Result='<full result>', CompletedAt=<timestamp>`
    * `Failed:` `[TASK_ID]=<id>, Message='<task description>', Status=Failed, Channel=<channel>, Error='<error>', CompletedAt=<timestamp>`
  The LLM sees each task in this format from the moment it is dispatched. When a result arrives, the same line transitions from `Status=Pending` to `Status=Completed` — the LLM recognizes it as the task it has been tracking. After the LLM processes the result, the op is copied to `cortex_session` (Foreground) and deleted from `cortex_pending_ops`, dropping from the System Floor. It then lives in the Foreground as historical context, decaying naturally as the conversation continues. The Fact Extractor picks up these results from `cortex_session` during its regular scan.
  * **Hot Memory:** Actively injected facts from the `cortex_hot_memory` table (replacing the static `MEMORY.md` file).
* **Token Cost:** Fixed, high-priority constraint (target: < 15-20% of max context).

### Layer 2: Foreground (Active Conversation)
* **What it is:** The verbatim conversation history of the channel currently triggering Cortex.
* **Token Guardrails (Shard-Based Cap):** Foreground is bounded by a configurable token budget, but context is cut at **shard boundaries** — coherent topic blocks — never mid-conversation. Shards are the atomic unit: fully included or fully excluded. The active shard (current topic) is always included. See **`foreground-sharding-architecture.md`** for the full shard-based context management design.
* **Semantic Fetch:** If Cortex needs older verbatim context, it uses `fetch_chat_history` to pull back excluded shards by ID into the current turn.
* **Retention:** Ephemeral in the LLM's context window, but permanent in the SQLite database. Raw messages in `cortex_session` are never deleted — shards are metadata layered on top.

### Layer 3: Background (Peripheral Awareness)
* **What it is:** Highly compressed, 1-to-2 sentence summaries of *other* recently active channels (stored in `cortex_channel_states`).
* **Management:** When a channel loses focus, its recent messages are summarized. If a channel sits completely idle for >24 hours, it is dropped from the Background layer entirely.
* **Token Cost:** Very low, fixed overhead per active channel.

### Layer 4: Archived (Cold Memory)
* **What it is:** Semantic fragments, old facts, and past conversation summaries.
* **Token Cost:** **Zero.** This layer is never injected into the context window automatically.
* **Tech:** `sqlite-vec` extension loaded into the existing SQLite connection (same file as `cortex_hot_memory` and the Router queue). Single database file, single backup. No external dependencies.
* **Embeddings:** Generated by the local Ollama instance using `nomic-embed-text`. Called by the Vector Evictor (weekly Gardener task) when sweeping stale facts into cold storage. No external API calls.

---

## 3. Hot Memory Management (`cortex_hot_memory`)

To allow the Gardener to intelligently manage facts, Hot Memory is stored in a SQLite table rather than a static Markdown file.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS cortex_hot_memory (
  id TEXT PRIMARY KEY,
  fact_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);
```
---

Injection: When assembling the System Floor, the Context Manager queries:
SELECT fact_text FROM cortex_hot_memory ORDER BY hit_count DESC, last_accessed_at DESC LIMIT 50

## 4. The Write Path (Information Lifecycle)
How a statement like "I migrated the DB to Postgres" becomes a permanent memory:

Ingestion (Foreground): The message arrives and sits verbatim in the active context window.

Summarization (Background): When Cortex switches to a different channel, the previous channel is compressed into a 1-line summary.

Extraction (Hot Memory): A scheduled background task reads recent session logs, extracts the fact "Serj's project database is Postgres", and inserts it into cortex_hot_memory.

Eviction (Archived): Once a week, the Gardener runs: SELECT * FROM cortex_hot_memory WHERE last_accessed_at < datetime('now', '-14 days') AND hit_count < 3. It embeds these stale facts into the Vector DB and deletes them from the hot table to reclaim System Floor tokens.

## 5. The Read Path & Retrieval

Cortex has two distinct native tools for memory retrieval. They are intentionally separate — different underlying mechanics, different LLM schemas, different intent.

### Tool A: `fetch_chat_history` — Chronological Recall (Layer 2 Expansion)
* **Use Case:** Cortex needs older verbatim conversation context from a specific channel ("What exactly did we say about X earlier on webchat?").
* **Mechanics:** Deterministic relational query against `cortex_session` table. Returns chronological rows. No embeddings, no semantic search.
* **Layer:** Expands Layer 2 (Foreground) on demand — pulls older messages that the Soft Cap excluded.
* **Schema:** `{ channel: string, limit?: number, before?: string }` — simple, no ambiguity.

### Tool B: `memory_query` — Semantic Recall (Layer 4 / Cold Storage)
* **Use Case:** Quick factual lookups for disconnected facts that have been evicted from Hot Memory ("What IP address did we use last week?").
* **Mechanics:** Embeds the query string via Ollama `nomic-embed-text` → vector similarity search against `sqlite-vec` cold storage.
* **Tracking:** Automatically updates `last_accessed_at` and increments `hit_count` in `cortex_hot_memory` for any facts retrieved, ensuring useful facts stay hot and avoid future eviction.
* **Schema:** `{ query: string, limit?: number }` — minimal, specific.

**Why two tools, not one:** Vector semantic search (embedding + `sqlite-vec`) and chronological session lookup (SQL rows from `cortex_session`) are fundamentally different operations. Overloading them into one tool would require complex mode-switching parameters and degrade LLM tool-call accuracy. Separate tools = clearer intent, better LLM performance.

### Deep Research
Complex synthesis across months of data is delegated via `sessions_spawn` to a standard Router worker (Sonnet/Opus tier). No specialized Librarian tier — the Router's existing evaluation handles complexity routing.

## 6. Long-Running Tasks & Result Arrival

> **⚠️ IMPLEMENTATION DIVERGENCE:** The `cortex_pending_ops` table described below was **removed** during implementation. The actual implementation uses a simpler direct-delivery path: `gateway-bridge.ts` receives `job:delivered` → enqueues an ops-trigger envelope with the result inline in metadata → `loop.ts` detects the trigger and writes the result directly to `cortex_session` via `appendTaskResult()`. There is no System Floor ops injection, no `[DISPATCHED]` evidence records, no `acknowledged_at` column, and no `copyAndDeleteCompletedOps()`. Structured tool_use/tool_result content blocks provide provenance instead. See `ACTIVE-ISSUES.md` divergences D1-D2 for details.
>
> The spec below is preserved for historical context.

When Cortex delegates a task via `sessions_spawn` (e.g., research, file ops, computation), the operation follows a durable lifecycle. Completed/failed ops are **copied to `cortex_session`** and then **deleted** from `cortex_pending_ops`. The Fact Extractor picks them up from `cortex_session` during its regular scan — no separate Op Harvester needed.

### 6.1 Pending Operation Lifecycle

```
pending → completed/failed → [LLM sees it] → copy to cortex_session + DELETE
```

| Status | Meaning | In System Floor? |
|--------|---------|-----------------|
| `pending` | Task dispatched, waiting for Router result | Yes — `Status=Pending` |
| `completed` | Result arrived, LLM has not yet processed it | Yes — same line, now `Status=Completed` with full `Result` |
| `failed` | Task failed, LLM has not yet processed it | Yes — `Status=Failed` with error |
| *(deleted)* | LLM processed the result; op copied to `cortex_session` and deleted | No — lives in Foreground history, picked up by Fact Extractor |

### 6.2 Dispatch

Cortex fires `sessions_spawn`. A PendingOperation is written to `cortex_pending_ops` with `status = 'pending'`. The op includes the original task description, the reply channel, and the result priority.

**Dispatch evidence:** Immediately after writing the pending op, the loop stores an assistant-role record in `cortex_session`:
```
[DISPATCHED] [TASK_ID]=<id>, Message='<task>', Status=Pending, Channel=<reply_channel>, DispatchedAt=<ts>
```
This is critical for provenance — without it, the LLM has no memory of having called `sessions_spawn` on subsequent turns and cannot correlate completed results with its own dispatches. The `[DISPATCHED]` prefix and task ID allow the LLM to match foreground evidence with System Floor status changes.

### 6.3 Persistence

Because `cortex_pending_ops` is part of the System Floor, Cortex never forgets the task is running, even as Background channel summaries decay over hours or days.

### 6.4 Result Arrival

The Router worker finishes. The gateway bridge listener receives `job:delivered`, matches the Cortex issuer, and:

1. **Updates the pending op** — sets `status = 'completed'`, attaches the full result text and completion timestamp. The op is NOT deleted.
2. **Enqueues a lightweight trigger** — a minimal `CortexEnvelope` (content: `[ops_update]`, channel: op's `reply_channel`) enters the bus to wake Cortex. The trigger is NOT a content message — it carries no result data. Its sole purpose is to kick off a Cortex loop iteration so the LLM sees the updated System Floor.

The result itself lives exclusively in `cortex_pending_ops.result`. It enters the LLM's context via the System Floor — the same structured line the LLM has been seeing as `Status=Pending` now reads `Status=Completed` with the full `Result`. No separate bus message, no foreground entry, no dual-path confusion.

### 6.4.1 The Ops Trigger

The lightweight trigger is a minimal `CortexEnvelope` that carries no result data:

```json
{
  "channel": "<reply_channel>",
  "sender": { "id": "system:ops", "name": "System", "relationship": "system" },
  "content": "[ops_update]",
  "priority": "<result_priority from pending op>",
  "metadata": { "ops_trigger": true }
}
```

The loop detects triggers via `envelope.metadata.ops_trigger === true` and:
- **Stores a system notification** — `[Task update available]` is appended to the session as a user-role message (sender: `cortex:ops`). This ensures the foreground ends with a user message (API requirement) and tells the LLM to check Active Operations.
- **Proceeds with context assembly** — the updated `cortex_pending_ops` is now in the System Floor
- **Calls the LLM** — which sees the status change and acts on it

If multiple ops complete simultaneously, each fires its own trigger. The bus serializes them by priority — `urgent` results are processed before `normal` before `background`.

### 6.5 Cortex Processes the Result

The lightweight trigger is dequeued from the bus. The loop recognizes it as an ops trigger (content: `[ops_update]`) and **skips `appendToSession()`** — the trigger is not a real message and must not pollute the conversation history.

Context assembly runs normally. The System Floor now includes the completed op in its structured format:
```
[TASK_ID]=abc, Message='check server uptime', Status=Completed, Channel=webchat, Result='Server has been up for 45 days.', CompletedAt=2026-02-28T19:25:00Z
```

The LLM recognizes this as the same task it has been tracking (it saw `Status=Pending` on every prior turn). The `Result` field contains the full answer. The LLM relays the result to the user on the appropriate channel.

**Single path, single format.** The LLM never sees an unsolicited message from an unknown sender. It sees a field change on a line it already knows.

### 6.5.1 Copy to Foreground & Delete

After each LLM turn completes, the loop calls `copyAndDeleteCompletedOps(db)` which:

1. **Copies to Foreground** — For each completed/failed op, inserts a row into `cortex_session` with:
   - `role = 'user'` (incoming information)
   - `channel` = the op's `expected_channel`
   - `sender_id = 'cortex:ops'`
   - `content` = structured format with `[TASK_RESULT]` or `[TASK_FAILED]` prefix
   - `timestamp` = the op's `completed_at`

2. **Deletes** — Removes the op from `cortex_pending_ops`. Only `pending` ops remain in the table.

**After copy+delete:**
- The op is gone from the System Floor (no stale results, ever)
- The result lives in `cortex_session` on the correct channel, with the correct timestamp
- `buildForeground()` picks it up as part of the conversation history
- It decays naturally as the conversation continues (soft cap pushes old messages out)
- The Fact Extractor picks up the result from `cortex_session` during its regular scan — no separate Op Harvester needed

### Schema

```sql
CREATE TABLE IF NOT EXISTS cortex_pending_ops (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  expected_channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | completed | failed
  completed_at TEXT,                          -- when result arrived
  result TEXT                                 -- result content from Router
);

CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON cortex_pending_ops(status);
```

## 6.6 Structured Tool Round-Trips in Session History

### The Problem

When Cortex makes a real `sessions_spawn` tool call via the Anthropic API, the LLM returns a `tool_use` content block. The loop executes it, stores dispatch evidence as text in `cortex_session`, and feeds a `tool_result` back to the LLM. This works for the current turn.

On **subsequent turns**, the session history is replayed to the API. If tool interactions were stored as flat text strings (e.g., `[DISPATCHED] [TASK_ID]=abc, Message='...'`), the `contextToMessages()` function in `llm-caller.ts` wraps them as `{"type": "text", "text": "..."}` content blocks. The model sees its own past tool usage represented as plain text — and learns in-context to replicate that pattern, outputting `[Tool] sessions_spawn: ...` as text instead of making real API tool calls.

This is a **context poisoning loop**: text-based tool evidence → model mimics text output → stored as more text evidence → reinforces the pattern.

### The Fix: Structured Content Blocks

Tool round-trips in `cortex_session` must be stored as **structured content block arrays**, not flat strings. This ensures `contextToMessages()` passes them through as proper `tool_use`/`tool_result` blocks on replay.

**Assistant message (tool call):**
```json
{
  "role": "assistant",
  "content": [
    {"type": "tool_use", "id": "toolu_abc", "name": "sessions_spawn", "input": {"task": "..."}},
    {"type": "text", "text": "Searching for that now."}
  ]
}
```

**User message (tool result):**
```json
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_abc", "content": "Task dispatched. [TASK_ID]=abc, Status=Pending"}
  ]
}
```

The `contextToMessages()` code already handles this — `typeof m.content === "string"` returns false for arrays, so they pass through untouched to `completeSimple()`.

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| `loop.ts` — dispatch storage | Stores `[DISPATCHED] ...` as flat string in `cortex_session.content` | Stores the raw `tool_use` content block array from the LLM response |
| `loop.ts` — tool result storage | Stores tool result as flat string | Stores as `tool_result` content block array |
| `llm-caller.ts` — replay | Wraps string content as `{"type": "text"}` | Passes array content through unchanged |
| `cortex_session.content` column | Always `TEXT` (string) | `TEXT` containing either a plain string OR a JSON-serialized array of content blocks |

### What Does NOT Change

- The `[TASK_ID]=...` format in `cortex_pending_ops` / System Floor — that is system context, not assistant history
- The `[DISPATCHED]` text prefix for dispatch evidence in the System Floor preamble
- The `copyAndDeleteCompletedOps()` flow — completed ops are still copied to `cortex_session` as user-role text messages (they are informational, not tool round-trips)
- Sync tools (`fetch_chat_history`, `memory_query`, `get_task_status`) — these execute within a single turn and their `tool_use`/`tool_result` blocks should also be stored structurally

### Session Reset

After deploying this change, the existing `cortex_session` history contains text-based tool evidence that will continue to poison the model. The session must be truncated or reset to eliminate the in-context examples of text-based tool calls.

---

## 7. The Gardener Subsystem
To keep the memory flow healthy, OpenClaw runs a background system cron agent called the Gardener.

Gardener Tasks:

Channel Compactor (Hourly): Compresses inactive Foreground sessions into Background summaries.

Fact Extractor (Every 6h): Scans recent cortex_session logs, uses a Sonnet-tier LLM to identify persistent facts, and updates cortex_hot_memory. Since completed op results are copied to cortex_session (via `copyAndDeleteCompletedOps`), the Fact Extractor automatically picks them up — no separate Op Harvester is needed.

Vector Evictor (Weekly): Sweeps cortex_hot_memory for records with low hit_count and stale last_accessed_at dates. Embeds them into Cold Memory and deletes the hot rows.
