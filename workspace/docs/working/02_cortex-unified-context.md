# Cortex Unified Context — Cross-Channel Fix

*Created: 2026-03-10*
*Status: Not Started*
*Ref: `docs/cortex-architecture.md`, `docs/foreground-sharding-architecture.md`*

---

## Problem

Cortex is designed as a **single cognitive core** — one brain, multiple input/output channels. But the context assembly pipeline treats each channel as a separate conversation. When a user messages on WhatsApp, those messages are invisible to the webchat context, and vice versa.

**Expected:** All messages from all channels merge into one unified session. Channel is metadata on each message. One conversation, multiple pipes.

**Actual:** Each channel has its own isolated conversation thread. Cross-channel context requires manual `fetch_chat_history` calls — partial, delayed, not in foreground.

---

## Root Cause

The context pipeline filters by `channel` instead of `issuer` at every layer. The `issuer` field already exists in `cortex_session` and is set correctly on every message — but the query layer ignores it when sharding is enabled.

---

## Found Issues

### Issue 1: `assembleContext()` bypasses issuer path when sharding is enabled

**File:** `src/cortex/context.ts`, function `assembleContext()` (~line 340)

```typescript
if (foregroundConfig) {
  // Sharded path — ALWAYS filters by channel, ignores issuer
  const result = buildShardedForeground(db, triggerEnvelope.channel, foregroundConfig);
} else {
  // Legacy path — CAN filter by issuer (already works)
  const result = issuer
    ? buildForeground(db, issuer, remainingBudget)
    : buildForeground(db, triggerEnvelope.channel, remainingBudget, { filterByChannel: true });
}
```

When `foregroundConfig` is set (sharding enabled — which it is in production config), the `issuer` parameter is completely ignored. The sharded path always calls `buildShardedForeground(db, triggerEnvelope.channel, ...)` which scopes to the current channel only.

**Fix:** Pass `issuer` to the sharded path. When `issuer` is set, `buildShardedForeground` should query by issuer instead of channel.

---

### Issue 2: `buildShardedForeground()` is channel-scoped

**File:** `src/cortex/context.ts`, function `buildShardedForeground()` (~line 175)

```typescript
export function buildShardedForeground(
  db: DatabaseSync,
  channel: string,        // ← only accepts channel, not issuer
  config: ForegroundConfig,
): { layer: ContextLayer; messages: SessionMessage[] }
```

Internally calls:
- `getActiveShard(db, channel)` — queries `WHERE channel = ?`
- `getClosedShards(db, channel)` — queries `WHERE channel = ?`
- `getUnshardedMessages(db, channel)` — queries `WHERE channel = ?`

All three functions are in `src/cortex/shards.ts` and filter by channel.

**Fix:** Add an `issuer` parameter. When provided, all shard queries should filter by `issuer` instead of `channel`. The function signature becomes:

```typescript
export function buildShardedForeground(
  db: DatabaseSync,
  config: ForegroundConfig,
  opts: { channel?: string; issuer?: string },
): { layer: ContextLayer; messages: SessionMessage[] }
```

---

### Issue 3: Shard functions in `shards.ts` are all channel-filtered

**File:** `src/cortex/shards.ts`

The following functions all take `channel: string` and query `WHERE channel = ?`:

1. **`getActiveShard(db, channel)`** — finds the active (open) shard for a channel
2. **`getClosedShards(db, channel)`** — lists closed shards for a channel, newest first
3. **`getUnshardedMessages(db, channel)`** (in `context.ts`) — finds messages with no `shard_id` for a channel
4. **`assignMessageWithBoundaryDetection(db, messageId, channel, ...)`** — assigns incoming messages to shards, scoped by channel

**Fix:** Each function needs an alternative filter path. When `issuer` is provided, query `WHERE issuer = ?` on the `cortex_session` table instead of `WHERE channel = ?`. Shards should be scoped by issuer, not channel.

---

### Issue 4: Shard assignment in `loop.ts` uses channel

**File:** `src/cortex/loop.ts` (~line 160)

```typescript
const assignedShardId = assignMessageWithBoundaryDetection(
  db, messageId, msg.envelope.channel, appendedContent,
  msg.envelope.timestamp, foregroundConfig,
);
```

Shards are created and assigned per channel. A WhatsApp shard and a webchat shard are separate objects, even when they're part of the same conversation from the same user.

**Fix:** Pass `issuer` instead of (or in addition to) `channel`. Shards should span channels when the issuer is the same. A topic that starts on WhatsApp and continues on webchat should be one shard.

---

### Issue 5: `getUnshardedMessages()` in `context.ts` filters by channel

