# Finding 2: Compressed Reference Loop — Full Analysis

> **Status:** NOT FIXED as of 2026-03-12  
> **Severity:** High  
> **Impact:** Causes tool loops that exhaust context and freeze Cortex  
> **Original incident:** 2026-03-11 ~17:24 UTC (messages 4788-4807)

---

## What Happened (the incident)

User asked: "how is X extraction going?"

Cortex thought the previous question ("what do you have on memory design") was still unanswered (it was — but on the wrong shard, Finding 1). So it called `library_get(2)` and `library_get(3)` to answer the memory question.

The tool loop:
```
Round 0: LLM calls library_get(2), library_get(3) → gets full summaries → responds
Round 1: LLM sees compressed refs from round 0, calls library_get(2) again
Round 2: Same — calls library_get(3) again
Round 3: Same pattern
Round 4: Same pattern
Round 5: MAX_TOOL_ROUNDS hit → [silence] → freeze
```

Each `library_get` was called 3 times total. The LLM kept saying (in thinking): "For memory, I need the full library items" — because it only saw compressed references from previous rounds.

---

## How the Code Works Today

### The sync tool round-trip loop (`loop.ts`)

```typescript
// Context assembled ONCE before the loop
let context = await assembleContext({ db, triggerEnvelope, ... });

const MAX_TOOL_ROUNDS = 5;
let llmResult = await callLLM(context);  // Call 0

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const syncCalls = llmResult.toolCalls.filter(tc => SYNC_TOOL_NAMES.has(tc.name));
  if (syncCalls.length === 0) break;

  // Store assistant's tool_use in DB
  appendStructuredContent(db, ..., llmResult._rawContent, ...);

  const toolResults: ToolResultEntry[] = [];
  for (const tc of syncCalls) {
    if (tc.name === "library_get") {
      const libResult = executeLibraryGet(args);
      result = libResult.content;           // ← FULL content (500+ words)

      if (libResult.shardContent) {
        // Store COMPRESSED reference in DB
        appendStructuredContent(db, ..., libResult.shardContent, ...);
        // But pass FULL content in toolResults for this round
        toolResults.push({ content: result });
        continue;  // Skip normal storage
      }
    }
    // Normal tools: store full result in DB
    appendStructuredContent(db, ..., [{ type: "tool_result", content: result }], ...);
    toolResults.push({ content: result });
  }

  // OVERWRITE toolRoundTrip with THIS round's data only
  context = {
    ...context,
    toolRoundTrip: {
      previousContent: llmResult._rawContent,  // assistant tool_use
      toolResults,                              // tool results (full content)
    },
  };
  llmResult = await callLLM(context);  // Next call
}
```

### How `callLLM` uses `toolRoundTrip` (`llm-caller.ts`)

```typescript
// 1. Build messages from context (assembled ONCE, before the loop)
const messages = contextToMessages(context);

// 2. Append the LATEST tool round-trip
if (context.toolRoundTrip) {
  messages.push({
    role: "assistant",
    content: context.toolRoundTrip.previousContent,  // tool_use blocks
  });
  messages.push({
    role: "user",
    content: toolResults.map(r => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: r.content,  // full content from toolResults
    })),
  });
}

// 3. Send to Anthropic API
```

---

## The Bug — Step by Step

### Call 0 (initial, before loop)
```
Messages sent to API:
  [system prompt]
  [DB conversation history]         ← no library refs yet
  
LLM response: tool_use library_get(2), library_get(3)
```

### Round 0 in loop
```
1. Store assistant tool_use in DB           → [assistant: library_get(2), library_get(3)]
2. Execute library_get(2):
   - Full content: "Always-On Memory Agent: Google's approach to..."  (500 words)
   - Compressed:   "📚 Referenced: [id:2] Always-On Memory Agent — ai-memory, llm"  (20 words)
   - Store COMPRESSED in DB
   - Push FULL to toolResults
3. Execute library_get(3):
   - Same pattern: compressed in DB, full in toolResults
4. Set toolRoundTrip = { previousContent: [tool_use], toolResults: [FULL(2), FULL(3)] }
```

### Call 1 (with toolRoundTrip from round 0)
```
Messages sent to API:
  [system prompt]
  [DB conversation history]         ← still the ORIGINAL from assembleContext
  [assistant: tool_use(2), tool_use(3)]   ← from toolRoundTrip.previousContent
  [user: FULL result(2), FULL result(3)]  ← from toolRoundTrip.toolResults ✅

LLM response: text "Here's what I found about memory design..." 
              (or more tool calls — see below)
```

**If the LLM is satisfied → loop ends. No bug.**  
**If the LLM calls more tools → proceed to round 1:**

### Round 1 in loop
```
1. Store assistant tool_use in DB
2. Execute whatever tools round 1 needs
3. Set toolRoundTrip = { previousContent: [round 1 tool_use], toolResults: [round 1 results] }
   ← round 0's toolRoundTrip is OVERWRITTEN
```

### Call 2 (with toolRoundTrip from round 1 ONLY)
```
Messages sent to API:
  [system prompt]
  [DB conversation history]         ← SAME original from assembleContext
                                       (does NOT include round 0 or round 1 DB writes)
  [assistant: round 1 tool_use]     ← from toolRoundTrip
  [user: round 1 tool results]     ← from toolRoundTrip

⚠️ Round 0's data is GONE from the API call:
  - The assistant tool_use for library_get(2), library_get(3) → not in messages
  - The full results → not in messages
  - The compressed refs ARE in the DB, but context was assembled before round 0
```

