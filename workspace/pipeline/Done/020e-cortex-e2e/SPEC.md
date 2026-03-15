---
id: "020e"
title: "Cortex E2E — Async Delegation"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: []
---

# 020e — Cortex E2E: Async Delegation via Webchat

## Goal
Test the async delegation flow: LLM spawns a sub-task via `sessions_spawn`, receives results via ops_trigger envelopes, and delivers summaries back through webchat.

## Category: F (Async Delegation)

## Test File
`src/cortex/__tests__/e2e-webchat-delegation.test.ts`

## Tests (~3)

### F. Async Delegation

**F1. sessions_spawn triggers onSpawn callback**
Mock LLM calls `sessions_spawn` tool → verify the onSpawn callback is invoked with task details (task text, executor, model).

**F2. Task result delivery via ops trigger**
Simulate task completion by enqueuing an ops_trigger envelope with taskStatus="completed" and result content → verify LLM is called with task result context and delivers summary to webchat.

**F3. Task failure delivery**
Enqueue ops_trigger with taskStatus="failed" and error details → verify LLM receives error context and informs the user appropriately.

## Notes
- `sessions_spawn` is an async tool — it returns immediately with a task ID, actual work happens externally
- Results come back as `ops_trigger` envelopes which the loop processes like regular messages
- The `onSpawn` callback is how Cortex signals the gateway to actually start the sub-agent

## Test Results
`workspace/pipeline/Cooking/020e-cortex-e2e/TEST-RESULTS.md`
