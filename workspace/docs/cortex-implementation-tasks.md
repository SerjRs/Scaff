# Cortex Implementation Plan

*Version: 1.0 — 2026-02-26*
*Status: Approved*
*Ref: `cortex-architecture.md` v1.0*

---

## Safety Architecture

**Risk:** Modifying gateway files (`server-startup.ts`, `server-chat.ts`, `subagent-spawn.ts`) can break the entire OpenClaw instance — killing all sessions, channels, and the agent itself. A bad deploy = back to zero.

**Mitigation — three layers:**

### Layer 1: Standalone Build (Tasks 1–13)
All Cortex code lives in `src/cortex/`. **Zero existing files modified.** The entire system — bus, adapters, session, context, loop, recovery — is built and passes 100+ unit tests before touching any gateway code.

### Layer 2: Three Operating Modes
Cortex has a mode flag, hot-reloadable via `config-reload.ts`:

| Mode | Behavior | Risk |
|------|----------|------|
| `off` | Cortex not loaded. Existing per-channel sessions. | None |
| `shadow` | Cortex receives **copies** of all messages. Processes them, builds context, makes decisions — but **does not send any output**. Existing system handles all responses. Cortex's SQLite can be inspected to verify correctness. | None — read-only observation |
| `live` | Cortex handles messages end-to-end. Existing per-channel path disabled for Cortex-managed channels. | Active — but validated by shadow mode first |

**Transition:** `off` → `shadow` (observe, verify) → `live` (one channel at a time)

### Layer 3: Per-Channel Gradual Cutover
Each channel can be independently set to `off`, `shadow`, or `live`:

```json
{
  "cortex": {
    "enabled": true,
    "defaultMode": "off",
    "channels": {
      "webchat": "live",
      "whatsapp": "shadow",
      "telegram": "off"
    }
  }
}
```

**Cutover order:** webchat (simplest, local) → WhatsApp → Telegram → internal (Router, sub-agents)

If any channel breaks in live mode → set it to `off` in config → next message uses the old system. No restart needed.

### Pre-Integration Checklist
Before Task 14 (Gateway Integration):
- [ ] Git branch `cortex-integration` from stable main
- [ ] Full backup of `~/.openclaw` directory
- [ ] All 100+ unit tests passing (Tasks 1–13)
- [ ] Shadow mode E2E tested standalone
- [ ] Rollback tested: `mode: "off"` → verify old system works unchanged

---

## Task Summary

| # | Task | Depends On | New Files | Tests |
|---|------|-----------|-----------|-------|
| 1 | Types & Envelope Schema | — | `src/cortex/types.ts` | Unit |
| 2 | Message Bus (SQLite) | 1 | `src/cortex/bus.ts` | Unit |
| 3 | Channel Adapter Interface | 1 | `src/cortex/channel-adapter.ts` | Unit |
| 4 | Webchat Adapter | 3 | `src/cortex/adapters/webchat.ts` | Unit |
| 5 | WhatsApp Adapter | 3 | `src/cortex/adapters/whatsapp.ts` | Unit |
| 6 | Telegram Adapter | 3 | `src/cortex/adapters/telegram.ts` | Unit |
| 7 | Internal Adapters (Router, Sub-agent, Cron) | 3 | `src/cortex/adapters/internal.ts` | Unit |
| 8 | Session Unification | 2 | `src/cortex/session.ts` | Unit |
| 9 | Context Manager | 1, 8 | `src/cortex/context.ts` | Unit |
| 10 | Output Router | 1, 3 | `src/cortex/output.ts` | Unit |
| 11 | Processing Loop | 2, 8, 9, 10 | `src/cortex/loop.ts` | Unit |
| 12 | State Persistence & Recovery | 2, 8, 11 | `src/cortex/recovery.ts` | Unit |
| 13 | Cortex Service Entry | 1–12 | `src/cortex/index.ts` | Unit |
| 14 | Shadow Mode Hook | 13 | `src/cortex/shadow.ts` | Unit |
| 15 | Gateway Integration | 13, 14 | *(modify existing)* | Unit |
| 16 | E2E: Shadow Mode Validation | 14, 15 | `src/cortex/__tests__/e2e-shadow.test.ts` | E2E |
| 17 | E2E: Multi-Channel Conversation | 15 | `src/cortex/__tests__/e2e-multichannel.test.ts` | E2E |
| 18 | E2E: Channel Handoff | 15 | `src/cortex/__tests__/e2e-handoff.test.ts` | E2E |
| 19 | E2E: Sub-agent & Router Awareness | 15 | `src/cortex/__tests__/e2e-subagent.test.ts` | E2E |
| 20 | E2E: Crash Recovery | 15 | `src/cortex/__tests__/e2e-recovery.test.ts` | E2E |
| 21 | E2E: Priority & Serialization | 15 | `src/cortex/__tests__/e2e-priority.test.ts` | E2E |
| 22 | E2E: Silence & No-Output | 15 | `src/cortex/__tests__/e2e-silence.test.ts` | E2E |
| 26 | sessions_spawn Tool Definition | 11 | *(modify `llm-caller.ts`)* | Unit |
| 27 | Async Dispatch — Fire and Forget | 26 | *(modify `loop.ts`, `gateway-bridge.ts`)* | Unit |
| 28 | Sub-agent Result Ingestion | 27 | *(modify `subagent-announce.ts`)* | Unit |
| 29 | Dynamic Model Resolution | — | *(modify `gateway-bridge.ts`)* | Unit |
| 30 | E2E: Delegation Flow | 26–29 | `src/cortex/__tests__/e2e-delegation.test.ts` | E2E |
| 31 | Extend `cortex_pending_ops` Schema | — | *(modify `session.ts`)* | Unit | ✅ Done |
| 32 | Replace `removePendingOp` with lifecycle completion/failure | 31 | *(modify `gateway-bridge.ts`, `loop.ts`)* | Unit | ✅ Done |
| 33 | Op Harvester — Gardener Pass | 31 | *(modify `gardener.ts`)* | Unit | ✅ Done |
| 34 | Archival Cleanup | 33 | *(modify `gardener.ts`)* | Unit | ✅ Done |
| 35 | E2E: Op Lifecycle | 31–34 | `src/cortex/__tests__/e2e-op-lifecycle.test.ts` | E2E | ✅ Done |
| 36 | Cortex Generates Task ID & Stores Metadata Locally | 37 | *(modify `loop.ts`, `session.ts`, `gateway-bridge.ts`, `types.ts`)* | Unit | ✅ Done |
| 37 | Router Accepts Caller-Provided Task ID | — | *(modify `queue.ts`)* | Unit | ✅ Done |
| 38 | Result Ingestion Reads Cortex Metadata from Local Table | 36 | *(modify `gateway-bridge.ts`, `session.ts`)* | Unit | ✅ Done |
| 39 | E2E: Issuer-Owned Task IDs | 36–38 | `src/cortex/__tests__/e2e-task-ownership.test.ts` | E2E | ✅ Done |

---

## Phase 1: Foundation

### Task 1 — Types & Envelope Schema

**Goal:** Define all Cortex types — the message envelope, channel metadata, priority levels, sender relationships, and bus message states.

**File:** `src/cortex/types.ts`

**Types to define:**
```ts
// Sender relationship — partner is Serj, everything else categorized by origin
type SenderRelationship = "partner" | "internal" | "external" | "system";

// Message priority — determines processing order in the bus
type MessagePriority = "urgent" | "normal" | "background";

// Channel identifier
type ChannelId = "whatsapp" | "webchat" | "telegram" | "discord" | "signal" |
                 "router" | "subagent" | "cron" | "email" | string;

// Sender metadata
interface Sender {
  id: string;            // "serj", "router:job-123", "system"
  name: string;          // "Serj", "Router", "Heartbeat"
  relationship: SenderRelationship;
}

// Where to send a reply
interface ReplyContext {
  channel: ChannelId;
  threadId?: string;
  messageId?: string;
  accountId?: string;    // for multi-account channels (e.g. WhatsApp)
}

// The envelope — wraps every message entering Cortex
interface CortexEnvelope {
  id: string;                  // UUID
  channel: ChannelId;
  sender: Sender;
  timestamp: string;           // ISO 8601
  replyContext: ReplyContext;
  content: string;
  priority: MessagePriority;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;  // channel-specific extras
}

// Attachment (images, files, voice notes)
interface Attachment {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  path?: string;
  mimeType?: string;
  caption?: string;
}

// Bus message states
type BusMessageState = "pending" | "processing" | "completed" | "failed";

// Stored bus message (envelope + state tracking)
interface BusMessage {
  envelope: CortexEnvelope;
  state: BusMessageState;
  enqueuedAt: string;
  processedAt?: string;
  attempts: number;
  error?: string;
}

// Cortex turn output — what Cortex decides to do after processing a message
interface CortexOutput {
  targets: OutputTarget[];       // zero or more outputs
  memoryActions?: MemoryAction[];
}

interface OutputTarget {
  channel: ChannelId;
  content: string;
  replyTo?: string;              // messageId to reply to
  threadId?: string;
  accountId?: string;
  attachments?: Attachment[];
}

type MemoryAction =
  | { type: "log"; content: string }
  | { type: "update_file"; path: string; content: string };

// Channel state snapshot (for Background/Archived tracking)
interface ChannelState {
  channel: ChannelId;
  lastMessageAt: string;
  unreadCount: number;
  summary?: string;             // one-line compressed summary
  layer: "foreground" | "background" | "archived";
}

// Pending operation (Router jobs, sub-agents in flight)
interface PendingOperation {
  id: string;
  type: "router_job" | "subagent" | "cron_task";
  description: string;
  dispatchedAt: string;
  expectedChannel: ChannelId;    // where result will arrive
}
```

**Unit tests:** `src/cortex/__tests__/types.test.ts`
- Envelope creation with all required fields
- Envelope validation (missing fields rejected)
- Priority ordering: urgent > normal > background
- SenderRelationship classification helpers
- ReplyContext defaults (reply to source channel)
- BusMessage state transitions: pending → processing → completed/failed
- Attachment type validation

---

### Task 2 — Message Bus (SQLite)

**Goal:** Durable, priority-ordered message queue backed by SQLite. Survives crashes. FIFO within same priority tier.

**File:** `src/cortex/bus.ts`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS cortex_bus (
  id TEXT PRIMARY KEY,
  envelope TEXT NOT NULL,            -- JSON-serialized CortexEnvelope
  state TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL,         -- 0=urgent, 1=normal, 2=background
  enqueued_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  checkpoint_id INTEGER              -- links to cortex_checkpoints
);

CREATE TABLE IF NOT EXISTS cortex_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  session_snapshot TEXT NOT NULL,     -- JSON: conversation history summary
  channel_states TEXT NOT NULL,       -- JSON: ChannelState[]
  pending_ops TEXT NOT NULL           -- JSON: PendingOperation[]
);

