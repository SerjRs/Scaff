---
id: "011"
title: "Cortex loop silence bugs"
priority: high
author: user
status: in-progress
executor: claude-opus
branch: feat/011-cortex-loop-silence-bugs
pr: pending
moved_at: "2026-03-14"
---

# 011 — Cortex Loop Silence Bugs

## Problem

When the LLM uses tools but produces no text content, `llmResult.text` defaults to `"NO_REPLY"`. 
`parseResponse("NO_REPLY")` returns `{ targets: [] }` → silence. The user sees nothing.

This manifests in two scenarios:
1. **Async dispatch silence**: LLM calls `sessions_spawn` or `library_ingest` but says nothing → user gets no acknowledgement
2. **Post-sync-loop silence**: LLM uses sync tools (read_file, code_search, etc.) across multiple rounds but produces no final text summary

Additionally, there's no deduplication for sync tool calls, leading to wasted API calls when the LLM repeats identical tool calls across rounds.

## Fixes

### Fix 1 — Async dispatch fallback
**File:** `src/cortex/loop.ts`
**Location:** After async tool dispatch section (after the `for (const tc of asyncCalls)` loop)

When `asyncCalls.length > 0` and `llmResult.text` is empty or `"NO_REPLY"`, synthesize a fallback message:
`"On it — working in the background."`

This ensures the user gets feedback when async work is dispatched.

### Fix 2 — Post-sync-loop text guard  
**File:** `src/cortex/loop.ts`
**Location:** After the sync tool loop exits (`for (let round = 0; round < MAX_TOOL_ROUNDS; round++)`)

If ≥1 sync round executed but `llmResult.text` is `"NO_REPLY"`:
1. Inject a system nudge and re-call LLM once: `"[System: You used tools but produced no response. Summarize your findings for the user.]"`
2. If nudge re-call still returns `"NO_REPLY"`, produce a raw tool summary fallback listing which tools were called

### Fix 3 — Sync tool dedup
**File:** `src/cortex/loop.ts`  
**Location:** Inside the sync tool execution loop

Track a `Map<string, string>` of `hash(toolName + JSON.stringify(args))` → cached result.
If an identical call repeats, return the cached result + append a warning note:
`"[Cached — identical call already executed this turn]"`

### Fix 4 — code_search path hint
**File:** `src/cortex/tools.ts`
**Location:** `executeCodeSearch` function, at the end of the successful result

Append a note to the code_search output:
`"\n\nNote: Paths above are relative to the OpenClaw install root, not the agent workspace. Use code snippets directly or resolve with the install path."`

## Test Plan

New test file: `src/cortex/__tests__/loop-silence.test.ts`

- Test Fix 1: LLM returns tool_use for sessions_spawn + NO_REPLY text → adapter receives fallback message
- Test Fix 2: LLM uses sync tools but final text is NO_REPLY → nudge re-call fires, then fallback summary
- Test Fix 3: Same sync tool called twice with same args → second call returns cached result
- Test Fix 4: code_search output includes path hint note
