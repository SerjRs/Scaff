---
id: "011"
title: "Cortex loop silence bugs — async/sync tool paths drop user responses"
created: "2026-03-14"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "critical"
status: "done"
branch: "feat/011-cortex-loop-silence-bugs"
pr: "9"
moved_at: "2026-03-14"
---

# 011 — Cortex Loop Silence Bugs

> **Status:** Cooking
> **Priority:** Critical
> **Author:** Scaff
> **Date:** 2026-03-14
> **Related:** src/cortex/loop.ts, src/cortex/llm-caller.ts, src/cortex/output.ts, src/cortex/session.ts

---

## Problem

Cortex goes silent mid-conversation — processes tool calls internally but never delivers a user-facing response. Observed 3 times in a single 50-minute webchat session (2026-03-14, 13:56–14:45 local).

The user sees nothing. Cortex stores `[silence]` in the DB and moves on. No retry, no fallback, no detection.

### Observed Incidents

**Incident 1 — Async tool silence (13:57:29)**
- User asked to review pipeline Cooking
- LLM returned: `thinking + tool_use(sessions_spawn)` — NO text blocks
- `createGatewayLLMCaller` returned `text: "" || "NO_REPLY"`
- Async handler dispatched the spawn successfully
- `parseResponse("NO_REPLY")` → `{ targets: [] }` → silence
- User had to ask "did you get my message?" 30 seconds later

**Incident 2 — Sync tool loop exhaustion (13:58:47)**
- Ops-trigger delivered task result about pipeline/Cooking
- Cortex called `read_file("ACTIVE-ISSUES.md")` 3 times with identical args
- After 3 sync rounds, LLM returned no text → "NO_REPLY" → silence
- User never got the task result summary

**Incident 3 — Sync tool dead-end (14:44:02)**
- User asked why only 4/21 library items have embeddings
- Cortex ran multiple `code_search` queries, got results
- Then tried `read_file("src/library/db.ts")` — file not found (wrong path)
- Tried 4 more path variations — all failed
- LLM finally gave up, returned no text → silence
- User said "Scaff, are you kidding"

---

## Root Causes

### RC1: No fallback when async dispatch produces no text

**Location:** `loop.ts` ~line 310-320

```
const llmResponse = llmResult.text;   // "NO_REPLY" because LLM only produced tool_use
const output = parseResponse({ llmResponse, triggerEnvelope: effectiveEnvelope });
```

The LLM is supposed to produce text alongside async tool calls (system prompt says "respond immediately with an acknowledgment"). But models don't always comply. When `text` is empty and `toolCalls` contains async calls, the loop has no safety net.

**Flow:**
1. LLM returns `{text: "", toolCalls: [sessions_spawn]}`
2. `createGatewayLLMCaller` → `text: "" || "NO_REPLY"`
3. Sync loop: no sync calls → exits immediately
4. Async handler: dispatches spawn, stores tool result
5. `llmResponse = "NO_REPLY"` → `parseResponse` → empty targets → silence

### RC2: Sync loop exits without ensuring text output

**Location:** `loop.ts` ~line 265-310

```typescript
for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const syncCalls = llmResult.toolCalls.filter(tc => SYNC_TOOL_NAMES.has(tc.name));
  if (syncCalls.length === 0) break;
  // ... execute tools, re-call LLM ...
}
const llmResponse = llmResult.text;  // might be "NO_REPLY"
```

After the sync loop exits (either no more sync calls or MAX_TOOL_ROUNDS reached), `llmResult.text` is taken as-is. If the final LLM response had tool calls but no text, it's "NO_REPLY" → silence.

No check: "did we use tools but produce no answer?"

### RC3: No dedup in sync tool loop

**Location:** `loop.ts` sync tool loop

The loop doesn't track which tool calls have already been made. Cortex called `read_file("ACTIVE-ISSUES.md")` 3 times with identical arguments. Each time: execute → store → re-call LLM. Wastes rounds and tokens.

### RC4: code_search returns relative paths, read_file can't resolve them

**Location:** tools.ts `executeReadFile` + `executeCodeSearch`

`code_search` returns paths like `src/library/db.ts` (relative to repo root `~/.openclaw/`). But `read_file` resolves paths relative to `workspaceDir` (`~/.openclaw/workspace/`). So `read_file("src/library/db.ts")` → file not found.

This caused Cortex to loop through path variations: `src/library/db.ts`, `.openclaw/src/library/db.ts`, etc. — all failing. After burning through rounds, it went silent.

---

## Fixes

