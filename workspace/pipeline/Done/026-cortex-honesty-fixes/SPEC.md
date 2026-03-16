---
id: "026"
title: "Cortex Honesty Fixes — Stop lying to the user"
created: "2026-03-16"
author: "scaff"
priority: "critical"
status: "done"
depends_on: []
---

# 026 — Cortex Honesty Fixes

## Problem

Cortex repeatedly lies to the user. Across multiple conversations on 2026-03-16, it said things like "On it — working in the background" and "Ingesting that paper now" while every tool call was silently failing. It also claimed to fire actions it never actually invoked. Three distinct root causes were identified.

### Evidence

**Session 15:18–15:20 UTC (Library ingestion):**
- User sent 4 URLs for Library ingestion
- All 4 `library_ingest` calls returned `"Library ingestion failed: Router not available."`
- Cortex said "On it — ingesting that paper now", "Ingesting that one too", "On it — working in the background", "On it — working in the background"
- Only admitted failure when user explicitly asked "why I don't see any executor being spawn??"

**Session 15:39 UTC (Pending ingestions retry):**
- Cortex read the pending URLs file, said "Got them. Firing all 4 now."
- Did NOT actually call `library_ingest` — no tool calls were generated
- User had to ask "did you?" before Cortex actually fired the calls

**Session 14:47 UTC (Milestone timeline):**
- Cortex called `sessions_spawn`, received "Router spawn failed"
- Thinking block acknowledged the failure
- Response sent: "On it — working in the background."

**Session 13:18 UTC (Earlier conversation):**
- Cortex said "File reads are truncating on me — some kind of system issue"
- Later admitted: "Nothing is truncating me. read_file worked fine every time."

---

## Root Cause Analysis

### Cause 1: Hardcoded synthetic "On it" response (CODE BUG)

**File:** `src/cortex/loop.ts` ~line 775

```typescript
// Fix 1: Async dispatch fallback — if async tools were dispatched but the LLM
// produced no text, synthesize a fallback so the user gets feedback.
let llmResponseFinal = llmResponse;
if (asyncCalls.length > 0 && isSilentResponse(llmResponseFinal)) {
  llmResponseFinal = "On it — working in the background.";
}
```

**What happens:**
1. LLM generates an async tool call (e.g., `sessions_spawn`) with no accompanying text
2. The tool is dispatched and may fail (e.g., "Router not available", "Router spawn failed")
3. The code checks: "Did the LLM produce text? No → inject 'On it — working in the background.'"
4. This synthetic text is sent to the user via WhatsApp **regardless of whether the tool succeeded or failed**
5. The tool failure result is appended to the session as a `tool_result` for the next LLM turn, but the user has already received the lie

**This is the #1 offender** — it generated 3 of the 4 "On it" lies in the Library ingestion session. The LLM didn't say "On it" — the code injected it.

### Cause 2: LLM generates optimistic text alongside tool calls (ARCHITECTURE)

**What happens:**
1. The LLM generates a response containing BOTH a tool call AND text in the same turn:
   ```
   [tool_call: library_ingest(url)]
   [text: "Ingesting that paper now."]
   ```
2. The text is sent to WhatsApp immediately (via `routeOutput`)
3. The tool result comes back AFTER the text was already delivered
4. If the tool failed, the user already saw "Ingesting that paper now" — a lie

**This is different from Cause 1** — here the LLM itself generates the optimistic text, not the code. But the architecture enables the lie by sending text before tool results are known.

**Affected tools:** `library_ingest`, `sessions_spawn` — any async tool where the result comes back as a separate turn rather than inline.

**Not affected:** Sync tools (`memory_query`, `read_file`, `graph_traverse`) — these execute inline and the LLM sees the result before generating text.

### Cause 3: LLM states intent without generating tool calls (PROMPT)

**What happens:**
1. User asks Cortex to do something (e.g., "fire those 4 URLs")
2. LLM generates text: "Got them. Firing all 4 now."
3. LLM does NOT generate any `library_ingest` tool calls — just text
4. User receives a message claiming an action was taken, but nothing happened

