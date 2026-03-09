# Foreground Sharding — Implementation Plan

*Created: 2026-03-09*
*Ref: `docs/foreground-sharding-architecture.md`*
*Status: Not Started*

---

## Why

Cortex context hit 200K tokens on 2026-03-09 and died. Raw `cortex_session` grows unbounded. The foreground soft cap was disabled because a message-count cut is dumb — it chops mid-conversation. Sharding solves this: cut at topic boundaries, never mid-conversation.

---

## Phase 1: Schema + Heuristic Boundary Detection

**Goal:** Messages get `shard_id` on arrival. Time gaps and token overflow close shards automatically. No context assembly changes yet — shards exist but aren't consumed.

### Tasks

**1.1 — Schema migration**
- Add `cortex_shards` table (see architecture doc §3.1)
- Add `shard_id TEXT` column to `cortex_session`
- Add index on `cortex_session.shard_id`
- Migration runs on startup, idempotent
- **File:** `src/cortex/db.ts` (or wherever schema init lives)

**1.2 — Shard manager module**
- New file: `src/cortex/shards.ts`
- Functions:
  - `getActiveShard(db, channel): Shard | null` — returns the open shard (ended_at = NULL) for a channel
  - `createShard(db, channel, firstMessageId, topic?): Shard` — creates a new shard
  - `closeShard(db, shardId, lastMessageId): void` — sets `ended_at`, finalizes `token_count` and `message_count`
  - `assignMessageToShard(db, messageId, shardId): void` — sets `shard_id` on `cortex_session` row
  - `getShardTokenCount(db, shardId): number` — approximate token count (sum of message content lengths / 4)
- All functions are synchronous SQLite operations, no LLM calls

**1.3 — Inline shard assignment in the Cortex loop**
- When a message is appended to `cortex_session`, immediately assign it to the active shard
- If no active shard exists for the channel, create one
- **File:** `src/cortex/loop.ts` (after `appendToSession`)

**1.4 — Tier 1A: Time gap detection**
- Before assigning a message to the active shard, check time since last message on the channel
- If gap ≥ `timeGapMinutes` (default 25): close active shard, create new shard, assign message to new shard
- **File:** `src/cortex/shards.ts` (logic), `src/cortex/loop.ts` (integration)

**1.5 — Tier 1B: Token threshold detection**
- After assigning a message, check active shard's token count
- If ≥ `maxShardTokens` (default 8000): close active shard, create new shard for next message
- Note: the message that triggered the overflow stays in the closed shard — the split happens *after* it
- **File:** `src/cortex/shards.ts`

**1.6 — Config**
- Add `hippocampus.foreground` section to cortex config schema
- Fields: `tokenCap`, `tolerancePct`, `maxShardTokens`, `timeGapMinutes`, `semanticCheckInterval`, `semanticModel`
- Hot-reload with rest of cortex config
- **File:** `cortex/config.json`, config loading code

### Tests

- `test_schema_migration`: Table and column exist after init
- `test_create_and_close_shard`: Create → close → verify ended_at, token_count
- `test_message_assigned_on_arrival`: Append message → shard_id is set
- `test_time_gap_creates_new_shard`: Two messages 30 min apart → different shard_ids
- `test_token_overflow_splits_shard`: Fill shard past threshold → next message gets new shard
- `test_no_shard_without_hippocampus`: With `hippocampus.enabled: false`, no shard assignment (backward compat)

### Gate
All tests pass. Messages flowing through Cortex get `shard_id` assigned. Shards open and close on heuristics. Context assembly unchanged — no user-visible behavior change.

---

## Phase 2: Shard-Based Foreground Assembly

**Goal:** Replace unbounded foreground loading with the shard-based token budget. This is the actual fix for the 200K overflow.

### Tasks

**2.1 — Shard-aware foreground builder**
- New function: `buildShardedForeground(db, channel, tokenCap, tolerancePct): Message[]`
- Algorithm (architecture doc §4.2):
  1. Load active shard messages (always included)
  2. Walk backward through closed shards, include while within budget
  3. Stop when next shard would exceed cap × (1 + tolerance)
- Returns messages in chronological order with shard separators
- **File:** `src/cortex/context.ts`

**2.2 — Shard separators**
- Between shards in the assembled context, insert a lightweight separator:
  ```
  --- [Topic: <label> | ~<time ago> | <N> messages] ---
  ```
- Gives LLM topic boundary awareness without significant token cost
- If shard has no topic label yet (label pending from Tier 2), use `"Continued conversation"`
- **File:** `src/cortex/context.ts`

**2.3 — Wire into context assembly**
- When `hippocampus.foreground.tokenCap` is set, use `buildShardedForeground` instead of loading all messages
- Fallback: if no shards exist (fresh system, or hippocampus disabled), use existing unbounded loading
- **File:** `src/cortex/context.ts` (the `buildForeground` or equivalent function)

**2.4 — Handle unsharded historical messages**
- Messages from before sharding was enabled have `shard_id = NULL`
- Context assembly treats these as one implicit block, loaded after all shards
- They'll naturally age out as new sharded messages accumulate

### Tests

- `test_foreground_respects_budget`: 5 shards totaling 15K tokens, cap 8K → only latest shards included
- `test_active_shard_always_included`: Active shard alone is 12K tokens, cap is 8K → still included
- `test_tolerance_band`: Shard would put total at cap × 1.15 (within 20%) → included
- `test_tolerance_exceeded`: Shard would put total at cap × 1.25 (over 20%) → excluded
- `test_shard_separators_present`: Output contains topic labels and time distances between shards
- `test_fallback_no_shards`: No shards in DB → loads all messages (backward compat)