**File:** `src/cortex/context.ts`, function `getUnshardedMessages()` (~line 259)

```typescript
function getUnshardedMessages(
  db: DatabaseSync,
  channel: string,
): { ... }[] {
  const rows = db.prepare(`
    SELECT id, content, timestamp, role, channel, sender_id
    FROM cortex_session
    WHERE channel = ? AND shard_id IS NULL
    ORDER BY timestamp ASC, id ASC
  `).all(channel);
```

**Fix:** Accept issuer parameter, query `WHERE issuer = ? AND shard_id IS NULL` when provided.

---

### Issue 6: `buildBackground()` excludes only current channel

**File:** `src/cortex/context.ts`, function `buildBackground()` (~line 310)

```typescript
export function buildBackground(
  db: DatabaseSync,
  excludeChannel: ChannelId,
  ...
)
```

Background layer shows summaries of "other channels." But in a unified context model, all channels are in the foreground — there is no "other channel." The background layer becomes empty/meaningless.

**Fix:** When using issuer-based context, skip the background layer entirely (or repurpose it for non-conversation context like system notifications).

---

### Issue 7: Shard topic detection won't span channel boundaries

**File:** `src/cortex/shards.ts`, `detectTopicShift()` and `assignMessageWithBoundaryDetection()`

Topic boundary detection (Tier 1: time gap + token count; Tier 2: semantic Haiku check) operates within a single channel's shard. If the user switches from WhatsApp to webchat mid-topic, the system sees it as a new shard in a new channel rather than a continuation.

**Fix:** With issuer-based shards, messages from both channels flow into the same shard. Topic detection naturally spans channels because it operates on the shard's message sequence, not the channel's.

---

## Data Model

The `cortex_session` table already has the required fields:

```sql
CREATE TABLE cortex_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant'
  channel TEXT NOT NULL,        -- 'whatsapp' | 'webchat' | 'router' | ...
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  issuer TEXT,                  -- ← already exists, set on every message
  shard_id TEXT                 -- ← shard assignment
);
```

The `issuer` column is populated by `appendToSession()` in `session.ts`. Default value: `agent:main:cortex`. No schema changes needed.

The `shards` table:

```sql
CREATE TABLE shards (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,        -- ← currently required, should become optional/metadata
  topic TEXT DEFAULT 'unknown',
  first_message_id INTEGER,
  last_message_id INTEGER,
  token_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT DEFAULT 'active'  -- 'active' | 'closed'
);
```

**Schema change needed:** The `shards` table uses `channel` as a required field and as a query filter. Options:
1. Replace `channel` with `issuer` in the shards table
2. Keep `channel` as metadata but add `issuer` column and filter on that
3. Remove the channel filter from queries, let shards be channel-agnostic

**Recommendation:** Option 2 — add `issuer` column to `shards` table, keep `channel` as metadata for display (shard separators show `[Topic: X | whatsapp+webchat | 5min ago]`). Query by `issuer`.

---

## Files to Change

| File | What |
|------|------|
| `src/cortex/context.ts` | `assembleContext()` — pass issuer to sharded path |
| `src/cortex/context.ts` | `buildShardedForeground()` — accept issuer, query by issuer |
| `src/cortex/context.ts` | `getUnshardedMessages()` — accept issuer filter |
| `src/cortex/context.ts` | `buildBackground()` — skip when issuer-based context |
| `src/cortex/shards.ts` | `getActiveShard()` — support issuer filter |
| `src/cortex/shards.ts` | `getClosedShards()` — support issuer filter |
| `src/cortex/shards.ts` | `assignMessageWithBoundaryDetection()` — use issuer |
| `src/cortex/loop.ts` | Shard assignment call — pass issuer instead of channel |
| `src/cortex/session.ts` | No changes needed — `issuer` already set ✅ |

**Schema migration:** Add `issuer` column to `shards` table.

---

## Test Criteria

1. **Cross-channel visibility:** Send message on WhatsApp, verify it appears in Cortex context when triggered from webchat
2. **Shard spanning:** Start topic on WhatsApp, continue on webchat — verify both messages are in the same shard
3. **Topic detection:** Verify semantic topic shift detection works across channel boundaries
4. **Token budget:** Verify sharding token cap still works with cross-channel messages
5. **Background layer:** Verify background layer is empty/skipped when using issuer-based context
6. **Backward compat:** When `issuer` is not set, fall back to channel-based filtering (existing behavior)
7. **Display:** Shard separators show channel info as metadata: `[Topic: X | via whatsapp, webchat]`
8. **Existing tests:** All 43 foreground sharding tests still pass (they test channel-based path)