CREATE INDEX IF NOT EXISTS idx_bus_state_priority ON cortex_bus(state, priority, enqueued_at);
```

**Functions:**
```ts
initBus(dbPath: string): DatabaseSync
enqueue(db, envelope: CortexEnvelope): string                    // returns message id
dequeueNext(db): BusMessage | null                               // priority-ordered FIFO
markProcessing(db, id: string): void
markCompleted(db, id: string): void
markFailed(db, id: string, error: string): void
peekPending(db): BusMessage[]                                    // inspect queue without consuming
checkpoint(db, snapshot: CheckpointData): number                 // returns checkpoint id
loadLatestCheckpoint(db): CheckpointData | null
countPending(db): number
purgeCompleted(db, olderThan: string): number                    // cleanup old completed messages
```

**SQLite location:** `~/.openclaw/cortex/bus.sqlite` (WAL mode)

**Unit tests:** `src/cortex/__tests__/bus.test.ts`
- `enqueue` stores envelope, returns id
- `dequeueNext` returns highest-priority oldest message first
- Priority ordering: urgent before normal before background
- FIFO within same priority tier
- `markProcessing` transitions state, `dequeueNext` skips processing messages
- `markCompleted` transitions state
- `markFailed` stores error message
- Concurrent enqueue safety (WAL mode)
- `checkpoint` stores snapshot, `loadLatestCheckpoint` retrieves it
- `purgeCompleted` removes old entries, keeps pending/processing
- Empty queue: `dequeueNext` returns null
- Envelope round-trip: enqueue → dequeue → envelope matches original
- `countPending` accuracy after mixed operations
- DB survives simulated crash (close + reopen, pending messages intact)

---

## Phase 2: Channel Adapters

### Task 3 — Channel Adapter Interface

**Goal:** Define the interface that all channel adapters must implement. Adapters are dumb pipes — they translate between channel-specific formats and the Cortex envelope.

**File:** `src/cortex/channel-adapter.ts`

**Interface:**
```ts
interface ChannelAdapter {
  readonly channelId: ChannelId;

  // Convert channel-specific inbound message to Cortex envelope
  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope;

  // Send a Cortex output to the channel
  send(target: OutputTarget): Promise<void>;

  // Check if adapter is connected/available
  isAvailable(): boolean;
}

// Resolves sender identity from channel-specific data
interface SenderResolver {
  resolve(channelId: ChannelId, rawSenderId: string): Sender;
}

// Adapter registry — register and look up adapters by channelId
interface AdapterRegistry {
  register(adapter: ChannelAdapter): void;
  get(channelId: ChannelId): ChannelAdapter | undefined;
  list(): ChannelAdapter[];
}
```

**Functions:**
```ts
createAdapterRegistry(): AdapterRegistry
createSenderResolver(partnerIds: Map<ChannelId, string>): SenderResolver
```

The `SenderResolver` maps channel-specific sender IDs to `Sender` objects. The `partnerIds` map tells it which sender ID on each channel is Serj (the partner). Everyone else is classified by channel type (internal channels → "internal", external channels → "external").

**Unit tests:** `src/cortex/__tests__/channel-adapter.test.ts`
- Registry: register adapter, retrieve by channelId
- Registry: list returns all registered adapters
- Registry: get returns undefined for unregistered channel
- Registry: duplicate registration overwrites
- SenderResolver: partner ID on WhatsApp → relationship "partner"
- SenderResolver: unknown sender on WhatsApp → relationship "external"
- SenderResolver: sender on "router" channel → relationship "internal"
- SenderResolver: sender on "cron" channel → relationship "system"

---

### Task 4 — Webchat Adapter

**Goal:** Translate webchat messages to/from Cortex envelopes.

**File:** `src/cortex/adapters/webchat.ts`

**Behavior:**
- Webchat messages are always from Serj (partner) — the webchat is authenticated
- Inbound: extract content from webchat message format, create envelope with `relationship: "partner"`, `priority: "urgent"` (direct from partner)
- Outbound: format Cortex output as webchat response

**Integration point:** Currently `src/gateway/server-chat.ts` handles webchat. Adapter wraps the inbound path.

**Unit tests:** `src/cortex/__tests__/adapters/webchat.test.ts`
- `toEnvelope` creates envelope with correct channel, sender.relationship = "partner"
- `toEnvelope` sets priority to "urgent" (partner direct message)
- `toEnvelope` extracts content from webchat message format
- `toEnvelope` sets replyContext.channel = "webchat"
- `send` formats output for webchat delivery
- `isAvailable` returns true when webchat server is running

---

### Task 5 — WhatsApp Adapter

**Goal:** Translate WhatsApp messages to/from Cortex envelopes.

**File:** `src/cortex/adapters/whatsapp.ts`

**Behavior:**
- Inbound from Serj's number → `relationship: "partner"`, `priority: "urgent"`
- Inbound from group (not Serj) → `relationship: "external"`, `priority: "normal"`
- Inbound from group (Serj) → `relationship: "partner"`, `priority: "urgent"`
- Outbound: route through WhatsApp channel to correct chat/group
- Attachments: images, voice notes, documents mapped to `Attachment` type

**Integration point:** Currently `src/whatsapp/` handles WhatsApp. Adapter wraps the inbound path.

**Unit tests:** `src/cortex/__tests__/adapters/whatsapp.test.ts`
- `toEnvelope` from Serj DM → partner, urgent
- `toEnvelope` from group (stranger) → external, normal
- `toEnvelope` from group (Serj) → partner, urgent
- `toEnvelope` maps WhatsApp media to Attachment type
- `toEnvelope` sets replyContext with WhatsApp chat ID and message ID
- `send` routes to correct WhatsApp chat
- `isAvailable` reflects WhatsApp connection state
- Voice note attachment includes audio type and mime

---

### Task 6 — Telegram Adapter

**Goal:** Translate Telegram messages to/from Cortex envelopes.

**File:** `src/cortex/adapters/telegram.ts`

**Behavior:**
- Same pattern as WhatsApp — partner detection by Telegram user ID
- Group messages: Serj → partner/urgent, others → external/normal
- Bot commands mapped as content
- Telegram-specific: reply_to_message_id for threading

**Unit tests:** `src/cortex/__tests__/adapters/telegram.test.ts`
- `toEnvelope` from Serj DM → partner, urgent
- `toEnvelope` from group (stranger) → external, normal
- `toEnvelope` from group (Serj) → partner, urgent
- `toEnvelope` handles Telegram reply threading
- `send` routes to correct Telegram chat
- `isAvailable` reflects bot connection state

---

### Task 7 — Internal Adapters (Router, Sub-agent, Cron)

**Goal:** Adapters for internal channels — Router results, sub-agent completions, cron/heartbeat triggers.

**File:** `src/cortex/adapters/internal.ts`

**Router adapter:**
- Inbound: Router job completion → envelope with `sender: { id: "router:job-<id>", relationship: "internal" }`, `priority: "normal"` (or "urgent" if Cortex was awaiting it)
- Outbound: Cortex dispatching a task → enqueue in Router
- Metadata: job ID, tier, model, execution time

**Sub-agent adapter:**
- Inbound: sub-agent session completion → envelope with `sender: { id: "subagent:<label>", relationship: "internal" }`
- Outbound: Cortex spawning a sub-agent

**Cron adapter:**
- Inbound only: heartbeat tick, scheduled cron trigger → `sender: { id: "system", relationship: "system" }`, `priority: "background"`

**Unit tests:** `src/cortex/__tests__/adapters/internal.test.ts`
- Router result → envelope with correct sender, metadata
- Router result priority escalation when Cortex was awaiting
- Sub-agent completion → envelope with label-based sender id
- Cron trigger → envelope with system sender, background priority
- Heartbeat → envelope with system sender, background priority
- Router outbound: dispatch creates Router job
- Sub-agent outbound: spawn creates sub-agent session
- All internal adapters: `isAvailable` returns true (always available)

---

## Phase 3: Session & Context

### Task 8 — Session Unification

**Goal:** All channels resolve to ONE Cortex session. Replace per-channel session creation with a single unified session.

**File:** `src/cortex/session.ts`

**Core change:** Instead of `agent:main:<channel>:<uuid>`, there is ONE session key: `agent:main:cortex`. All messages from all channels append to this session's history, tagged with their envelope metadata.

**Functions:**
```ts
// Get or create the unified Cortex session key
getCortexSessionKey(agentId: string): string

// Append a message to the unified session history
appendToSession(db, envelope: CortexEnvelope): void

// Append Cortex's response to the unified session history
appendResponse(db, output: CortexOutput, inResponseTo: string): void

// Get session history (with optional channel filter)
getSessionHistory(db, opts?: { channel?: ChannelId; limit?: number }): SessionMessage[]

// Track active channels
updateChannelState(db, channelId: ChannelId, state: Partial<ChannelState>): void
getChannelStates(db): ChannelState[]

// Track pending operations
addPendingOp(db, op: PendingOperation): void
removePendingOp(db, id: string): void
getPendingOps(db): PendingOperation[]
```

**Schema (additional tables in bus.sqlite):**
```sql
CREATE TABLE IF NOT EXISTS cortex_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,          -- links to cortex_bus.id
  role TEXT NOT NULL,                 -- "user" | "assistant"
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT                       -- JSON
);

CREATE TABLE IF NOT EXISTS cortex_channel_states (
  channel TEXT PRIMARY KEY,
  last_message_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  layer TEXT NOT NULL DEFAULT 'archived'
);