### Gate
Cortex context stays bounded. A conversation that previously hit 200K tokens now stays within configured budget. Verify by running Cortex with both channels active for 1+ hours — token count stays stable.

---

## Phase 3: Semantic Detection + Topic Labels

**Goal:** Detect topic shifts in flowing conversations where heuristics don't trigger. Generate meaningful topic labels for shard separators and Gardener consumption.

### Tasks

**3.1 — Tier 2: Semantic boundary detector**
- New function: `detectTopicShift(messages: Message[]): { shifted: boolean, splitAtId?: number, oldTopic?: string, newTopic?: string }`
- Calls configured `semanticModel` (default Haiku) with the sliding window prompt (architecture doc §5.2)
- **File:** `src/cortex/shards.ts`

**3.2 — Sliding window integration**
- Track message count since last semantic check per channel
- Every `semanticCheckInterval` messages (default 8), fire `detectTopicShift` on the active shard's recent messages
- If shift detected: close current shard with old topic label, open new shard with new topic label
- Runs async — does not block the Cortex loop. Result applied on next message arrival
- **File:** `src/cortex/loop.ts`

**3.3 — Topic labeling for heuristic boundaries**
- When Tier 1 (time gap or token overflow) closes a shard, the shard has no topic label yet
- Fire an async Haiku call to label the closed shard: "Summarize the main topic of these messages in 3-5 words"
- Update `cortex_shards.topic` when the result arrives
- Non-blocking — shard separator shows "Continued conversation" until label arrives
- **File:** `src/cortex/shards.ts`

**3.4 — fetch_chat_history shard mode**
- Add `shard_id` parameter to `fetch_chat_history` tool
- When provided, returns all messages in that shard (coherent block retrieval)
- Existing `{ channel, limit, before }` mode unchanged
- **File:** `src/cortex/tools.ts`

### Tests

- `test_semantic_detects_shift`: Feed messages with clear topic change → returns shifted=true with correct split point
- `test_semantic_no_shift`: Feed messages on same topic → returns shifted=false
- `test_sliding_window_fires_at_interval`: After N messages without heuristic trigger → semantic check fires
- `test_topic_label_async`: Close shard via heuristic → label is NULL initially → updated after Haiku call
- `test_fetch_chat_history_by_shard`: Request shard_id → returns exactly that shard's messages

### Gate
Topic shifts in flowing conversation are detected. Shard separators show meaningful labels. `fetch_chat_history` can retrieve full shards by ID.

---

## Phase 4: Gardener Integration

**Goal:** Gardener consumes closed shards for fact extraction and background summaries. Shards improve extraction quality.

### Tasks

**4.1 — Shard-aware Fact Extractor**
- Modify Fact Extractor to process closed shards individually instead of scanning raw session rows
- Include shard topic label in extraction prompt: "From the conversation about '<topic>', extract persistent facts"
- Track which shards have been processed (`cortex_shards.extracted_at`?)
- **File:** Gardener extractor code

**4.2 — Shard-based Background Summaries**
- Modify Channel Compactor to build Layer 3 summaries from shard labels:
  ```
  Background (whatsapp):
  - Token monitor fix: implemented TASK column, evaluator lifecycle (2h ago)
  - Code search tool: built for main agent and Cortex (45min ago)
  ```
- One line per recent closed shard, not per arbitrary message window
- **File:** Gardener compactor code

**4.3 — Retroactive sharding (optional)**
- On first enable, process existing `cortex_session` history
- Run Haiku over historical messages to assign shard boundaries retroactively
- Can be expensive for large tables — make it opt-in via config flag
- Alternatively: just shard forward and let old messages live as the unsharded implicit block

### Tests

- `test_extractor_processes_shards`: Closed shard with topic → extractor produces facts scoped to that topic
- `test_extractor_skips_processed`: Shard with `extracted_at` set → skipped on next sweep
- `test_background_from_shards`: Two closed shards → background summary has two lines with topic labels

### Gate
Gardener extracts better facts using shard context. Background summaries are topic-aware. Full memory flow validated: message → shard → foreground → closed → Hot Memory → Cold Storage.

---

## Dependencies

```
Phase 1 (schema + heuristics) → Phase 2 (context assembly) → Phase 3 (semantic) → Phase 4 (Gardener)
                                                                                          │
Phase 1 + 2 alone solve the 200K overflow.                                                │
Phase 3 improves quality.                                                                  │
Phase 4 is the long-term payoff.                                                          │
```

Phase 1 + 2 are the critical path. They can ship independently and immediately fix the overflow problem. Phases 3 and 4 are quality improvements that can follow at any pace.

---

## Estimated Effort

| Phase | Complexity | Estimate | Blocking? |
|-------|-----------|----------|-----------|
| Phase 1 | Medium | 1 session | Yes — foundation |
| Phase 2 | Medium | 1 session | Yes — the actual fix |
| Phase 3 | Medium-High | 1-2 sessions | No — quality improvement |
| Phase 4 | Low-Medium | 1 session | No — Gardener already exists |

A "session" is roughly 2-4 hours of focused work. Phase 1 + 2 could ship in a single day.

---

## Files Likely Modified

| File | Phase | Change |
|------|-------|--------|
| `src/cortex/db.ts` | 1 | Schema migration |
| `src/cortex/shards.ts` | 1, 3 | **New file** — shard manager |
| `src/cortex/loop.ts` | 1, 3 | Inline assignment, sliding window trigger |
| `src/cortex/context.ts` | 2 | Shard-based foreground builder |
| `src/cortex/tools.ts` | 3 | fetch_chat_history shard_id mode |
| `cortex/config.json` | 1 | Foreground config section |
| Gardener extractor | 4 | Shard-aware extraction |
| Gardener compactor | 4 | Shard-based background summaries |