### Fix 1: Async dispatch fallback message

**File:** `loop.ts`, after async tool processing (~line 320)

When async calls were dispatched AND `llmResult.text` is "NO_REPLY":
- Synthesize a fallback response: route a message to the user's channel
- Text: based on tool type — for `sessions_spawn`: "Working on it — I'll have results shortly."

```typescript
// After async dispatch, before parseResponse
if (asyncCalls.length > 0 && (llmResponse === "NO_REPLY" || llmResponse.trim() === "")) {
  // Override with synthetic acknowledgment
  llmResponse = asyncCalls.some(tc => tc.name === "library_ingest")
    ? "Ingesting that into the Library — I'll confirm when it's stored."
    : "On it — working in the background. I'll have results shortly.";
}
```

### Fix 2: Post-sync-loop text guard

**File:** `loop.ts`, after sync tool loop (~line 310)

When ≥1 sync tool round was executed AND `llmResult.text` is "NO_REPLY":
- Inject a system nudge and re-call the LLM ONE more time
- Nudge: `[System: You executed tools but produced no visible response. Summarize your findings for the user now.]`

```typescript
// After sync loop exits
if (allRoundTrips.length > 0 && (!llmResult.text || llmResult.text === "NO_REPLY")) {
  // Safety re-call with nudge
  const nudge: ToolResultEntry = {
    toolCallId: "system-nudge",
    toolName: "system",
    content: "[System: You used tools but produced no response. Summarize your findings for the user.]",
  };
  // Add nudge as a synthetic tool result and re-call
  // Implementation detail: may need a user-role text message instead of tool_result
  context = { ...context, toolRoundTrips: [...allRoundTrips] };
  // Append a user-role nudge to the context messages
  llmResult = await callLLM({
    ...context,
    _silenceNudge: true,  // flag for contextToMessages to append nudge
  });
}
```

Alternative (simpler): if text is empty after sync rounds, collect tool results and produce a summary:
```typescript
if (allRoundTrips.length > 0 && (!llmResult.text || llmResult.text === "NO_REPLY")) {
  const toolSummary = allRoundTrips
    .flatMap(r => r.toolResults)
    .map(r => `${r.toolName}: ${r.content.substring(0, 200)}`)
    .join("\n");
  llmResponse = `Here's what I found:\n\n${toolSummary}`;
}
```

### Fix 3: Sync tool dedup

**File:** `loop.ts`, inside sync tool loop

Track `Map<string, string>` of `hash(toolName + JSON.stringify(args))` → result. If a call repeats:
- Return cached result instead of re-executing
- Inject warning: `[System: You already called ${toolName} with these arguments. Result was returned previously. Do not repeat.]`

```typescript
const toolCallCache = new Map<string, string>();

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  // ... existing code ...
  for (const tc of syncCalls) {
    const cacheKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
    if (toolCallCache.has(cacheKey)) {
      result = toolCallCache.get(cacheKey)! + "\n[Note: This is a cached result — you already made this exact call.]";
    } else {
      // ... execute tool ...
      toolCallCache.set(cacheKey, result);
    }
  }
}
```

### Fix 4: code_search path hint in results

**File:** `tools.ts` `executeCodeSearch`

Append a note to code_search results telling Cortex how to resolve paths:

```
Note: These paths are relative to the OpenClaw install root (~/.openclaw/).
To read them with read_file, prefix with the install path:
  read_file({ path: "C:\\Users\\Temp User\\.openclaw\\src\\library\\db.ts" })
Or use code_search snippets directly — they contain the relevant code.
```

This eliminates the "path not found" loop entirely.

---

## Testing

- **Unit test:** Simulate async-only LLM response → verify fallback message is produced
- **Unit test:** Simulate 3 sync rounds → empty text on round 4 → verify nudge re-call or summary
- **Unit test:** Simulate duplicate read_file calls → verify dedup + cache hit
- **Integration test:** code_search → read_file path resolution → no file-not-found loop

---

## Impact

- **User experience:** Eliminates mid-conversation silence (3 incidents in 50 min = ~6% silence rate)
- **Token waste:** Dedup prevents repeated identical tool calls (estimated 30-50% token savings in loops)
- **Reliability:** Safety net ensures Cortex always produces a response when user is waiting

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/cortex/loop.ts` | Fix 1 (async fallback), Fix 2 (post-sync guard), Fix 3 (dedup) |
| `src/cortex/tools.ts` | Fix 4 (code_search path hint) |
| `src/cortex/__tests__/loop-silence.test.ts` | New test file for all scenarios |