CREATE TABLE IF NOT EXISTS cortex_pending_ops (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  expected_channel TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_channel ON cortex_session(channel, timestamp);
CREATE INDEX IF NOT EXISTS idx_session_timestamp ON cortex_session(timestamp);
```

**Unit tests:** `src/cortex/__tests__/session.test.ts`
- `getCortexSessionKey` returns `agent:main:cortex` format
- `getCortexSessionKey` returns same key on repeated calls (singleton)
- `appendToSession` stores message with envelope metadata
- `appendResponse` stores Cortex output linked to input envelope
- `getSessionHistory` returns all channels by default, ordered by timestamp
- `getSessionHistory` with channel filter returns only that channel's messages
- `getSessionHistory` with limit truncates oldest
- `updateChannelState` creates/updates channel tracking
- `getChannelStates` returns all tracked channels
- Channel state layer transitions: archived → background → foreground
- `addPendingOp` / `removePendingOp` / `getPendingOps` CRUD
- Pending op removal for completed Router job
- Session history round-trip: append → get → content matches

---

### Task 9 — Context Manager

**Goal:** Assemble the 4-layer context (System floor, Foreground, Background, Archived) for each LLM call. This is what goes into the context window.

**File:** `src/cortex/context.ts`

**The 4 layers:**

1. **System floor** — Always loaded. Identity (SOUL.md, IDENTITY.md), memory (MEMORY.md, long-term shards), user info (USER.md), active operations state, workspace context. Non-negotiable baseline.

2. **Foreground** — The active conversation. Messages from the channel that triggered this turn, plus recent cross-channel messages that are contextually relevant. Demand-based — takes what it needs.

3. **Background** — Other channels with recent activity. Compressed to one-line summaries: "WhatsApp group: 12 messages, Serj asked about dinner at 14:30." Cheap awareness.

4. **Archived** — Inactive channels. Not in context at all. Zero tokens. Retrievable if explicitly referenced.

**Functions:**
```ts
interface ContextLayer {
  name: "system_floor" | "foreground" | "background" | "archived";
  tokens: number;          // estimated token count
  content: string;         // rendered content for this layer
}

interface AssembledContext {
  layers: ContextLayer[];
  totalTokens: number;
  foregroundChannel: ChannelId;
  backgroundSummaries: Map<ChannelId, string>;
  pendingOps: PendingOperation[];
}

// Assemble full context for an LLM call
assembleContext(params: {
  db: DatabaseSync;
  triggerEnvelope: CortexEnvelope;        // the message being processed
  workspaceDir: string;                    // for loading system floor files
  maxTokens: number;                       // context window budget
}): Promise<AssembledContext>

// Load system floor (identity + memory + workspace)
loadSystemFloor(workspaceDir: string): Promise<ContextLayer>

// Build foreground from session history
buildForeground(db, channel: ChannelId, budget: number): ContextLayer

// Compress other channels into background summaries
buildBackground(db, excludeChannel: ChannelId): ContextLayer

// Estimate token count for a string
estimateTokens(text: string): number
```

**Context assembly algorithm:**
1. Load system floor → fixed cost, always first
2. Remaining budget = maxTokens - system floor tokens
3. Build background summaries → small fixed cost per active channel
4. Remaining budget = remaining - background tokens
5. Build foreground from trigger channel → fills remaining budget
6. If foreground doesn't use full budget, expand with cross-channel recent messages

**Unit tests:** `src/cortex/__tests__/context.test.ts`
- `loadSystemFloor` loads SOUL.md, IDENTITY.md, USER.md, MEMORY.md
- `loadSystemFloor` includes pending operations state
- `loadSystemFloor` returns valid ContextLayer with token estimate
- `buildForeground` returns messages from trigger channel only
- `buildForeground` respects token budget (truncates oldest when over)
- `buildBackground` compresses other channels to one-line summaries
- `buildBackground` excludes the foreground channel
- `buildBackground` returns empty for channels with no recent activity
- `assembleContext` produces all layers in correct order
- `assembleContext` system floor always present regardless of budget
- `assembleContext` foreground expands into unused background budget
- `assembleContext` total tokens ≤ maxTokens
- `estimateTokens` reasonable accuracy (within 10% of tiktoken for test strings)
- Empty session (first message): only system floor + the trigger message
- Context with pending operations includes op descriptions in system floor

---

## Phase 4: Output & Processing

### Task 10 — Output Router

**Goal:** Route Cortex's output decisions to the correct channel adapters. Supports reply-to-source, cross-channel, multi-channel, and silence.

**File:** `src/cortex/output.ts`

**Functions:**
```ts
// Route Cortex output through channel adapters
routeOutput(params: {
  output: CortexOutput;
  registry: AdapterRegistry;
  onError: (channel: ChannelId, error: Error) => void;
}): Promise<void>

// Parse LLM response into CortexOutput
// The LLM's response may contain channel directives (reply tags, cross-channel sends)
// or may be a simple text reply to the source channel
parseResponse(params: {
  llmResponse: string;
  triggerEnvelope: CortexEnvelope;
}): CortexOutput

// Handle the special case of no output (silence)
isSilentResponse(llmResponse: string): boolean
```

**Routing rules:**
1. If `output.targets` is empty → silence, do nothing
2. For each target, look up adapter by `target.channel`
3. Call `adapter.send(target)` for each
4. If adapter not found for a target channel → call `onError`
5. Memory actions executed after all sends complete

**Unit tests:** `src/cortex/__tests__/output.test.ts`
- `routeOutput` sends to correct adapter for single target
- `routeOutput` sends to multiple adapters for multi-channel output
- `routeOutput` handles empty targets (silence) — no adapter calls
- `routeOutput` calls onError when adapter not found
- `routeOutput` executes memory actions after sends
- `parseResponse` creates reply to source channel by default
- `parseResponse` detects `[[reply_to_current]]` tag
- `parseResponse` detects cross-channel directive (e.g., `[[send_to:whatsapp]]`)
- `parseResponse` handles NO_REPLY as silence
- `isSilentResponse` returns true for "NO_REPLY", "HEARTBEAT_OK"
- `isSilentResponse` returns false for normal text

---

### Task 11 — Processing Loop

**Goal:** The main Cortex loop. Dequeues messages from the bus, assembles context, calls the LLM, routes output, and checkpoints. Strict serialization — one message at a time.

**File:** `src/cortex/loop.ts`

**Functions:**
```ts
interface CortexLoopOptions {
  db: DatabaseSync;
  registry: AdapterRegistry;
  workspaceDir: string;
  maxContextTokens: number;
  pollIntervalMs: number;           // how often to check the bus (default: 500ms)
  callLLM: (context: AssembledContext) => Promise<string>;  // injectable LLM caller
  onError: (error: Error) => void;
}

// Start the Cortex processing loop
startLoop(opts: CortexLoopOptions): CortexLoop

interface CortexLoop {
  stop(): Promise<void>;            // graceful shutdown
  isRunning(): boolean;
  processedCount(): number;
}
```

**Loop algorithm:**
1. `dequeueNext(db)` — get highest-priority pending message
2. If null → sleep `pollIntervalMs`, goto 1
3. `markProcessing(db, id)`
4. `appendToSession(db, envelope)` — add to unified history
5. `updateChannelState(db, envelope.channel, { layer: "foreground" })`
6. `assembleContext(...)` — build 4-layer context with trigger envelope
7. `callLLM(context)` — get response
8. `parseResponse(llmResponse, envelope)` — extract output decisions
9. `routeOutput(output, registry)` — send to channels
10. `appendResponse(db, output, envelope.id)` — record in session
11. `markCompleted(db, id)`
12. `checkpoint(db, ...)` — persist state
13. Goto 1

**Error handling:**
- LLM call failure → `markFailed(db, id, error)`, continue to next message
- Adapter send failure → log error, continue (don't fail the whole turn)
- Uncaught exception → log, don't crash the loop

**Unit tests:** `src/cortex/__tests__/loop.test.ts`
- Loop processes single message end-to-end
- Loop processes messages in priority order
- Loop serializes: second message waits for first to complete
- Loop handles LLM failure gracefully (marks failed, continues)
- Loop handles adapter send failure (logs error, completes turn)
- Loop checkpoints after each completed turn
- `stop()` waits for current message to finish, then stops
- `isRunning()` reflects loop state
- `processedCount()` increments after each message
- Empty bus: loop idles without errors
- Loop resumes after error without crashing

---

### Task 12 — State Persistence & Recovery

**Goal:** Recover Cortex state after a crash. Rebuild from SQLite bus + latest checkpoint.

**File:** `src/cortex/recovery.ts`

**Functions:**
```ts
// Recover Cortex state from SQLite after crash
recoverState(db: DatabaseSync): RecoveryResult

interface RecoveryResult {
  checkpoint: CheckpointData | null;          // latest checkpoint, if any
  unprocessedMessages: BusMessage[];          // pending messages to re-process
  stalledMessages: BusMessage[];              // were "processing" when crash happened
  channelStates: ChannelState[];
  pendingOps: PendingOperation[];
}

// Reset stalled messages back to pending
resetStalledMessages(db: DatabaseSync): number

// Validate and repair bus state after crash
repairBusState(db: DatabaseSync): RepairReport

interface RepairReport {
  stalledReset: number;           // messages reset from processing → pending
  orphansRemoved: number;         // broken entries cleaned up
  checksumValid: boolean;         // DB integrity check
}
```

**Recovery algorithm:**
1. Open bus.sqlite
2. Load latest checkpoint → restore channel states and pending ops
3. Find messages in "processing" state → these were in-flight when crash happened
4. Reset them to "pending" (they'll be reprocessed)
5. Count pending messages → these are the queue
6. Return everything for the loop to resume

**Unit tests:** `src/cortex/__tests__/recovery.test.ts`
- `recoverState` loads latest checkpoint
- `recoverState` finds unprocessed pending messages
- `recoverState` identifies stalled (processing-state) messages
- `resetStalledMessages` transitions processing → pending
- `resetStalledMessages` returns count of reset messages
- `repairBusState` resets stalled + removes orphans
- Recovery after simulated crash: enqueue 3 messages → process 1 → "crash" → recover → 2 pending + 1 stalled
- Empty DB recovery: returns null checkpoint, empty arrays
- Checkpoint ordering: `recoverState` returns most recent checkpoint
- Full cycle: enqueue → process → checkpoint → crash → recover → resume → all messages processed

---

## Phase 5: Service & Integration

### Task 13 — Cortex Service Entry

**Goal:** Single entry point to start/stop Cortex. Initializes bus, adapters, session, context manager, loop.

**File:** `src/cortex/index.ts`

**Functions:**
```ts
interface CortexConfig {
  agentId: string;
  workspaceDir: string;
  dbPath: string;                     // default: ~/.openclaw/cortex/bus.sqlite
  maxContextTokens: number;           // default: model's context window
  pollIntervalMs: number;             // default: 500
  partnerIds: Map<ChannelId, string>; // channel → partner's ID on that channel
}

interface CortexInstance {
  enqueue(envelope: CortexEnvelope): string;       // external entry point
  registerAdapter(adapter: ChannelAdapter): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  stats(): CortexStats;
}

interface CortexStats {
  processedCount: number;
  pendingCount: number;
  activeChannels: ChannelState[];
  pendingOps: PendingOperation[];
  uptime: number;
}

// Start Cortex
startCortex(config: CortexConfig): Promise<CortexInstance>

// Stop Cortex
stopCortex(instance: CortexInstance): Promise<void>
```

**Startup sequence:**
1. Open/create bus.sqlite (WAL mode)
2. Run recovery (reset stalled messages)
3. Create adapter registry
4. Create sender resolver with partnerIds
5. Start processing loop
6. Return CortexInstance

**Shutdown sequence:**
1. Stop processing loop (wait for current turn)
2. Final checkpoint
3. Close SQLite connection

**Unit tests:** `src/cortex/__tests__/index.test.ts`
- `startCortex` initializes and returns running instance
- `startCortex` runs recovery on startup
- `enqueue` accepts envelopes and they get processed
- `registerAdapter` adds adapter to registry
- `stop` performs graceful shutdown with final checkpoint
- `stats` returns accurate counts
- Double-start prevention (only one Cortex instance)
- Startup with existing DB (recovery + resume)

---

### Task 14 — Shadow Mode Hook

**Goal:** The observation layer. Cortex receives copies of messages without affecting the existing system. Allows validation before going live.

**File:** `src/cortex/shadow.ts`

**Functions:**
```ts
interface ShadowHook {
  // Called by existing channel handlers to feed a copy to Cortex
  observe(envelope: CortexEnvelope): void;

  // Check what Cortex would have done (for validation)
  getLastDecision(): CortexOutput | null;

  // Compare Cortex decision vs what existing system actually did
  audit(actualResponse: string, actualChannel: ChannelId): AuditResult;
}

interface AuditResult {
  match: boolean;                           // would Cortex have done the same thing?
  cortexTargets: OutputTarget[];            // what Cortex wanted to send
  actualChannel: ChannelId;                 // where existing system sent it
  diff?: string;                            // human-readable difference
}

// Resolve the effective mode for a given channel
resolveChannelMode(config: CortexConfig, channel: ChannelId): "off" | "shadow" | "live"

// Create the shadow hook (wraps a CortexInstance)
createShadowHook(cortex: CortexInstance): ShadowHook
```

**Behavior:**
- In `shadow` mode: `observe()` enqueues the envelope into Cortex bus. Cortex processes it fully (context assembly, LLM call, decision). But `routeOutput` is replaced with a no-op logger. Output is recorded in SQLite but never sent to any channel.
- In `live` mode: shadow hook is not used. Messages go directly to Cortex.
- In `off` mode: shadow hook is not created. Existing system runs unchanged.

**Unit tests:** `src/cortex/__tests__/shadow.test.ts`
- `observe` enqueues envelope into Cortex bus
- `observe` does NOT trigger any adapter.send calls
- `getLastDecision` returns what Cortex decided
- `audit` compares Cortex decision vs actual response
- `audit` returns match=true when Cortex would have sent same content to same channel
- `audit` returns match=false with diff when Cortex disagrees
- `resolveChannelMode` uses per-channel override over defaultMode
- `resolveChannelMode` falls back to defaultMode when channel not specified
- Shadow mode: full processing pipeline runs (bus → session → context → LLM → output decision) but no sends

---

### Task 15 — Gateway Integration

**Goal:** Wire Cortex into the OpenClaw gateway. Minimal, safe modifications to existing files. Respects per-channel mode (off/shadow/live).

**Modified files:**
- `src/gateway/server-startup.ts` — init Cortex on gateway start (if enabled)
- `src/gateway/server-close.ts` — stop Cortex on gateway shutdown
- `src/gateway/server-chat.ts` — webchat: check mode, route to Cortex or existing
- `src/channels/session.ts` — add shadow hook point
- `src/agents/subagent-spawn.ts` — sub-agent results: check mode, route accordingly
- `src/whatsapp/` — WhatsApp: check mode, route to Cortex or existing
- `src/telegram/` — Telegram: check mode, route to Cortex or existing

**Integration pattern:**
```ts
// In server-startup.ts
import { startCortex } from "../cortex/index.js";
import { createShadowHook, resolveChannelMode } from "../cortex/shadow.js";

// After existing init...
if (cfg.cortex?.enabled) {
  const cortex = await startCortex({
    agentId: "main",
    workspaceDir: cfg.workspace,
    dbPath: path.join(stateDir, "cortex", "bus.sqlite"),
    maxContextTokens: 200000,
    partnerIds: new Map([
      ["whatsapp", cfg.whatsapp?.partnerId],
      ["webchat", "webchat-user"],
      ["telegram", cfg.telegram?.partnerId],
    ]),
  });

  // Register adapters
  cortex.registerAdapter(new WebchatAdapter(/* ... */));
  cortex.registerAdapter(new WhatsAppAdapter(/* ... */));
  // ...

  // Shadow hook for observation mode
  const shadowHook = createShadowHook(cortex);

  // Store globally for channel handlers to access
  globalThis.__openclaw_cortex__ = cortex;
  globalThis.__openclaw_cortex_shadow__ = shadowHook;
}
```

```ts
// In each channel handler (e.g., server-chat.ts for webchat)
const mode = resolveChannelMode(cfg.cortex, "webchat");

if (mode === "live") {
  // Cortex handles everything
  cortex.enqueue(adapter.toEnvelope(rawMessage));
  return;  // existing handler does NOT process
}

if (mode === "shadow") {
  // Existing system processes normally
  // AND Cortex observes a copy
  shadowHook.observe(adapter.toEnvelope(rawMessage));
  // ...fall through to existing handler...
}

// mode === "off" → existing handler only, no Cortex involvement
```

**Config (in `cortex/config.json`, NOT openclaw.json — same pattern as Router):**
```json
{
  "enabled": true,
  "defaultMode": "off",
  "channels": {
    "webchat": "shadow",
    "whatsapp": "off",
    "telegram": "off"
  }
}
```

**Hot-reload:** Config is re-read on OpenClaw's existing config reload mechanism. Changing a channel from `shadow` to `live` or `off` takes effect on the next message.

**Unit tests:** `src/cortex/__tests__/gateway-integration.test.ts`
- Cortex initializes on gateway startup when `enabled: true`
- Cortex does NOT initialize when `enabled: false`
- Cortex stops on gateway shutdown
- Channel mode `off` → existing handler only, no Cortex calls
- Channel mode `shadow` → existing handler + shadow hook observe
- Channel mode `live` → Cortex handles, existing handler skipped
- Mode switch `shadow` → `live` → takes effect on next message
- Mode switch `live` → `off` → immediate fallback to existing system
- Config hot-reload updates channel modes without restart

---

## Phase 6: End-to-End Tests

### Task 16 — E2E: Shadow Mode Validation

**File:** `src/cortex/__tests__/e2e-shadow.test.ts`

**Scenarios:**
1. Shadow mode: message arrives → existing system responds → Cortex processes silently → no double-send
2. Shadow mode: Cortex decision logged in SQLite → can be inspected after the fact
3. Shadow mode: audit compares Cortex decision vs actual response → match/mismatch reported
4. Shadow → live transition: first message after switch goes through Cortex, not existing system
5. Live → off fallback: first message after switch goes through existing system, Cortex not called
6. Shadow mode under load: 20 messages → existing system handles all → Cortex processes all in background → no interference

---

### Task 17 — E2E: Multi-Channel Conversation

**File:** `src/cortex/__tests__/e2e-multichannel.test.ts`

**Scenarios:**
1. Send message on webchat → Cortex responds on webchat
2. Send message on WhatsApp → Cortex responds on WhatsApp
3. Send on webchat, then WhatsApp → Cortex has context from both in same session
4. Cortex's response on WhatsApp references something said on webchat (cross-channel awareness)
5. Three channels active simultaneously → all messages in one session history

---

### Task 18 — E2E: Channel Handoff

**File:** `src/cortex/__tests__/e2e-handoff.test.ts`

**Scenarios:**
1. Start conversation on webchat (5 messages) → continue on WhatsApp → Cortex has full context
2. Mid-conversation channel switch → reply goes to new channel
3. Return to original channel → context still intact
4. Rapid channel switching (webchat → WhatsApp → webchat) → no context loss

---

### Task 19 — E2E: Sub-agent & Router Awareness

**File:** `src/cortex/__tests__/e2e-subagent.test.ts`

**Scenarios:**
1. Cortex dispatches Router job → job completes → result arrives in Cortex context
2. Cortex dispatches sub-agent → completion notification arrives → Cortex processes it
3. Multiple Router jobs in flight → all tracked in pending operations → all results received
4. Cortex responds to Serj about a completed Router job (without being asked — proactive awareness)
5. Sub-agent failure → error arrives as envelope → Cortex handles gracefully

---

### Task 20 — E2E: Crash Recovery

**File:** `src/cortex/__tests__/e2e-recovery.test.ts`

**Scenarios:**
1. Enqueue 5 messages → process 2 → kill Cortex → restart → remaining 3 processed
2. Crash mid-processing → stalled message reset to pending → reprocessed on restart
3. Checkpoint survives crash → channel states restored → background summaries intact
4. Pending operations survive crash → Cortex knows what's still in flight after restart
5. Empty DB on first start → clean initialization, no errors

---

### Task 21 — E2E: Priority & Serialization

**File:** `src/cortex/__tests__/e2e-priority.test.ts`

**Scenarios:**
1. Enqueue background + normal + urgent → processed in order: urgent, normal, background
2. Multiple urgent messages → FIFO within urgent tier
3. Background message (heartbeat) doesn't preempt in-progress normal message
4. Partner message always urgent → processed before external group messages
5. 10 messages across 3 channels → strict serial processing (no parallel)

---

### Task 22 — E2E: Silence & No-Output

**File:** `src/cortex/__tests__/e2e-silence.test.ts`

**Scenarios:**
1. Heartbeat with nothing to report → Cortex returns HEARTBEAT_OK → no output sent to any channel
2. Group chat banter (external, low priority) → Cortex decides silence → no message sent
3. Router job completion that just needs logging → memory action only, no channel output
4. NO_REPLY response → no adapter.send called, message still marked completed
5. Multi-channel output where one target is "log only" → only the real channel gets a send

---

## Implementation Order

```
Phase 1 (Foundation):     Task 1 → Task 2
Phase 2 (Adapters):       Task 3 → Tasks 4,5,6,7 (parallel)
Phase 3 (Session):        Task 8 → Task 9
Phase 4 (Output/Loop):    Task 10 → Task 11 → Task 12
Phase 5 (Service):        Task 13 → Task 14 (shadow mode) → Task 15 (gateway)
Phase 6 (E2E):            Task 16 (shadow E2E first) → Tasks 17–22 (parallel)
```

**⚠️ SAFETY GATE between Task 14 and Task 15:**
Tasks 1–14 create ONLY new files in `src/cortex/`. Zero existing files touched.
Task 15 is the first and only task that modifies existing gateway files.
Before starting Task 15: git branch, full backup, all unit tests green, pre-integration checklist complete.

**Estimated scope:** 22 tasks, ~17 new files, ~110+ unit tests, ~30 E2E test scenarios.

**Critical path:** Tasks 1 → 2 → 8 → 9 → 11 → 13 → 14 → 15 (types → bus → session → context → loop → service → shadow → gateway)

**Deployment path:** `off` → `shadow` (webchat only, validate) → `live` (webchat) → `shadow` (WhatsApp) → `live` (WhatsApp) → repeat per channel

---

## Phase 7: Live Mode

*Status: Planned — shadow mode validated (14/14 messages, 0 errors)*

### Current State (2026-02-26)

**Completed:**
- Tasks 1–22 implemented (241 tests, 18 files)
- Shadow mode validated on webchat — all messages flow through bus cleanly
- Gateway integration wired (`feedCortex` via `globalThis` pattern)
- Config hot-reload works (`cortex/config.json`)

**Bug fixed during shadow validation:**
- Dynamic `import()` in bundled code doesn't resolve internal modules
- Fix: `globalThis.__openclaw_cortex_feed__` + `__openclaw_cortex_createEnvelope__` (same pattern as Router)
- Commit: `3b5a164`

---

### Task 23 — Live LLM Integration

**Goal:** Replace the stub LLM with a real LLM call that uses the gateway's existing auth infrastructure. Cortex assembles its own 4-layer context and owns the conversation.

**Problem:** Auth tokens are OAuth (`sk-ant-oat01-*`) — they expire and need refresh. The gateway's `runEmbeddedPiAgent` handles this but is tightly coupled to the agent session system. Raw `fetch()` to Anthropic won't work (auth failure after token expiry, as discovered during Router debugging).

**Approach:** Create a Cortex-specific LLM caller that uses the gateway's auth profile resolution and provider SDK internally.

**File:** `src/cortex/llm-caller.ts`

**Research needed:**
- How `runEmbeddedPiAgent` resolves auth profiles (`src/agents/pi-embedded-runner/run.ts`)
- How the Anthropic SDK is initialized with auth tokens (`src/agents/pi-embedded-runner/`)
- How token refresh/rotation works (`src/agents/chutes-oauth.ts`, auth profile rotation)
- How `createSystemPromptOverride` works — Cortex needs to inject its assembled context as the system prompt

**Functions:**
```ts
interface CortexLLMCaller {
  (context: AssembledContext): Promise<string>;
}

// Create a real LLM caller using gateway auth infrastructure
createGatewayLLMCaller(params: {
  agentId: string;
  agentDir: string;         // for auth profile resolution
  model: string;            // e.g. "claude-opus-4-6"
  maxTokens: number;
  onError: (err: Error) => void;
}): CortexLLMCaller

// Convert AssembledContext to Anthropic Messages API format
contextToMessages(context: AssembledContext): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}
```

**Context → Messages mapping:**
- System floor → `system` parameter (identity, memory, workspace)
- Background summaries → appended to system (cross-channel awareness)
- Foreground messages → `messages` array (conversation history)
- The trigger message → last `user` message

**Auth approach (in order of preference):**
1. Use `resolveAuthProfile()` from gateway internals to get a fresh token
2. Initialize Anthropic SDK with the resolved token (same as `runEmbeddedPiAgent`)
3. If token expired mid-call, retry with refreshed token (profile rotation)

**Fallback:** If auth fails, fall back to `NO_REPLY` (same as shadow mode) — don't break the conversation.

**Unit tests:** `src/cortex/__tests__/llm-caller.test.ts`
- `contextToMessages` correctly maps system floor → system
- `contextToMessages` correctly maps foreground → messages
- `contextToMessages` includes background summaries in system
- Stub provider returns expected response format
- Auth failure → fallback to NO_REPLY
- Token refresh on 401 retry

**E2E tests:** `src/cortex/__tests__/e2e-llm-caller.test.ts`
- Full pipeline: enqueue message → context assembly → real LLM call (mocked provider) → response extracted
- Context layers correctly assembled: system floor loaded from workspace files, foreground from session history, background from other channels
- Multi-turn: send 3 messages, verify context includes prior turns in foreground layer
- Cross-channel context: message on webchat with prior WhatsApp messages → background summary present in system prompt
- LLM timeout: callLLM exceeds timeout → message marked failed, bus not stuck, next message processes
- LLM returns empty string → treated as NO_REPLY (silence), message marked completed
- Auth profile rotation: first call fails 401, second call with rotated profile succeeds → response returned
- Fallback cascade: all auth profiles fail → NO_REPLY returned, message marked completed (not failed)
- Large context: 100+ messages in session → context correctly budget-trimmed, oldest messages dropped first
- Concurrent safety: two messages enqueued rapidly → processed serially (loop serialization preserved)

---

### Task 24 — Webchat Live Delivery

**Goal:** Wire the webchat adapter's `send()` to deliver Cortex responses through the WebSocket to the connected client.

**Problem:** Webchat uses a request/response pattern: `chat.send` → ack with `runId` → client watches `agentRun.announce`. Cortex processes asynchronously (bus → loop → LLM → output), so the response arrives after the initial request handler returns.

**File:** Modify `src/cortex/gateway-bridge.ts` + `src/gateway/server-methods/chat.ts`

**Approach:**

1. **Store WebSocket context globally** — when the gateway starts, expose a `sendToWebchat(content: string, runId?: string)` function via `globalThis` that can push messages to connected webchat clients.

2. **Wire webchat adapter** — during Cortex init in `gateway-bridge.ts`, create the `WebchatAdapter` with a `sendFn` that calls `sendToWebchat`.

3. **Response delivery options (research needed):**
   - Option A: Use the existing `agentRun.announce` system — Cortex creates a fake agent run ID, client watches it
   - Option B: Use WebSocket broadcast to push the response directly to the connected client
   - Option C: Use the reply dispatcher system (`createReplyDispatcher`) to deliver through the existing channel

**Key integration point in `chat.ts`:**
```ts
const mode = getCortexChannelMode("webchat");