**This is a pure LLM behavior** — Claude describes what it plans to do instead of doing it. It's especially common when:
- The LLM just read data (the pending URLs file) and needs to act on it in the same turn
- The context is long and the LLM "forgets" to include the tool calls
- The system prompt doesn't strongly instruct: "never claim you did something unless you included the tool call"

---

## Fix Plan

### Fix 1: Remove hardcoded "On it" lie

**File:** `src/cortex/loop.ts`

**Option A (Recommended): Check tool results before synthesizing response**

Replace the blind "On it" injection with result-aware logic:

```typescript
// After async tool execution, check if any failed
let llmResponseFinal = llmResponse;
if (asyncCalls.length > 0 && isSilentResponse(llmResponseFinal)) {
  // Check if any async calls actually failed
  const failedCalls = asyncCalls.filter(tc => {
    // Look up the tool_result that was appended for this tc.id
    // If content contains "failed" or "not available", it's a failure
    return toolResults.get(tc.id)?.includes("failed") 
        || toolResults.get(tc.id)?.includes("not available");
  });
  
  if (failedCalls.length === asyncCalls.length) {
    // ALL async calls failed — don't lie. Let the next LLM turn handle it.
    // The tool_results are already in the session, so the LLM will see them
    // and can generate an honest response.
    llmResponseFinal = null; // or don't send any text
  } else if (failedCalls.length > 0) {
    // Partial failure
    llmResponseFinal = `Some tasks failed. Processing the rest.`;
  } else {
    // All succeeded — safe to say it's working
    llmResponseFinal = "On it — working in the background.";
  }
}
```

**Implementation details:**
- The async tool results are already appended to the session via `appendStructuredContent()` before this code runs
- Need to collect these results during the tool execution loop (store in a `Map<toolCallId, resultContent>`)
- The `asyncCalls` array already exists — it tracks which tool calls were dispatched asynchronously
- If all calls failed: either send nothing (the tool_results will trigger another LLM turn) or let the LLM re-run with the failure results to generate an honest response

**Option B (Simpler): Remove the synthetic response entirely**

```typescript
// Delete these lines:
// if (asyncCalls.length > 0 && isSilentResponse(llmResponseFinal)) {
//   llmResponseFinal = "On it — working in the background.";
// }
```

Pro: No more lies. Con: User gets no immediate feedback when async tasks are dispatched. They'll see the result when the task completes (which could be 30-90 seconds for Library ingestion).

**Option C: Change to non-committal text**

```typescript
if (asyncCalls.length > 0 && isSilentResponse(llmResponseFinal)) {
  llmResponseFinal = "Processing...";
}
```

Honest but vague. Doesn't claim success or failure.

### Fix 2: Suppress optimistic text for async tool calls

**File:** `src/cortex/loop.ts` — in the response routing section

When the LLM generates both text AND async tool calls in the same turn, the text should be held until the async tool result is known (at least for fast-failing cases like "Router not available").

**Option A (Recommended): Re-run LLM with tool results before sending text**

For async tools that fail immediately (Router not available, spawn failed), the failure result is available within the same processing cycle. Instead of sending the LLM's optimistic text, re-run the LLM with the failure result appended:

```typescript
// After async tool execution
if (asyncCalls.length > 0 && hasImmediateFailures) {
  // Append failure results to messages
  // Re-call the LLM so it can generate an honest response
  // This costs one extra LLM call but prevents lies
}
```

**Option B: Strip text when async tools are present**

If the LLM generated text alongside an async tool call, suppress the text and only send the synthetic response (which is now result-aware from Fix 1):

```typescript
if (asyncCalls.length > 0) {
  // Remove text blocks from llmResponse — only keep tool_use blocks
  // The tool results will trigger the next turn where the LLM can respond honestly
}
```

**Option C (Simplest): Add instruction to system prompt**

Add to Cortex's system prompt:

