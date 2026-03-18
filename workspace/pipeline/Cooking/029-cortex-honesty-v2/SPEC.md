---
id: "029"
title: "Cortex Honesty v2 — Architectural enforcement + executor prompt tightening"
priority: critical
assignee: scaff
status: cooking
created: 2026-03-18
updated: 2026-03-18
type: fix
depends_on: ["026"]
tech: typescript
---

# Cortex Honesty v2 — Architectural enforcement + executor prompt tightening

## Problem

Task 026 added system prompt honesty rules, but the LLM still violates them consistently. From the March 18 01:45 EET Cortex session:

1. **00:01** — "I spawned a diagnostic task" — no tool call present in the response
2. **01:04** — "Let me retry with a tighter, single-command task" — no tool call present
3. **01:12** — "let me retry" — caught itself again, same pattern

The root cause: **system prompt rules alone cannot prevent this.** The LLM generates intent text ("I spawned", "Let me retry") as part of its reasoning, and the current architecture delivers whatever text the LLM emits before tool calls are validated. By the time the assistant text reaches the user, the lie is already sent.

Additionally, executor tasks return unstructured freeform text, leading to truncated or useless results (the first diagnostic task returned a partial sentence instead of data).

## Three Fixes

### Fix 1 — Post-generation intent detection (P0)

**Problem:** LLM writes "I spawned X" or "Let me retry" as text, but no tool call accompanies it.

**Solution:** After the LLM response is parsed but before delivery, scan the assistant text for intent/action claims. If the text claims an action but the response contains zero tool calls, suppress the text and replace it with a generic safe response.

**Implementation in `src/cortex/loop.ts`:**

```typescript
// After parsing LLM response, before delivery:
if (toolCalls.length === 0 && containsActionClaim(llmResponseFinal)) {
  // LLM claimed it did something but included no tool calls — suppress
  llmResponseFinal = "NO_REPLY";
  // Re-queue with a system nudge: "You said you would do X but included no tool call.
  // Either include the tool call now or tell the user what you plan to do."
  appendSystemNudge(db, channel, "You claimed an action but included no tool call. " +
    "Include the actual tool call or rephrase as a plan/intention.");
}
```

**`containsActionClaim(text)` heuristics:**
Match patterns like:
- "I spawned" / "I dispatched" / "I fired" / "I triggered" / "I started"
- "On it" / "Working on it" / "Doing it now"
- "Let me [verb]" followed by no tool call (tricky — "Let me think" is fine, "Let me spawn" is not)
- Past-tense action verbs paired with tool-related nouns ("spawned a task", "ingested the URL", "ran the check")

Use a simple regex-based detector, not LLM evaluation (too slow/expensive). False positives are acceptable — better to suppress a valid message and retry than deliver a lie.

**Edge cases:**
- "I'll try that" → OK (future tense, vague)
- "I spawned task X" with a tool call present → OK (tool call validates the claim)
- "Let me check" → OK (no specific action claim)
- "Fired all 4" with only 2 tool calls → harder to detect, defer to Fix 2

### Fix 2 — System prompt strengthening (P1)

The current honesty rules (026) are 4 paragraphs of prose. LLMs respond better to:
- Shorter, more absolute rules
- Rules positioned earlier in the system prompt (primacy effect)
- Negative framing ("NEVER do X") over instructional ("try to do X")

**Replace the current honesty block in `src/cortex/llm-caller.ts` (lines 291–309) with:**

```
## ABSOLUTE RULES — VIOLATION = SYSTEM FAILURE
1. NO PAST-TENSE ACTION CLAIMS WITHOUT TOOL CALLS. If your response says "I spawned/ingested/ran/started X" but contains zero tool_use blocks, you have LIED. This is a system failure.
2. TOOL CALLS GO IN THE SAME TURN AS THE CLAIM. "On it" + tool_call = OK. "On it" alone = LIE.
3. WHEN IN DOUBT, DESCRIBE INTENT: "I'll try X" or "Let me X" — never "I did X" or "X is running".
4. ASYNC RESULTS ARE UNKNOWN. After spawning a task, say "Task dispatched" — never "Working on it" or "Almost done".
```

Position this block FIRST in the system prompt (before identity, before tools description).

### Fix 3 — Executor prompt tightening (P1)

**Problem:** Executor tasks (dispatched via `sessions_spawn`) return unstructured freeform text. The first diagnostic task on March 18 returned: *"Let me also grab the `ollama list` output directly since it got cut off:"* — a partial sentence with no data.

**Solution:** Add structured output requirements to the task dispatch prompt template.

When Cortex dispatches a task via `sessions_spawn`, the task description should include a mandatory output format:

**In `src/cortex/tools.ts` — modify the `sessions_spawn` call wrapper or the system prompt template for dispatched tasks:**

Add a suffix to every dispatched task:

```
RESPONSE FORMAT (mandatory):
Return ONLY a structured result. No preamble, no commentary, no "Let me..." text.
Format:
STATUS: success | failure | partial
FINDINGS:
- [finding 1]
- [finding 2]
ERROR: [if any]
If you cannot complete the task, return STATUS: failure with a clear ERROR explaining why.
```

**Where to add it:**
- If tasks go through `executeSessionsSpawn()` in `tools.ts` — append the format suffix to the task description
- If tasks go through the router/dispatcher — add it to the executor prompt template

**Note:** This only applies to diagnostic/investigation tasks dispatched by Cortex. Pipeline tasks (coding, specs) have their own CLAUDE.md and should not be affected.

## Files to Modify

| File | Change |
|------|--------|
| `src/cortex/loop.ts` | Add `containsActionClaim()` check after LLM response, before delivery |
| `src/cortex/llm-caller.ts` | Replace honesty rules block with shorter, absolute rules; move to top of system prompt |
| `src/cortex/tools.ts` | Add structured output suffix to `sessions_spawn` task descriptions |

## Files NOT to Modify

- `src/cortex/context.ts` — system floor assembly
- `src/cortex/tools.ts` tool definitions (only the execution wrappers)
- Any test files (but new tests should be added)

## Tests

### Unit Tests (new in `src/cortex/__tests__/`)

**`containsActionClaim` detector:**
- "I spawned a diagnostic task" → true
- "I dispatched task 97a2d47a" → true
- "On it — working in the background" → true
- "Let me check" → false
- "I'll try that" → false
- "The task completed" → false (reporting, not claiming action)
- "Task dispatched" with tool_call present → should NOT be suppressed (test the full flow)

**System prompt positioning:**
- Verify honesty rules appear before identity/tools in assembled system prompt

**Executor prompt suffix:**
- Verify dispatched tasks include the structured output format suffix

### E2E Tests (extend existing webchat E2E)

- LLM response with action claim + no tool call → message suppressed, nudge appended
- LLM response with action claim + tool call present → message delivered normally
- Executor task returns structured format → result parsed correctly

## Verification (Manual)

After deployment:
1. Enable Cortex on webchat
2. Send a URL for library ingestion
3. Verify Cortex says "Task dispatched" (not "On it" or "Ingesting now") until tool call confirms
4. Dispatch a diagnostic task → verify result uses structured format
5. Deliberately stall a tool (simulate failure) → verify Cortex doesn't claim success

## Out of Scope

- Callback wakeup reliability (the 47-minute silence is a separate issue)
- `library_get` truncation bug (separate task)
- Silence watchdog / timeout (separate task)
- Changes to the Router evaluator