if (mode === "live") {
  // Acknowledge the message with a runId
  respond(true, { runId: clientRunId });

  // Feed to Cortex — it will process and deliver asynchronously
  feedCortex(mkEnvelope({
    channel: "webchat",
    sender: { id: "webchat-user", name: "Partner", relationship: "partner" },
    content: parsedMessage,
    priority: "urgent",
    replyContext: { channel: "webchat", runId: clientRunId },
  }));

  return; // Don't run dispatchInboundMessage
}
```

**Key files to study:**
- `src/gateway/server-methods/chat.ts` — how `respond()` and `agentRun.announce` work
- `src/gateway/server-context.ts` — how WebSocket connections are tracked
- `src/gateway/server-startup.ts` — how the gateway context is initialized
- `src/auto-reply/dispatch.ts` — how the reply dispatcher delivers responses

**Unit tests:** `src/cortex/__tests__/webchat-delivery.test.ts`
- Live mode: `dispatchInboundMessage` NOT called
- Live mode: message fed to Cortex bus
- Live mode: response delivered through WebSocket
- Fallback: if Cortex delivery fails, error logged (not crash)

**E2E tests:** `src/cortex/__tests__/e2e-live-delivery.test.ts`
- Full pipeline: webchat message → Cortex bus → LLM (stub) → response → webchat adapter send() called with correct content
- Response format: adapter receives OutputTarget with channel="webchat", content=LLM response, replyTo=original message context
- Silence handling: LLM returns NO_REPLY → adapter send() NOT called, message marked completed
- Cross-channel output: LLM response contains `[[send_to:whatsapp]]` → WhatsApp adapter send() called, NOT webchat
- Multi-target: LLM response targets both webchat and WhatsApp → both adapters receive their content
- Error recovery: webchat adapter send() throws → error logged, message marked failed, bus continues processing next message
- RunId propagation: replyContext.runId from chat.ts flows through bus → output → adapter sendFn (for WebSocket delivery matching)
- Timing: message enqueue → delivery callback completes within <2s (with stub LLM), no stalls
- Sequential delivery: 3 rapid messages → responses delivered in same order as input (FIFO preserved)
- Adapter unavailable: webchat adapter.isAvailable() returns false → message queued in pending_ops, not dropped

---

### Task 25 — Handler Bypass & Integration

**Goal:** When webchat is in `live` mode, the old `dispatchInboundMessage` pipeline is skipped entirely. Cortex handles the full message lifecycle.

**File:** `src/gateway/server-methods/chat.ts`

**Changes:**
1. Early return in `chat.ts` when mode is "live" (after feeding to Cortex)
2. Cortex's `replyContext` includes enough info to deliver back (WebSocket connId, runId)
3. Agent session (`agent:main:webchat:*`) stops receiving new messages — Cortex's unified session takes over
4. Existing features that must still work in live mode:
   - `/` commands (should these bypass Cortex? Probably yes)
   - Abort signals (client cancels mid-generation)
   - Tool events (if Cortex supports tool use)

**Edge cases:**
- Mode switches mid-conversation (`live` → `off`): next message goes through old handler, Cortex stops
- Rapid mode switch (`live` → `shadow` → `live`): no double-processing
- Gateway restart in live mode: Cortex recovery picks up, old handler stays bypassed

**Unit tests:** `src/cortex/__tests__/handler-bypass.test.ts`
- Mode "live" → `dispatchInboundMessage` not called
- Mode "off" → `dispatchInboundMessage` called, Cortex not involved
- Mode "shadow" → both systems run
- `/` commands still work in live mode
- Mode switch mid-session doesn't lose messages

**E2E tests:** `src/cortex/__tests__/e2e-live-integration.test.ts`

*Full round-trip integration tests — simulate the complete flow from inbound message to outbound delivery:*

- **Happy path:** webchat message → mode check ("live") → feed to Cortex → bus enqueue → loop dequeue → context assembly (SOUL.md + session history) → LLM call → parse response → output router → webchat adapter send → verify delivered content matches LLM output
- **Shadow vs Live divergence:** same message processed in both modes → shadow: old handler runs + Cortex observes silently; live: old handler skipped, Cortex delivers response. Verify NO double delivery.
- **Mode hot-switch live→shadow:** send message in live mode (Cortex delivers), change config to shadow, send next message → old handler delivers, Cortex only observes. No restart needed.
- **Mode hot-switch shadow→live:** reverse of above — first message through old handler, config change, second message through Cortex. Verify session continuity (Cortex has history from shadow observation).
- **Gateway restart recovery:** Cortex has 3 completed + 1 pending message in bus → simulate restart → Cortex recovers, pending message reprocessed, completed messages not reprocessed
- **Slash command passthrough:** `/status` sent in live mode → NOT fed to Cortex, handled by existing command system. Regular message after → fed to Cortex normally.
- **Abort signal:** message being processed by LLM (slow stub) → abort signal fired → current processing cancelled, message marked failed with "aborted", next message processes normally
- **Multi-channel isolation:** webchat in "live", WhatsApp in "shadow" → webchat message goes through Cortex pipeline end-to-end; WhatsApp message goes through old handler + shadow observation. No cross-contamination.
- **Error cascade protection:** LLM call throws → message marked failed → next message still processes → bus doesn't get stuck. Verify with 5 messages where #2 fails: 1=completed, 2=failed, 3-5=completed.
- **Config file missing:** delete `cortex/config.json` → all channels fall back to "off" mode → old handler processes everything, no crash
- **Config file corrupt:** invalid JSON in config → treated as disabled → old handler processes, error logged
- **Empty message:** empty string sent via webchat → Cortex receives it, LLM processes, no crash regardless of response
- **Concurrent WebSocket clients:** two webchat tabs open → message from tab A delivered back to tab A (via runId matching), not broadcast to tab B

---

### Implementation Order (Phase 7)

```
Task 23 (LLM caller)     → standalone, testable independently
Task 24 (delivery)        → needs gateway context research
Task 25 (bypass)          → depends on 23 + 24
```

**⚠️ SAFETY: Same rollback applies.**
If live mode breaks on webchat: change `cortex/config.json` → `"webchat": "shadow"` or `"off"`.
Config is hot-reloaded. Next message falls back to old system. No restart needed.

**Key risk:** Task 23 (auth integration). If we can't cleanly call the LLM with gateway auth, the whole live mode is blocked. Research auth profile resolution first before coding.

**Estimated scope:** 3 tasks, ~3 new/modified files, ~20 unit tests, ~35 E2E test scenarios (3 E2E test files).

---

## Progress Log

| Date | What | Commit |
|------|------|--------|
| 2026-02-26 | Tasks 1–14: standalone Cortex (212 tests) | `25408b8` |
| 2026-02-26 | Task 15: gateway integration, shadow mode | `c42d179` |
| 2026-02-26 | Tasks 16–22: E2E tests (241 total) | `2d05814` |
| 2026-02-26 | Wire webchat shadow feed | `8006a4f` |
| 2026-02-26 | Fix: globalThis for feedCortex (bundler dynamic import) | `3b5a164` |
| 2026-02-26 | Shadow mode validated: 14+ messages, 0 errors | — |
| 2026-02-26 | Tasks 23–25 planned (live mode) | — |

---

## Phase 8: Cortex Delegation via Router

*Added: 2026-02-26 — Revised: 2026-02-27*

### Design Decision

**Cortex is the conversational brain. The Router is its hands.**

Cortex does not get a full tool suite. It gets exactly **one tool: `sessions_spawn`**. When Cortex needs to do anything beyond talking — research, file ops, computation, web search — it delegates to the Router via `sessions_spawn`. The Router evaluates complexity, selects the right model tier, executes, and delivers the result back to Cortex as a new inbound message through the sub-agent internal channel.

This keeps Cortex:
- **Responsive** — never blocked by long-running tasks
- **Context-clean** — no tool call chains filling the window
- **Focused** — single responsibility: understand the user, decide what to do, communicate

The Router handles everything else with appropriate model selection (Haiku for simple lookups, Sonnet for reasoning, Opus for complex tasks). Cortex and Router are complementary, not competing.

```
User message
     ↓
 Cortex LLM (light, fast — one tool: sessions_spawn)
     ↓ if task needed
 sessions_spawn → Router
     ↓ evaluates complexity → picks tier → executes
 Result → sub-agent channel → Cortex bus
     ↓
 Cortex assembles response → User
