# Cortex Freeze Investigation — 2026-03-11 ~19:04-19:33 Local

> **Status:** Complete  
> **Reported:** Cortex became unresponsive, all messages answered with [silence]  
> **Scope:** Full root cause analysis, 7 distinct issues found

---

## Timeline (UTC times, local = UTC+2)

| Time UTC | ID | Event |
|----------|-----|-------|
| 17:04:00 | 4678 | Session starts — user sends 4 URLs for Library ingestion |
| 17:04:23 | 4681 | `library_ingest` for Google Always-On Memory Agent → Task 091a888d |
| 17:04:43 | 4685 | `library_ingest` for TypeAgent Memory → Task af50c00d |
| 17:04:54 | 4689 | `library_ingest` for iosm-cli → Task d141fcbc |
| 17:05:15 | 4693 | `library_ingest` for arxiv paper 2603.05344v2 → Task 5977daa3 |
| 17:05:35 | 4696 | ✅ Task 091a888d completes (Google Memory Agent) |
| 17:05:43 | 4699 | ✅ Task af50c00d completes (TypeAgent) |
| 17:06:09 | 4702 | ✅ Task d141fcbc completes (iosm-cli) — new shard `3e68f0c6` |
| 17:06:42 | 4709 | ✅ Task 5977daa3 completes (arxiv) — new shard `98a1104a` |
| 17:07:31 | 4716 | Shard `1021bb59` starts — X.com ingestion attempts begin |
| 17:09:09 | 4730 | X.com Librarian task `19abb7ab` completes with JS block content |
| 17:09:09 | 4731 | X.com task #2 also fails with JS block |
| 17:11:59 | 4741 | User demands X.com fix ("I remember you fixed that once") |
| 17:12:06 | 4742 | **Cortex enters tool search loop** — memory_query, code_search, chat_history, library_search... |
| 17:12:34 | 4757 | **First [silence]** — Cortex fails to respond after 6 tool rounds |
| 17:13:57 | 4758 | User: "Scaff?" → Cortex recovers, responds about fxtwitter |
| 17:14:48 | 4760 | User: "just do it" → Cortex tries to fix it |
| 17:15:01 | 4764 | More code_search — can't find library code (not in index) |
| 17:15:17 | 4767 | **Second [silence]** |
| 17:15:27 | 4768 | User: "are you doing it?" → Cortex recovers, spawns executor |
| 17:15:51 | 4770 | **Task 7dcd52b1 dispatched** (fxtwitter patch) |
| 17:16:25 | — | Executor session starts (34527a23) |
| 17:16:31 | — | Executor hits `grep not recognized` — recovers to PowerShell |
| 17:18:57 | 4774 | New shard `dca8eda1` created. User asks about context 137K |
| 17:21:23 | 4779 | **⚠️ Task 7dcd52b1 reported FAILED** (5min timeout) |
| 17:21:38 | 4781 | User asks "what do you have on memory design" |
| 17:21:41 | — | **Executor actually finishes** (18 seconds too late!) |
| 17:21:53 | 4782 | **⚠️ Cortex response goes to WRONG shard** (1021bb59 not dca8eda1) |
| 17:22:13 | 4786 | Memory design answer delivered — but on wrong shard |
| 17:24:08 | 4787 | User: "how is X extraction going?" |
| 17:24:22 | 4788 | **⚠️ LLM thinks memory question is still unanswered** — starts tool loop |
| 17:24:22-50 | 4789-4806 | **Tool loop**: library_get(2), library_get(3) called 3× each. memory_search, library_search, code_search all repeated. 5 rounds. |
| 17:24:55 | 4807 | **[silence] — FINAL FREEZE** |
| 17:25:17 | 4808 | User: "Scaff? where are you?" → [silence] |
| 17:26:22 | 4810 | User: "too many toolings, became unresponsive" → [silence] |
| 17:29-17:33 | 4812-4819 | User tries webchat + whatsapp — all [silence] |

---

## Finding 1: Shard Assignment Mismatch (ROOT CAUSE of tool loop)

**Severity:** Critical  
**Impact:** Caused the tool loop that froze Cortex