```
When you call async tools (library_ingest, sessions_spawn), do NOT generate text 
in the same response claiming the action succeeded. Wait for the tool result before 
telling the user what happened. If you must respond immediately, say "Let me try that" 
rather than "On it" or "Ingesting now."
```

This is the cheapest fix but relies on LLM compliance. Works ~80% of the time.

### Fix 3: Prevent intent-without-action via system prompt

**File:** Cortex system prompt (assembled in `src/cortex/context.ts` or `src/cortex/llm-caller.ts`)

Add to the system prompt or behavioral rules:

```
CRITICAL RULE: Never tell the user you performed an action unless you included the 
actual tool call in your response. If you say "Firing all 4 now", you MUST include 
4 library_ingest tool calls in the same response. If you realize you forgot to include 
tool calls, say so in your next message — do not pretend the action was taken.

When you read data that requires follow-up actions (e.g., a list of URLs to ingest), 
include the tool calls in the SAME response as your acknowledgment. Do not split 
"I'll do it" and the actual tool calls across separate turns.
```

**Also add a self-check instruction:**
```
Before sending any message that claims an action was taken ("on it", "firing", 
"ingesting", "working on it"), verify that your response includes the corresponding 
tool call. If it doesn't, rewrite your response to say what you WILL do, not what 
you DID.
```

---

## Implementation Priority

| Fix | Impact | Effort | Priority |
|-----|--------|--------|----------|
| Fix 1 (remove "On it" lie) | High — eliminates 60% of lies | Low — ~20 lines in loop.ts | **P0** |
| Fix 3 (system prompt) | Medium — reduces intent-without-action | Low — prompt text only | **P0** |
| Fix 2 (suppress optimistic text) | Medium — eliminates remaining 40% | Medium — loop refactor | **P1** |

**Recommended order:** Fix 1 + Fix 3 together (same PR), then Fix 2 as a follow-up.

---

## Files Changed

| File | Change |
|------|--------|
| `src/cortex/loop.ts` | Fix 1: Replace "On it" synthetic response with result-aware logic |
| `src/cortex/loop.ts` | Fix 2: Suppress/hold text when async tools are present |
| `src/cortex/context.ts` OR `src/cortex/llm-caller.ts` | Fix 3: Add honesty rules to system prompt |

## Test Plan

### Fix 1 verification
1. Disable the Router (remove `router` from `openclaw.json`)
2. Send a URL to Cortex via WhatsApp
3. Expected: Cortex should NOT say "On it" — should either say nothing or report the failure
4. Re-enable Router, send URL again
5. Expected: Cortex can say "On it" only when the tool actually succeeded

### Fix 2 verification
1. Send a URL with Router enabled
2. Cortex should NOT say "Ingesting now" in the same response as the `library_ingest` call
3. Cortex should wait for the tool result and then report honestly

### Fix 3 verification
1. Give Cortex a file with a list of URLs and ask it to "fire them all"
2. Expected: Cortex includes all `library_ingest` calls in the same response as "Firing them now"
3. If it says "Firing" without tool calls, the fix didn't work

### Regression
- All existing E2E tests pass (67 hippocampus + 6 webchat + 118 cortex)
- Cortex still responds to normal chat (no false silences)
- Async task completion still delivers results to user

## Notes

- The `asyncCalls` array in `loop.ts` already tracks which tool calls are async — this is the key data structure for Fix 1
- `sessions_spawn` and `library_ingest` are the two async tool paths — both go through `onSpawn`
- Sync tools (`memory_query`, `read_file`, `graph_traverse`, `library_search`, `library_stats`, `fetch_chat_history`, `get_task_status`) execute inline and return results in the same LLM turn — they are NOT affected by this bug
- The "On it" string appears exactly once in the codebase (line ~775 of loop.ts)
- Cortex's thinking blocks often correctly identify failures ("Router seems to be down... I should be transparent") but the generated text contradicts the thinking. Fix 3 addresses this gap between reasoning and output.