```

This maps directly to architecture §6 — Router as internal channel. Cortex dispatches, notes the pending operation in session state, responds immediately ("Let me check that"), continues processing. Result arrives as a new message; Cortex delivers the answer.

---

### Task 26: sessions_spawn Tool Definition

**Goal:** Define the `sessions_spawn` tool in Anthropic tool format and pass it to the LLM in `llm-caller.ts`.

**Tool definition:**

```typescript
const SESSIONS_SPAWN_TOOL = {
  name: "sessions_spawn",
  description: `Delegate a task to the Router for execution. Use when the user's request requires
research, file operations, computation, web search, code execution, or any work
beyond conversation. The Router will select the appropriate model and execute.
Results will arrive as a follow-up message — respond to the user immediately
with an acknowledgment ("Let me look into that") then deliver the result when it arrives.`,
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Complete, self-contained description of the task to execute. Include all context needed — the executor has no access to this conversation."
      },
      mode: {
        type: "string",
        enum: ["run"],
        description: "Always 'run' — one-shot task execution"
      },
      priority: {
        type: "string",
        enum: ["urgent", "normal", "background"],
        description: "How urgently the result needs Cortex's attention. urgent = process immediately (critical alerts, time-sensitive). normal = user is waiting for the answer. background = proactive work, no one waiting."
      }
    },
    required: ["task"]
  }
};
```

**Changes:**
- `src/cortex/llm-caller.ts` — pass `tools: [SESSIONS_SPAWN_TOOL]` to the Anthropic API call
- Parse response for `tool_use` blocks in addition to `text` blocks
- Return type extended: `{ text: string; spawnTask?: string }` — text is the immediate response, spawnTask is extracted if present

**Tests:** 3 unit tests
- Tool definition included in API call
- `tool_use` block extracted correctly from response
- Pure text response still works (no regression)

---

### Task 27: Async Dispatch — Fire and Forget

**Goal:** When the LLM response includes a `sessions_spawn` call, fire it through the gateway's spawn mechanism asynchronously. Do not wait for the result.

**Flow in `loop.ts`:**

```
callLLM(context) → { text, spawnTask? }
    ↓