Messages 4782-4786 (Cortex's response to the memory design question on shard `dca8eda1`) were stored on the WRONG shard `1021bb59`.

```
Shard dca8eda1: 4774, 4775, ..., 4781  ← user question here
Shard 1021bb59: 4782, 4783, 4784, 4785, 4786  ← response here (WRONG!)
Shard dca8eda1: 4787, 4788, ...  ← next turn, answer is MISSING from context
```

When the LLM built context for message 4787, it loaded shard `dca8eda1` and saw:
- ✅ Message 4781: "what do you have on memory design" (the question)
- ❌ Messages 4782-4786: NOT LOADED (different shard)

The LLM thought the memory question was still unanswered and tried to answer it again by calling library_get — creating the loop.

**Evidence:** Thinking block at 4788: "Serj is asking **two things**: 1. What do I have on memory design... 2. How is X extraction going."  
But the user only asked ONE thing (X extraction). The "memory design" was already answered 2 minutes ago — on the wrong shard.

**Shard timing:**
- Shard `dca8eda1` created at 17:21:39
- Messages 4782-4786 stored at 17:21:53 (14 seconds after shard creation)
- But they went to `1021bb59` — the shard that should have been closed

**Root cause:** The shard assignment for assistant responses (4782) appears to use a stale foreground pointer. When a new shard is created mid-turn, the in-flight LLM response still gets assigned to the previous shard.

---

## Finding 2: Compressed Reference Loop (amplifying factor)

**Severity:** High  
**Impact:** Kept the tool loop running for 5 rounds instead of self-correcting

The library_get tool returns full content to the LLM API but stores compressed references in cortex_session:
```
📚 Referenced: [id:2] "Always-On Memory Agent..." — ai-memory-agents, llm-consolidation...
```

Within a multi-round turn (same user message, multiple LLM API calls):
1. Round N: LLM calls library_get(2) → gets full 500-word summary → uses it
2. Cortex stores compressed reference in cortex_session
3. Round N+1: Context rebuilt from cortex_session → LLM sees compressed reference only
4. LLM: "I need the full library items" → calls library_get(2) again
5. Repeat

**Evidence:** 
- library_get(2) called at 4783, 4794, 4801 (3 times)
- library_get(3) called at 4784, 4795, 4802 (3 times)
- Thinking at 4798: "For memory, I need the full library items" (it doesn't have them — only compressed refs)

**Root cause:** The context builder reads from cortex_session between rounds within the same turn. The shardContent mechanism (compressed reference) is designed for cross-turn persistence, but it also affects intra-turn rounds because context is rebuilt from DB each round.

**Fix needed:** Keep full tool results in memory for the current turn. Only compress when the turn ends and the next turn starts.

---

## Finding 3: Executor Succeeded But Reported Failed

**Severity:** Medium  
**Impact:** Cortex didn't know the fxtwitter patch was applied; retried work

Task `7dcd52b1` (fxtwitter URL transform patch):
- **Dispatched:** 17:15:51
- **Executor started:** 17:16:25 (34 second delay)
- **Router reported FAILED:** 17:21:23 (5 minute timeout from dispatch)
- **Executor actually finished:** 17:21:41 (18 seconds after timeout)

The executor (session 34527a23) completed successfully:
1. Found `src/cortex/loop.ts` via PowerShell (after `grep` failed — Windows)
2. Added URL transform: `x.com`/`twitter.com` → `fxtwitter.com` before fetch
3. Verified with `tsc --noEmit` — no errors

**But Cortex never saw this result.** It only got "[Task failed]" at 4779.

**Evidence:** Executor session line 50 shows the complete result with diff and verification. Cortex at 4780 says: "Executor timed out (5min gateway limit). Task was too broad."

**Root cause:** The 5-minute Router timeout is too aggressive for code exploration tasks. The 34-second delay between dispatch and executor start eats into the budget. And the executor spent time recovering from `grep` not being available on Windows — burning ~30 more seconds.

**Also note:** The patch that the executor applied to `loop.ts` exists in the running codebase but was never compiled (no `pnpm build`). It's a source-only change that won't take effect until rebuild.

---

## Finding 4: Context Explosion (137K tokens)

**Severity:** High  
**Impact:** Exceeded foreground limits, degraded LLM reasoning

At 17:18:57 (4774), the user observed 137K tokens in the context monitor. The foreground token cap is 24K with 20% tolerance (28.8K max), and maxShardTokens is 8K.

**How did 137K happen?**

1. **Task result messages stored in cortex_session:** Each `[TASK_ID]` message (4696, 4699, 4702, etc.) contains the FULL Librarian prompt including pre-fetched content. The arxiv paper alone is ~50K characters of content embedded in the prompt.

2. **fetch_chat_history tool results:** Cortex called `fetch_chat_history(limit=50)` twice (around 4743, 4748, 4756) trying to find evidence of a previous X.com fix. These returns included the full [TASK_ID] messages with embedded paper content.

3. **Tool results bypass sharding:** The sharding system manages conversation messages (foreground cap, shard boundaries), but tool_result messages within the active turn are injected directly into the API call. They don't count against the shard token budget.

**Evidence:** Cortex at 4775: "I called fetch_chat_history with limit=50 twice trying to find evidence of a previous X.com fix. Those results came back with full librarian task payloads — including the complete 50K+ arxiv paper content."

**Root cause:** `appendTaskResult` stores the full Librarian prompt (with embedded web content) as a cortex_session message. These are visible to fetch_chat_history and get pulled into tool results.

---

## Finding 5: [silence] Cascade After Tool Loop Exhaustion

**Severity:** High  
**Impact:** Cortex completely unresponsive for 10+ minutes

After 5 rounds of tool loops (4788-4806), the LLM returned empty/silence at 4807. Every subsequent message (4808-4819) also got [silence].

**Possible causes:**
- Context window exhaustion (137K+ tokens with tool results)
- LLM rate limit hit (6+ rapid API calls within 30 seconds)
- The Cortex loop entered a broken state after the tool loop and couldn't recover

**Evidence:** Messages 4807-4819 all have `role:assistant channel:internal` (silence marker). Both WhatsApp and webchat messages get the same treatment.

**Note:** The gateway status shows "unreachable (timeout)" and "state Disabled". Whether this was a consequence of the freeze or a separate issue is unclear.

---

## Finding 6 (Minor): Executor Environment Mismatch

**Severity:** Low  
**Impact:** Wasted ~30 seconds, contributed to timeout

The task spawned by Cortex included bash commands (`grep -r`, `find`, `2>/dev/null`). The executor runs on Windows PowerShell where these don't exist. The executor had to recover with PowerShell equivalents, burning time.

**Evidence:** Executor session line 7-8: `grep: The term 'grep' is not recognized`

**Root cause:** The task prompt was written by the LLM (Cortex) with bash assumptions. The executor system prompt doesn't specify the OS, and the task description included explicit bash commands.

---

## Finding 7 (Minor): Router-Evaluator Model Config Warning Spam

**Severity:** Low  
**Impact:** Log noise only

The status output contains 100+ repetitions of:
```
[model-selection] Model "claude-sonnet-4-6" specified without provider. 
Falling back to "anthropic/claude-sonnet-4-6".
```

**Root cause:** Router-evaluator agent config has `model: "claude-sonnet-4-6"` instead of `model: "anthropic/claude-sonnet-4-6"`. Each evaluator session triggers this warning.

---

## Summary of Issues

| # | Issue | Severity | Fixed? |
|---|-------|----------|--------|
| 1 | Shard assignment mismatch (responses on wrong shard) | Critical | Yes — `loop.ts` post-turn shard re-sync (step 8b) |
| 2 | Compressed reference loop (intra-turn context rebuild) | High | Yes — `toolRoundTrips` accumulates all rounds |
| 3 | Executor success reported as failure (blind 5min timeout) | Medium | No (needs inactivity-based timeout rearchitecture) |
| 4 | Context explosion (task results + fetch_chat_history) | High | Yes — `appendTaskResult` truncates to 500 chars |
| 5 | [silence] cascade after tool exhaustion | High | Mitigated (root cause #1/#2 fixed) |
| 6 | Executor bash commands on Windows | Low | Yes — platform context injected into task descriptions |
| 7 | Router-evaluator model config warning spam | Low | Yes — model ID includes provider prefix |

## Causal Chain

```
User shares 4 URLs → library_ingest spawns 4 Librarian tasks
→ Task results stored as FULL prompts in cortex_session (Finding 4)
→ Shard 1021bb59 grows to 63 messages
→ New shard dca8eda1 created at 17:21:39
→ User asks about memory design (on dca8eda1)
→ Cortex responds — but response goes to old shard 1021bb59 (Finding 1)
→ User asks "how is X extraction going?" (on dca8eda1)
→ Context rebuild loads dca8eda1 — memory answer NOT visible
→ LLM thinks memory question unanswered — calls library_get (Finding 1)
→ library_get returns compressed reference to shard (Finding 2)
→ Next round: LLM sees compressed ref, calls library_get again (Finding 2)
→ 5 rounds of tool loops → context exhausted → [silence] (Finding 5)
→ All subsequent messages → [silence]
```

---

## Recommended Fixes (priority order)

### P0: Shard Assignment for In-Flight Responses
The shard assignment for assistant responses must use the shard of the TRIGGERING message, not the "current foreground" pointer. If message X triggers an LLM call, all tool results and the LLM response must go to the same shard as message X.

### P1: Compressed Reference — Intra-Turn vs Cross-Turn
Keep full tool results in an in-memory buffer for the duration of the current turn (all rounds). Only write compressed references to cortex_session when the turn ends (LLM produces a final text response, no more tool calls). This prevents the re-fetch loop within a single turn.

### P2: Task Result Storage — Store Reference, Not Full Prompt
`appendTaskResult` currently stores the full task content (including the 50K Librarian prompt). It should store a summary/reference only:
```
📚 Task completed: Librarian ingested "Always-On Memory Agent" [Task 091a888d]
```
The full task prompt is already in the executor session log — no need to duplicate it in cortex_session.

### P3: Router Timeout — Inactivity-Based, Not Blind Timer
The current 5-minute hard timeout is blind — it doesn't care if the executor is actively working or stuck. The Worker runs the executor session and can see tool call activity.

**Proposed mechanism:**
- The Worker tracks the executor's last tool call timestamp
- If the executor made a tool call within the last 60 seconds → it's alive, extend the deadline
- If 5 minutes pass with ZERO activity → the executor is stuck, kill it
- Hard cap at 15 minutes regardless of activity (prevents infinite loops)

The evaluator already scores task weight (this task was weight 7). Weight could inform the hard cap:
- Weight 1-3: hard cap 5 minutes
- Weight 4-6: hard cap 10 minutes
- Weight 7-10: hard cap 15 minutes

**Why this fixes the incident:** The executor was making tool calls every 2-6 seconds right up until completion at 17:21:41. An inactivity-based timeout would never have killed it — it was clearly alive. The Router would have received the successful result 18 seconds later.

### P4: Library Task ID Resilience (Future)
Currently, `library_ingest` dispatches tasks through the Router and the tool_result includes the task ID. The anti-poll instruction ("do NOT poll get_task_status") is correct for the happy path — avoids Bug #34 token waste.

However, if the notification system fails entirely (gateway restart, network hiccup, ops-trigger lost), Cortex has no recovery path. The task ID is buried in a tool_result message and the LLM was told to ignore it.

**Future consideration:** A lightweight "pending library tasks" check during heartbeats — if a library_ingest task has been pending for >10 minutes with no result, surface it. Not a priority if P3 (inactivity timeout) is fixed, since the notification system will deliver correctly.

### P5: Executor Environment Awareness
The executor system prompt should include the OS (Windows/PowerShell). Or: Cortex should not embed bash commands in task descriptions — let the executor figure out how to run them.

### P6: Model Config Fix
Change `router-evaluator` agent config from `model: "claude-sonnet-4-6"` to `model: "anthropic/claude-sonnet-4-6"`.