**The LLM has no memory of round 0.** It sees the same base conversation + only round 1's data. If it still needs the library items from round 0, it calls them again.

---

## Why This Is Dangerous

1. **Self-reinforcing loop:** Each re-fetch stores another compressed reference in the DB (increasing DB noise) and wastes a round. The LLM never gets to use the full content long enough to produce a final answer.

2. **MAX_TOOL_ROUNDS = 5:** The loop exhausts all 5 rounds. After round 5, the LLM response is whatever it could cobble together — often empty/silence.

3. **Context grows with each round:** Each round adds assistant tool_use + tool_result messages to the DB. Even compressed, this adds up. By round 5, the DB has 10+ extra messages from the loop.

4. **Cascading failure with Finding 1:** When the shard mismatch caused the LLM to think a question was unanswered, it tried to re-answer it by pulling library items. The compressed reference loop amplified a single shard bug into a 5-round freeze.

---

## Reproduction Scenario

To trigger this without Finding 1 (shard bug is fixed), you need:

1. User asks a question that requires multiple library items
2. Cortex calls `library_get(2)` and `library_get(3)` in round 0
3. Cortex decides it also needs to call another tool (e.g., `code_search` or `memory_query`) — this forces another round
4. In round 1, the LLM executes the other tool
5. In round 2 (call 2), the LLM no longer sees library_get results from round 0
6. If the LLM still needs those items (e.g., to synthesize an answer), it calls them again
7. Repeat

**Simpler trigger:** Any scenario where the LLM makes sync tool calls across 3+ rounds AND one of the early rounds included `library_get`. The library content from early rounds vanishes.

**Note:** This bug also affects `library_search` (same shardContent pattern) but NOT `fetch_chat_history`, `memory_query`, `code_search`, or `get_task_status` — those store FULL results in the DB, so even without re-assembly, if the context WERE re-assembled, they'd be there. But since context isn't re-assembled at all, ALL tools lose their round 0 results in round 2+. The difference is that non-library tools don't trigger re-fetch (the LLM doesn't know the results are compressed — it just doesn't see them).

Actually — **this is important**: the bug affects ALL sync tools, not just library tools. ANY tool result from round N is invisible in round N+2. The library tools just make it worse because:
- The compressed reference is a visible "teaser" that the LLM recognizes as incomplete
- The full result was explicitly withheld (shardContent pattern)
- The LLM has a tool (`library_get`) that can re-fetch it

For non-library tools, the LLM doesn't see round 0's results in round 2, but it also doesn't have a re-fetch mechanism — it just proceeds without them, which may produce a worse answer but won't loop.

---

## The Fix

### Option A: Accumulate all rounds in toolRoundTrip (minimal change)

Instead of overwriting `toolRoundTrip` each round, accumulate:

```typescript
// Before the loop:
const allRoundTrips: Array<{
  previousContent: any[];
  toolResults: ToolResultEntry[];
}> = [];

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  // ... execute sync tools ...

  allRoundTrips.push({
    previousContent: llmResult._rawContent ?? [],
    toolResults,
  });

  context = {
    ...context,
    toolRoundTrips: allRoundTrips,  // plural — ALL rounds
  };
  llmResult = await callLLM(context);
}
```

And in `llm-caller.ts`, append ALL round-trips:

```typescript
if (context.toolRoundTrips) {
  for (const trip of context.toolRoundTrips) {
    consolidated.push({
      role: "assistant",
      content: trip.previousContent,
    });
    consolidated.push({
      role: "user",
      content: trip.toolResults.map(r => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
      })),
    });
  }
}
```

**Pros:** Simple, correct, preserves full content across all rounds.  
**Cons:** Context grows with each round (but it should — the LLM needs all prior results).

### Option B: Re-assemble context each round (heavier)

Call `assembleContext` before each `callLLM`. This picks up the DB writes from previous rounds. But:
- Library tools store compressed refs → LLM still sees compressed, not full
- Would need to keep an in-memory map of `toolCallId → fullContent` to override compressed refs
- More complex, more DB reads, more token estimation

**Recommendation: Option A.** It's a ~20 line change across `loop.ts` and `llm-caller.ts`.

---

## Files to Change

1. **`src/cortex/loop.ts`** (~line 290-350)
   - Replace single `toolRoundTrip` with accumulated `allRoundTrips` array
   - Change `context.toolRoundTrip = ...` to `allRoundTrips.push(...)` + `context.toolRoundTrips = allRoundTrips`

2. **`src/cortex/llm-caller.ts`** (~line 326-340)
   - Replace single `toolRoundTrip` handling with loop over `toolRoundTrips` array
   - Keep backward compat: check for both `toolRoundTrip` (singular) and `toolRoundTrips` (plural)

3. **`src/cortex/context.ts`** (type definition)
   - Add `toolRoundTrips?: Array<{ previousContent: any[]; toolResults: ToolResultEntry[] }>` to `AssembledContext`
   - Keep `toolRoundTrip?` for backward compat

---

## Validation

After the fix, this should hold true:

```
Round 0: library_get(2) → full content
Round 1: code_search("x") → full content  
Round 2 (Call 2): LLM sees:
  - Base DB messages
  - Round 0: assistant tool_use(library_get(2)) + user tool_result(FULL content)  ✅
  - Round 1: assistant tool_use(code_search) + user tool_result(FULL content)     ✅
  → LLM has everything, produces final answer, no re-fetch
```

Test case: ask Cortex a question that triggers library_get + another sync tool in separate rounds. Verify the LLM doesn't re-call library_get in round 2+.