if spawnTask:
  → fireSpawn(spawnTask)          ← async, non-blocking
  → logPendingOp(db, spawnTask)   ← logged in session state
    ↓
route text response to channel immediately ("Let me look into that...")
```

**`fireSpawn`** enqueues the job directly into the Router's SQLite queue with `issuer = CORTEX_SESSION_KEY` and a structured payload:

```typescript
payload = {
  task: string,                          // the task description
  replyChannel: string | null,           // original user channel, or null if proactive
  resultPriority: "urgent" | "normal" | "background"  // controls bus priority on result arrival
}
```

**Priority assignment rules (set at dispatch time):**

| Trigger | `replyChannel` | `resultPriority` |
|---------|---------------|-----------------|
| User asked for it, is waiting | e.g. `"webchat"` | `"normal"` |
| Critical system / monitoring task | `null` | `"urgent"` |
| Proactive background work | `null` | `"background"` |

The LLM includes a `priority` hint in its `sessions_spawn` tool call when it can infer urgency. Otherwise defaults to `"normal"` if user-triggered, `"background"` if proactive.

**Changes:**
- `src/cortex/loop.ts` — extend turn processing to handle `{ text, spawnTask }` return shape
- `src/cortex/gateway-bridge.ts` — expose `fireSpawn(task, replyChannel, resultPriority)` via `globalThis`
- `src/cortex/session.ts` — `logPendingOp()` already defined (Task 12) — wire it here

**Tests:** 5 unit tests
- Spawn fires non-blocking — loop continues immediately
- Pending op logged in session state
- Text response delivered to channel before spawn completes
- Failed spawn does not block or crash Cortex
- Correct `resultPriority` set per trigger type (user / critical / proactive)

---

### Task 28: Router Result Ingestion via Notifier

**Goal:** When the Router completes a Cortex-issued task, deliver the result back into the Cortex bus so Cortex can respond to the user.

**How the Notifier works (verified in code):**
- `startNotifier()` listens on `routerEvents` for `job:completed` and `job:failed`
- On either event → calls `deliverResult()` → stamps `delivered_at` → emits `job:delivered` with `{ jobId, job }`
- `job.issuer` = the session key of whoever submitted the job
- `job.result` = the executor's output (JSON string)
- The Notifier does NOT push to sessions — it only emits on the EventEmitter

**Solution:** In `gateway-bridge.ts`, after Cortex initializes, subscribe to `routerEvents` for `job:delivered`. When a delivered job's `issuer` matches the Cortex session key, extract `job.result` and `job.payload` and feed the result into the Cortex bus with the correct priority.

**Flow:**

```
Cortex enqueues → payload = { task, replyChannel, resultPriority }
     ↓
Router evaluates → executes → marks completed
     ↓
Notifier: job:completed → deliverResult() → emits job:delivered { jobId, job }
     ↓ (gateway-bridge.ts listener)
if job.issuer === CORTEX_SESSION_KEY:
  parsed = JSON.parse(job.payload)
  feedCortex(createEnvelope({
    channel: "router",
    sender: { id: "router:" + jobId, relationship: "internal" },
    content: job.result,
    priority: parsed.resultPriority,   ← "urgent" | "normal" | "background"
    replyContext: {
      channel: parsed.replyChannel ?? "router"   ← null = no user channel, Cortex decides
    }
  }))
     ↓
Bus enqueues with correct priority:
  "urgent"     → front of queue → Cortex processes next regardless of other pending
  "normal"     → after urgent, before background → Serj gets answer soon
  "background" → processed at next natural pause → silent update or proactive reach-out
