# 05 — Cortex Ops-Trigger Shard Gap

> **Date:** 2026-03-11
> **Severity:** HIGH — Cortex loses its own responses, contradicts itself to the user
> **Source:** Serj's morning conversation with Cortex on webchat (08:46-09:00 UTC+2)

---

## Summary

Five issues found from a single conversation trace. The root cause is that ops-trigger messages (task completions from Router executors) bypass shard assignment, making them invisible to Cortex on subsequent turns. Cortex sends responses to the user but cannot see those responses in its own context on the next turn.

---

## Bug 1: Ops-trigger messages fall into shard gap (ROOT CAUSE)

### What happened

1. User asked for git diffs on webchat (shard `029deb77`)
2. Cortex spawned 2 tasks, polled status, eventually went `[silence]`
3. Task completed → `gateway-bridge.ts` called `appendTaskResult()` → stored with `shard_id = NULL`
4. Ops-trigger woke Cortex → `loop.ts` line 163: `if (foregroundConfig && !isOpsTrigger)` **skips shard assignment**
5. Cortex generated responses (messages 4573, 4576) → stored with `shard_id = NULL`
6. User sent next message (4577) → assigned to NEW shard `80605755`
7. `buildShardedForeground()` assembled context → messages 4572-4576 (`shard_id = NULL`) were **invisible**

### Why they're invisible

`getUnshardedMessages()` in `context.ts:280` only returns messages with `shard_id IS NULL AND id > MAX(last_message_id)` across all shards. Once shard `80605755` was created for message 4577, its `last_message_id = 4577`. Messages 4572-4576 have `id < 4577`, so they're excluded.

These messages fall into a **gap** — between the old shard's last message (4571) and the new shard's first message (4577). They have no shard, and `getUnshardedMessages` doesn't look backward.

### Impact

- Cortex told the user at 08:49 "Got both results... ~80 unpushed commits to origin/main"
- At 08:52, user asked about this. Cortex said "I don't see that quote in my current context"
- At 08:54, Cortex called its own previous response "hallucination" and "false distinction"
- Cortex was gaslighting itself — the responses existed, were sent, but were invisible to itself

### Code locations

```
src/cortex/loop.ts:163      — `if (foregroundConfig && !isOpsTrigger)` skips shard assignment
src/cortex/session.ts:181   — appendTaskResult stores with no shard_id
src/cortex/context.ts:280   — getUnshardedMessages only looks forward from last shard
```

### Fix options

**Option A (preferred): Assign ops-trigger messages to the active shard**

Remove the `!isOpsTrigger` guard on shard assignment, or add a dedicated ops-trigger shard assignment step that places these messages in the currently active shard (or creates a new one). This ensures they're always visible in context.

```typescript
// loop.ts — after appendToSession for ops triggers:
if (foregroundConfig) {
  const lastId = db.prepare(`SELECT last_insert_rowid() as id`).get();
  const messageId = Number(lastId.id);
  assignedShardId = assignMessageToActiveShard(db, messageId, replyChannel, issuer);
}
```

**Option B: Fix getUnshardedMessages to look bidirectionally**

Change the query to include ALL null-shard messages within the active conversation window, not just those after the last shard:

```sql
-- Current (broken):
WHERE shard_id IS NULL AND id > ?   -- only forward-looking

-- Fixed:
WHERE shard_id IS NULL AND id > (SELECT MIN(first_message_id) FROM cortex_shards WHERE status = 'active' AND ...)
```

**Recommendation:** Option A. Ops-trigger messages ARE conversation messages — the user sees them, Cortex generates them. They should be in a shard.

---

## Bug 2: Cortex aggressively polls task status (token waste)

### What happened

Messages 4556-4571 show Cortex calling `get_task_status` in a tight loop — **4 polling cycles in ~13 seconds** (08:48:53, 08:48:57, 08:49:03, 08:49:06, 08:49:09). Each cycle is a full LLM call.

The ops-trigger system already handles push notification when tasks complete. Cortex shouldn't need to poll at all.

### Why it happened

When the user pointed out the empty metadata bug (message 4555), that triggered a new Cortex turn. Cortex decided to check task status. Each check returned "in_execution" for one task, so Cortex generated another response polling again. The user wasn't sending new messages — Cortex was in a self-referential polling loop.

### Impact

- 4 LLM calls wasted on polling (each with full context window)
- Burnt tokens for zero information gain
- User saw "Both still running. Give it a few seconds." repeated

### Fix

1. **Remove polling from the LLM's decision space.** Remove the "give it a few seconds" pattern. The ops-trigger system delivers results — Cortex should tell the user "I'll let you know when results are ready" and wait for the trigger.

