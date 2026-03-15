---
id: "020g"
title: "Cortex E2E — Recovery & Error Handling"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
depends_on: []
---

# 020g — Cortex E2E: Recovery & Error Handling

## Goal
Test resilience: LLM failures, adapter failures, queue ordering under failure, and idempotent message processing.

## Category: H (Recovery & Error Handling)

## Test File
`src/cortex/__tests__/e2e-webchat-recovery.test.ts`

## Tests (~4)

### H. Recovery & Error Handling

**H1. LLM call failure → message marked failed**
Mock callLLM that throws an error → verify message is marked "failed" in bus, adapter.send receives error notification or graceful degradation.

**H2. Adapter send failure → error logged, loop continues**
Register adapter whose send() throws → send message, verify error is captured but loop continues processing the next message.

**H3. Queue ordering preserved on failure**
Enqueue 3 messages, first one's LLM call fails → verify messages 2 and 3 still process in order successfully.

**H4. Idempotent message processing**
Enqueue same message ID twice → verify it's only processed once (dedup by envelope_id).

## Notes
- Recovery behavior is in loop.ts: `markFailed()` on LLM error, continue loop
- Adapter send errors should not kill the loop
- Existing e2e-recovery.test.ts may cover some of this — these tests add webchat-specific paths

## Test Results
`workspace/pipeline/Cooking/020g-cortex-e2e/TEST-RESULTS.md`