```

**Priority in action:**
- Serj asked Cortex to research something → result arrives `priority: "normal"` → processed after any urgent messages → Serj gets the answer
- Critical monitoring task detected a problem → result arrives `priority: "urgent"` → jumps queue → Cortex alerts Serj immediately
- Proactive background check completed → result arrives `priority: "background"` → Cortex processes it quietly, may update memory or send a proactive note

**Changes:**
- `src/cortex/gateway-bridge.ts` — subscribe to `routerEvents` on init; unsubscribe on stop; parse payload for `resultPriority` and `replyChannel`
- Import `routerEvents` from `../router/worker.js` (already exported)
- `src/cortex/adapters/internal.ts` — wire `RouterAdapter` to the Cortex instance registry in `gateway-bridge.ts` (already built in Task 7, just needs registration)

**Tests:** 5 unit tests
- `job:delivered` with `resultPriority: "urgent"` → envelope priority is `"urgent"`
- `job:delivered` with `resultPriority: "background"` → envelope priority is `"background"`
- `job:delivered` with non-matching issuer → ignored (no cross-contamination)
- `replyContext.channel` set from payload `replyChannel`; null payload → `"router"` fallback
- Pending op cleared from session state after result arrives

---

### Task 29: Dynamic Model Resolution

**Goal:** Remove hardcoded `claude-opus-4-6` from `gateway-bridge.ts`. Cortex should use the model configured for the main agent.

**Change:** One line in `gateway-bridge.ts` — read `params.cfg.agents?.defaults?.model ?? params.cfg.model` instead of hardcoding.

**Tests:** 1 unit test — model resolved from config, not hardcoded

---

### Task 30: E2E Tests — Delegation Flow

**File:** `src/cortex/__tests__/e2e-delegation.test.ts`

**Test scenarios:**
- **Direct answer:** user asks something Cortex can answer without delegation → responds immediately, no spawn fired
- **Delegation — happy path:** user asks for research → Cortex calls sessions_spawn → immediate ack delivered → result arrives via sub-agent channel → Cortex delivers final answer
- **Delegation — async:** verify text ack arrives BEFORE the spawn completes (non-blocking)
- **Pending op in context:** while task is in flight, next user message includes pending op summary in context assembly
- **Result delivered to correct channel:** spawn result routed back to same channel the original message came from
- **Failed task:** Router executor fails → error result arrives → Cortex acknowledges gracefully ("I wasn't able to complete that")

---

### Implementation Order (Phase 8)

```
Task 26 (tool definition)   → standalone, llm-caller.ts only
Task 29 (model resolution)  → standalone, one line
Task 27 (async dispatch)    → depends on 26
Task 28 (result ingestion)  → depends on 27
Task 30 (E2E tests)         → depends on 26-29
```

**Safety:** No new gateway files created. `subagent-announce.ts` gets a small hook (3-5 lines). `llm-caller.ts` and `loop.ts` get minor extensions. All behind `globalThis` guards — if Cortex is off, hook is a no-op.

**Estimated scope:** 5 tasks, 0 new files, ~5 modified files, ~12 unit tests, ~6 E2E scenarios.

**Expected result after Phase 8:** Cortex responds conversationally and delegates tasks to the Router. User experience: fast acknowledgment, followed by a delivered result. Cortex never blocks. Router picks the right model for every task.

---

| Date | What | Commit |
|------|------|--------|
| 2026-02-26 | Tasks 1–14: standalone Cortex (212 tests) | `25408b8` |
| 2026-02-26 | Task 15: gateway integration, shadow mode | `c42d179` |
| 2026-02-26 | Tasks 16–22: E2E tests (241 total) | `2d05814` |
| 2026-02-26 | Wire webchat shadow feed | `8006a4f` |
| 2026-02-26 | Fix: globalThis for feedCortex (bundler dynamic import) | `3b5a164` |
| 2026-02-26 | Shadow mode validated: 14+ messages, 0 errors | — |
| 2026-02-26 | Tasks 23–25: live mode (253 tests) | `1450fa1` |
| 2026-02-27 | Phase 8 redesigned: Cortex delegation via Router (sessions_spawn only) | — |

---

## Phase 9: Pending Ops Lifecycle & Op Harvester

*Added: 2026-02-28 — Completed: 2026-02-28*
*Ref: `hipocampus-architecture.md` §6 (revised)*
*Status: ✅ Complete — 341 Cortex tests passing (26 test files)*

### Context

The original design deleted pending ops on result arrival (`removePendingOp`). This lost valuable information — task results that could contain important facts scrolled out of the Foreground window and were never captured. The revised design treats pending ops as a durable memory source with a lifecycle: `pending → completed → gardened → archived`. The Gardener's new Op Harvester pass extracts facts from completed ops into Hot Memory before archiving.

---

### Task 31: Extend `cortex_pending_ops` Schema

**Goal:** Add lifecycle columns to the pending ops table so ops are never deleted, just transitioned through statuses.

**File:** `src/cortex/session.ts`

**Schema changes:**
```sql
CREATE TABLE IF NOT EXISTS cortex_pending_ops (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  expected_channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | completed | failed | gardened | archived
  completed_at TEXT,                          -- when result arrived or failure detected
  result TEXT,                                -- result content from Router, or "Error: ..." for failures
  gardened_at TEXT,                           -- when Gardener extracted facts
  acknowledged_at TEXT                        -- when LLM "read" the result/failure (inbox pattern)
);

CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON cortex_pending_ops(status);
```

**Functions (new/modified):**
```ts
// Replace removePendingOp with:
completePendingOp(db, id: string, result: string): void
  // Sets status='completed', completed_at=now, result=<text>
  // Does NOT set acknowledged_at — op stays visible until LLM reads it

failPendingOp(db, id: string, error: string): void
  // Sets status='failed', completed_at=now, result='Error: <error>'
  // Only affects ops WHERE status='pending' (won't overwrite completed ops)
  // Does NOT set acknowledged_at — failed op stays visible until LLM reads it

acknowledgeCompletedOps(db): number
  // Sets acknowledged_at=now WHERE (status='completed' OR status='failed')
  //   AND acknowledged_at IS NULL
  // Called by the loop after each LLM turn — marks results/failures as "read"
  // Returns count of ops acknowledged

// New:
getCompletedOps(db): PendingOperation[]
  // WHERE status='completed' — for Op Harvester

markOpsGardened(db, ids: string[]): void
  // Sets status='gardened', gardened_at=now

archiveOldGardenedOps(db, olderThanDays: number): number
  // Sets status='archived' for gardened ops older than N days

// Modified:
getPendingOps(db): PendingOperation[]
  // Returns ops that should appear in the System Floor:
  //   - status='pending' (still waiting)
  //   - status='completed' AND acknowledged_at IS NULL (fresh result, unread)
  //   - status='failed' AND acknowledged_at IS NULL (fresh failure, unread)
  // Acknowledged ops drop from results (inbox "read" pattern)
```

**System Floor formatting** (in `context.ts`):
- `status='pending'` → `[PENDING] [type] description (dispatched: time) — awaiting result`
- `status='completed'` → `[NEW RESULT] [type] description — Result: <truncated>`
- `status='failed'` → `[FAILED] [type] description — Error: detail. Inform the user that this task failed.`

**Migration:** Add columns with ALTER TABLE if table exists (backwards-compatible). New installs get the full schema. Existing rows without `status` default to `'pending'`.

**Tests:** 8 unit tests + 6 failPendingOp tests
- `completePendingOp` sets status, completed_at, result
- `getCompletedOps` returns only status='completed'
- `markOpsGardened` transitions completed → gardened
- `archiveOldGardenedOps` only archives ops older than threshold
- `getPendingOps` returns pending + unacknowledged completed + unacknowledged failed
- Migration: existing table gains new columns without data loss
- Round-trip: add → complete → garden → archive lifecycle
- Completed op result text preserved through full lifecycle
- `failPendingOp` marks op as failed but keeps it visible in getPendingOps
- `failPendingOp` sets status, completed_at, result='Error: ...', but NOT acknowledged_at
- Failed ops drop from getPendingOps after acknowledgeCompletedOps
- `failPendingOp` only affects pending ops (does not overwrite completed ops)
- `failPendingOp` is a no-op for non-existent ops
- Both failed and pending ops stay visible simultaneously

---

### Task 32: Replace `removePendingOp` with Lifecycle-Based Completion/Failure

**Goal:** Update all callsites that delete pending ops to instead transition them through the lifecycle. Add failure handling for Router job crashes.

**Files:**
- `src/cortex/gateway-bridge.ts` — Router result listener + failure listener + startup cleanup
- `src/cortex/session.ts` — Deprecate `removePendingOp`, add `failPendingOp` and `acknowledgeCompletedOps`
- `src/router/loop.ts` — Emit `job:failed` from catch blocks (eval/dispatch failures)

**Changes in `gateway-bridge.ts`:**

1. **Result delivery** (`job:delivered` listener):
```ts
// Before:
removePendingOp(instance.db, jobId);