2. **Add to system prompt:** "Do not poll get_task_status in a loop. Task results arrive via ops-trigger notifications. Check status once if asked, then wait."

3. **Rate-limit get_task_status:** If the same taskId is queried more than twice within 30 seconds, return a cached result with a "please wait for notification" note.

---

## Bug 3: Double timestamp metadata prefixes

### What happened

Multiple Cortex responses have double timestamps:
```
[2026-03-11 08:58:34:Scaff[cortex]:webchat] [2026-03-11 08:58:36:Scaff[cortex]:webchat]
```

### Why

The LLM is generating these metadata prefixes itself (they're not injected by code). When the LLM produces thinking + text blocks, each block gets a separate timestamp prefix. If the response has two text blocks or the LLM mimics the prefix pattern twice, you get doubles.

### Code location

This is in `contextToMessages()` in `llm-caller.ts` — it prefixes messages with `[timestamp:issuer:channel]`, and the LLM learns to continue the pattern. When it generates two text blocks, both get prefixed.

### Fix

See doc `04_cortex-context-metadata.md` — the metadata fix (commit 28a9936e3) addressed sender identity but may not have fixed the double-prefix issue. The LLM should NOT be generating these prefixes — they should be code-injected only.

---

## Bug 4: Empty metadata-only messages

### What happened

Message 4554 is ONLY:
```
[2026-03-11 08:48:22:Scaff[cortex]:webchat]
```

No content after the timestamp prefix. This was sent to the user as a visible message.

### Why

The LLM generated a response that was only the metadata prefix with no content. The output parser didn't filter it. When the LLM has tool calls + text, sometimes the text block is just the prefix with the actual content in the tool call blocks.

### Fix

In `parseResponse()` — if the extracted text matches only the metadata prefix pattern (regex: `/^\[[\d\-T: ]+:.*\]$/`), treat it as empty/silent. Don't send it to the user.

---

## Bug 5: Cortex confuses its ops-trigger responses with hallucination

### What happened

At message 4580, Cortex diagnosed its own previous output as "hallucination":
> "~80 unpushed commits" — almost certainly Haiku hallucination

But this content was NOT hallucinated — it came from the **real executor output**. The executor returned the full `git log origin/main..HEAD --oneline` (which genuinely shows ~80 commits). Cortex couldn't see its previous responses (Bug 1), so when the user pasted them back, Cortex assumed they were fabricated.

### Why this matters

Cortex is making meta-cognitive judgments ("that's a hallucination") based on incomplete context. This is worse than simple amnesia — it's **active misinformation**. Cortex told the user its own correct output was wrong, then apologized for fabricating data it never fabricated.

### Impact

- User loses trust (Cortex contradicts itself)
- Cortex makes false self-diagnoses
- Root cause gets obscured (user thinks it's a hallucination problem, not a context problem)

### Fix

Resolving Bug 1 (shard gap) fixes this downstream. If Cortex can see its own previous ops-trigger responses, it won't misdiagnose them.

---

## Reproduction

### Minimal steps

1. Enable Cortex with foreground sharding
2. On webchat, send a message that causes Cortex to call `sessions_spawn`
3. Wait for the task to complete (ops-trigger fires)
4. Cortex generates response to the ops-trigger (stored with shard_id = NULL)
5. Send another message on webchat
6. New shard is created → ops-trigger messages are invisible
7. Ask Cortex about its previous response → it can't see it

### DB verification

```sql
-- Find orphaned ops-trigger messages (no shard, between two shards)
SELECT id, role, channel, sender_id, shard_id, substr(content, 1, 80), timestamp
FROM cortex_session
WHERE shard_id IS NULL
  AND sender_id IN ('cortex:ops', 'cortex')
  AND timestamp >= '2026-03-11T00:00:00'
ORDER BY id;
```

---

## Priority

| Bug | Severity | Fix Effort | Impact |
|-----|----------|-----------|--------|
| Bug 1 (shard gap) | **CRITICAL** | Medium (1-2 sessions) | Cortex loses context, contradicts itself |
| Bug 2 (poll loop) | MEDIUM | Low (prompt + rate limit) | Token waste |
| Bug 3 (double timestamps) | LOW | Low (output filter) | Cosmetic |
| Bug 4 (empty messages) | LOW | Low (output filter) | Cosmetic |
| Bug 5 (false self-diagnosis) | HIGH (but downstream of Bug 1) | None (fixed by Bug 1) | Trust erosion |

Bug 1 is the fix. Everything else is either cosmetic or a consequence of Bug 1.
