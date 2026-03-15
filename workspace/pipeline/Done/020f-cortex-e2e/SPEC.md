---
id: "020f"
title: "Cortex E2E — Foreground Sharding"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: []
---

# 020f — Cortex E2E: Foreground Sharding via Webchat

## Goal
Test foreground sharding: message-to-shard assignment, token overflow shard boundaries, and ops trigger routing to the correct shard.

## Category: G (Foreground Sharding)

## Test File
`src/cortex/__tests__/e2e-webchat-sharding.test.ts`

## Tests (~3)

### G. Foreground Sharding

**G1. Messages assigned to shards**
Enable foreground sharding, send messages via webchat → verify cortex_shards table has an active shard with correct message_count and channel="webchat".

**G2. Shard boundary on token overflow**
Send enough messages to exceed the shard token budget → verify a new shard is created, old shard is closed/ended.

**G3. Ops trigger assigned to correct shard**
Send webchat messages (creates a shard), then enqueue an ops_trigger → verify the trigger is assigned to the active webchat shard (not creating a new one).

## Notes
- Sharding is configured via `foregroundSharding` option in startCortex
- Shard boundaries detected by `assignMessageWithBoundaryDetection()` in shards.ts
- Token budget per shard drives boundary detection

## Test Results
`workspace/pipeline/Cooking/020f-cortex-e2e/TEST-RESULTS.md`