// After:
completePendingOp(instance.db, jobId, content);
```

2. **Failure handling** (`job:failed` listener — NEW):
```ts
const onJobFailed = ({ jobId, error }) => {
  failPendingOp(instance.db, jobId, error);
};
routerEvents.on("job:failed", onJobFailed);
```

3. **Startup cleanup** (NEW):
```ts
// On startup, fail any orphaned pending ops from prior crashes
const orphaned = getPendingOps(instance.db).filter((op) => op.status === "pending");
for (const op of orphaned) {
  failPendingOp(instance.db, op.id, "orphaned from prior session (startup cleanup)");
}
```

**Changes in `loop.ts` (Router):**
```ts
// In catch blocks for eval/dispatch failures:
routerEvents.emit("job:failed", { jobId: job.id, error: errorMessage });
```
Previously, `job:failed` was only emitted from `worker.ts` (worker-level failures). Now it's also emitted from `loop.ts` when the evaluator or dispatcher crashes — these are loop-level failures that the worker never sees.

**Tests:** 3 + 6 + 4 unit tests
- Router result arrival → op status transitions to 'completed' (not deleted)
- Op result text matches the Router's delivered content
- Op remains visible in System Floor context after completion (unacknowledged)
- `failPendingOp` marks op as failed, keeps visible until acknowledged
- Failed ops drop after `acknowledgeCompletedOps`
- `failPendingOp` is no-op for non-existent or already-completed ops
- Both failed and pending ops visible simultaneously
- Startup cleanup: orphaned ops marked failed, stay visible
- Acknowledged ops disappear from System Floor
- `job:failed` emitted when dispatch throws (loop.ts)
- `job:failed` emitted when evaluator throws (loop.ts)
- `job:failed` emitted when retry dispatch throws (loop.ts)
- `job:failed` NOT emitted on successful dispatch

---

### Task 33: Op Harvester — Gardener Pass

**Goal:** Add a new Gardener task that extracts facts from completed pending ops into Hot Memory.

**File:** `src/cortex/gardener.ts`

**Function:**
```ts
runOpHarvester(params: {
  db: DatabaseSync;
  extractLLM: FactExtractorLLM;
}): Promise<{ processed: number; errors: Error[] }>
```

**Algorithm:**
1. `getCompletedOps(db)` — fetch all ops with `status = 'completed'`
2. For each op, build a prompt: `"Extract persistent facts from this task and its result:\n\nTask: ${op.description}\n\nResult: ${op.result}"`
3. Call `extractLLM(prompt)` — returns JSON array of fact strings
4. Insert each fact into `cortex_hot_memory` via `insertHotFact(db, { factText })`
5. `markOpsGardened(db, [op.id])`

**Wire into Gardener:** Add `runOpHarvester` to the Gardener's `runAll()` cycle, gated by `hippocampusEnabled`. Runs at same cadence as Fact Extractor (every 6h).

**Tests:** 5 unit tests
- Completed op → facts extracted into hot memory
- Multiple completed ops → all processed in one pass
- LLM returns empty array → op still marked gardened (no facts, but processed)
- LLM error on one op → others still processed, error logged
- Already-gardened ops not re-processed

---

### Task 34: Archival Cleanup

**Goal:** Gardened ops older than 7 days are archived (zero token cost). Runs as part of the weekly Vector Evictor pass.

**File:** `src/cortex/gardener.ts`

**Changes:** Add `archiveOldGardenedOps(db, 7)` call to the Vector Evictor's `runAll()` cycle.

**Tests:** 2 unit tests
- Gardened ops older than 7 days → archived
- Gardened ops newer than 7 days → untouched

---

### Task 35: E2E — Op Lifecycle

**File:** `src/cortex/__tests__/e2e-op-lifecycle.test.ts`

**Scenarios (10 tests):**
- **Full lifecycle:** dispatch op → result arrives → op completed → Gardener extracts facts → facts in hot memory → op archived
- **System Floor visibility:** pending op shows `[PENDING]` → completed op shows `[NEW RESULT]` → acknowledged op not visible → gardened/archived not visible
- **Fact persistence:** extracted facts survive op archival (they live in hot memory independently)
- **Multiple concurrent ops:** 3 ops dispatched → results arrive in different order → all correctly completed and harvested
- **Op Harvester error isolation:** LLM error on one op → others still processed, error logged
- **Acknowledge inbox pattern:** fresh completed results visible → `acknowledgeCompletedOps()` → gone from getPendingOps but still in DB for Op Harvester
- **Failed ops stay visible until acknowledged:** pending op + failed op both visible → `[FAILED]` shown in System Floor with error → acknowledged after LLM turn → gone
- **Startup cleanup:** orphaned pending ops marked failed but stay visible for one LLM turn so user is informed
- **Failed ops don't interfere with new ops:** old failed ops acknowledged → new op completes normally → Gardener harvests only the new op
- **Archive threshold:** gardened ops older than 7 days archived, newer ones untouched

---

### Implementation Order (Phase 9)

```
Task 31 (schema)        → standalone, session.ts only
Task 32 (replace remove) → depends on 31
Task 33 (op harvester)   → depends on 31
Task 34 (archival)       → depends on 33
Task 35 (E2E)            → depends on 31-34
```

**Safety:** No new gateway files. All changes in `src/cortex/`. Schema migration is backwards-compatible (ALTER TABLE ADD COLUMN). Existing ops default to `status = 'pending'`.

**Estimated scope:** 5 tasks, 0 new files (except E2E test), ~4 modified files, ~18 unit tests, ~4 E2E scenarios.

---

| Date | What | Commit |
|------|------|--------|
| 2026-02-28 | Phase 9 planned: pending ops lifecycle + Op Harvester | — |
| 2026-02-28 | Tasks 31–35 implemented: schema, completePendingOp, failPendingOp, acknowledgeCompletedOps, Op Harvester, archival, E2E tests (341 Cortex tests, 10 op-lifecycle E2E) | — |
| 2026-02-28 | Bug fix: Router job failures left ghost `[PENDING]` entries forever — added `failPendingOp`, `job:failed` events from loop.ts, startup orphan cleanup in gateway-bridge.ts | — |
| 2026-02-28 | Design fix: failed ops now stay visible (unacknowledged) so LLM can inform user, then acknowledged after LLM turn (inbox read/unread pattern) | — |
| 2026-02-28 | Phase 10 implemented: issuer-owned task IDs, clean channel routing, `getPendingOpById`, 7 E2E tests (`e2e-task-ownership.test.ts`) | — |

---

*All tests use Vitest. SQLite via `node:sqlite` (DatabaseSync). No external dependencies beyond what OpenClaw already uses.*


---
## Cortex Tool Support via Router

**Goal:** Give Cortex (webchat=live) tool execution capability via Router sessions_spawn.

**Approach: Option A � Router Bridge**
- Cortex detects tool-requiring requests
- Spawns a Router session (sessions_spawn) for execution
- Returns results through webchat
- Reuses existing tool infrastructure

**Steps:**
1. Confirm Router API is accessible from Cortex handler
2. Add sessions_spawn call support in Cortex message handler
3. Wire tool call ? Router session ? result ? webchat response loop
4. Test end-to-end (bash, file read/write)
5. Security review

**Status:** Planning

---

## Phase 10: Issuer-Owned Task IDs & Clean Channel Routing

*Added: 2026-02-28*
*Status: ✅ Complete — Tasks 36–39 implemented, 7 E2E tests passing*

### Problem

Two bugs discovered during live webchat testing:

**Bug 1 — Stale foreground context drowns fresh results:**
When a Router result arrives, `gateway-bridge.ts` creates the result envelope with `channel: "router"` (hardcoded). The loop processes it, and `assembleContext()` calls `buildForeground(db, "router", budget)` — which fetches ALL historical router channel messages as the foreground. After multiple sessions, the LLM sees dozens of old results plus one fresh one and dismisses everything as "old Router results from previous sessions."

The `replyChannel` (e.g. `"webchat"`) is parsed correctly from the job payload but only used in `replyContext`, not as the envelope's `channel`. The foreground should show the user's webchat conversation (where the original question was asked), not the router history.

**Bug 2 — Cortex metadata leaks into Router payload:**
The Cortex serializes its own internal state (`replyChannel`, `resultPriority`) into the Router job's `payload.context` field. The Router carries this data, doesn't understand it, doesn't use it, and passes it back untouched. Then `gateway-bridge.ts` parses the Router's payload to recover Cortex's own metadata. This is architecturally wrong — Cortex state should live in Cortex's own tables.

**Bug 3 — Race condition on task ID generation:**
Currently the Router generates the job UUID internally (`queue.ts:enqueue()`), and the Cortex stores the pending op only AFTER getting the ID back:
```
const jobId = onSpawn(...)  // → router.enqueue() generates UUID, returns it
if (jobId) addPendingOp(db, { id: jobId, ... })  // ← only now recorded
```
If `router.enqueue()` succeeds but the return path fails (process crash, exception between enqueue and addPendingOp), the Router has a running job and the Cortex has no record of it. Result arrives later, no matching task — dropped silently.

### Design Decision: Issuer Owns the Task ID

The issuer (Cortex) generates the task ID, not the Router. The Router is a dumb executor — it receives a task with an ID and executes it.

**Cortex side:**
1. Generate UUID for the task
2. Store pending op in `cortex_pending_ops` **immediately** — before touching the Router
3. Store all Cortex metadata locally: `reply_channel`, `result_priority`, `description`
4. Hand the Router only: `{ taskId, message, issuer }`

**Router side:**
1. Receive `{ taskId, message, issuer }` — use the provided `taskId` as the job ID
2. Execute the task. Don't parse or care about Cortex metadata.
3. On completion/failure, fire event: `{ taskId, issuer, result/error }`

**Back in Cortex:**
1. Receive event with `taskId`
2. Look up `cortex_pending_ops` by `taskId`
3. Read `reply_channel`, `result_priority` from its own table
4. Create result envelope with `channel = reply_channel` (not `"router"`)

This eliminates all three bugs:
- **Bug 1:** Result envelope gets `channel = reply_channel` (e.g. `"webchat"`) → foreground shows user's conversation
- **Bug 2:** No Cortex metadata in Router payload — Cortex reads from its own `cortex_pending_ops` table
- **Bug 3:** Pending op is written BEFORE the Router is called — if the Router call fails, the orphan cleanup (startup) handles it

### Schema Changes

**`cortex_pending_ops` — add columns:**
```sql
ALTER TABLE cortex_pending_ops ADD COLUMN reply_channel TEXT;      -- "webchat", "whatsapp", etc.
ALTER TABLE cortex_pending_ops ADD COLUMN result_priority TEXT;    -- "urgent" | "normal" | "background"
```

**Router `queue.ts:enqueue()` — accept optional `taskId`:**
```ts
// Before:
enqueue(type, payload, issuer) → jobId  // generates UUID internally

// After:
enqueue(type, payload, issuer, taskId?) → jobId  // uses provided taskId if given, else generates UUID
```

### Task 36: Cortex Generates Task ID & Stores Metadata Locally ✅

**Goal:** Cortex generates the UUID, writes pending op with all metadata BEFORE calling the Router.

**Changes:**
- `src/cortex/loop.ts` — generate UUID, call `addPendingOp()` with `reply_channel` and `result_priority` BEFORE `onSpawn()`
- `src/cortex/session.ts` — extend `addPendingOp` to accept and store `reply_channel`, `result_priority`
- `src/cortex/gateway-bridge.ts` — `onSpawn` passes the Cortex-generated `taskId` to `router.enqueue()`; remove `replyChannel`/`resultPriority` from Router payload
- `src/cortex/types.ts` — extend `PendingOperation` interface with `replyChannel?` and `resultPriority?`

**Tests:** 4 unit tests
- Pending op written BEFORE Router enqueue is called
- Pending op contains `reply_channel` and `result_priority`
- Router payload contains only `{ message }`, no Cortex metadata
- If Router enqueue fails, pending op still exists (orphan cleanup handles it)

---

### Task 37: Router Accepts Caller-Provided Task ID ✅

**Goal:** `queue.ts:enqueue()` accepts an optional `taskId` and uses it instead of generating a UUID.

**Changes:**
- `src/router/queue.ts` — `enqueue(type, payload, issuer, taskId?)` — use `taskId ?? crypto.randomUUID()`

**Tests:** 2 unit tests
- Provided `taskId` → job stored with that exact ID
- No `taskId` → UUID generated as before (backwards-compatible)

---

### Task 38: Result Ingestion Reads Cortex Metadata from Local Table ✅

**Goal:** When a Router result arrives, read `reply_channel` and `result_priority` from `cortex_pending_ops` instead of parsing the Router job payload.

**Changes:**
- `src/cortex/gateway-bridge.ts` — in `onJobDelivered`:
  1. Look up pending op by `jobId` in `cortex_pending_ops`
  2. Read `reply_channel` and `result_priority` from the op
  3. Create result envelope with `channel = op.reply_channel ?? "router"`
  4. Remove payload context parsing (no more `JSON.parse(payload.context)`)
- `src/cortex/session.ts` — add `getPendingOpById(db, id)` function

**Tests:** 4 unit tests
- Result envelope gets `channel` from pending op's `reply_channel`
- `result_priority` read from pending op, not from payload
- Missing pending op (edge case) → falls back to `channel: "router"`, `priority: "normal"`
- No `JSON.parse(payload.context)` — Router payload is opaque to result ingestion

---

### Task 39: E2E — Issuer-Owned Task IDs ✅

**File:** `src/cortex/__tests__/e2e-task-ownership.test.ts`

**Scenarios:**
- **Happy path:** User asks on webchat → Cortex generates UUID → writes pending op with `reply_channel: "webchat"` → Router executes → result arrives → envelope has `channel: "webchat"` → foreground shows webchat conversation → LLM responds naturally
- **Router failure after pending op written:** Cortex writes pending op → Router enqueue throws → pending op exists as orphan → startup cleanup marks it failed → user informed
- **Foreground context correctness:** Result arrives → `buildForeground(db, "webchat")` → returns user's webchat messages, NOT old router results
- **Backwards compatibility:** Router enqueue without taskId still generates UUID (non-Cortex callers unaffected)

---

### Implementation Order (Phase 10)

```
Task 37 (Router accepts taskId)  → standalone, backwards-compatible
Task 36 (Cortex generates ID)    → depends on 37
Task 38 (result reads local)     → depends on 36
Task 39 (E2E)                    → depends on 36-38
```

**Safety:** Router change (Task 37) is backwards-compatible — existing callers that don't pass `taskId` work as before. Cortex changes are internal to `src/cortex/`. No new gateway files.

**Estimated scope:** 4 tasks, 1 new E2E test file, ~5 modified files, ~10 unit tests, ~4 E2E scenarios.
