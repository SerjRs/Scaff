---
id: "008"
title: "Spread replyContext into channelContext instead of cherry-picking"
created: "2026-03-14"
author: "scaff"
executor: ""
branch: "feat/007-task-dispatch-context"
pr: "6"
priority: "high"
status: "in-progress"
moved_at: "2026-03-14T11:05"
---

# 008 — Spread replyContext into channelContext

## Problem

Task 007 introduced `channel_context` as a JSON blob so new channels require zero schema AND zero code changes. But the implementation cherry-picks three known attributes:

```typescript
channelContext: {
  threadId: msg.envelope.replyContext?.threadId,
  accountId: msg.envelope.replyContext?.accountId,
  messageId: msg.envelope.replyContext?.messageId,
},
```

If a future channel adapter adds `topicId`, `guildId`, or any new attribute to `replyContext`, it won't be captured — someone has to edit loop.ts. This partially defeats the design.

## Fix

Spread the entire `replyContext` minus `channel` (which is stored in its own column):

```typescript
const { channel: _, ...channelAttrs } = msg.envelope.replyContext ?? {};
channelContext: channelAttrs,
```

This applies in two places in `src/cortex/loop.ts`:
- Line ~511 (library_ingest spawn)
- Line ~560 (sessions_spawn)

## Tests

### Unit test (e2e-op-lifecycle.test.ts)

Add a test that verifies unknown/future replyContext attributes survive the round-trip:

```typescript
it("channelContext captures arbitrary replyContext attributes", () => {
  // Simulate a future channel that adds custom attributes to replyContext
  // Store dispatch with channelContext containing unexpected keys
  // Retrieve and verify all keys survived serialization
  const taskId = "test-future-channel";
  storeDispatch(db, {
    taskId,
    channel: "telegram",
    channelContext: {
      threadId: "chat-123",
      topicId: 42,
      botToken: "prod",
      customField: "whatever-future-channels-need",
    },
    taskSummary: "Future channel test",
  });
  const dispatch = getDispatch(db, taskId);
  expect(dispatch!.channelContext).toEqual({
    threadId: "chat-123",
    topicId: 42,
    botToken: "prod",
    customField: "whatever-future-channels-need",
  });
});
```

### Integration test (new: dispatch-context-spread.test.ts)

Test that the actual spread logic works correctly — simulating what loop.ts does:

```typescript
import { describe, it, expect } from "vitest";

describe("replyContext spread into channelContext", () => {
  it("spreads all attributes except channel", () => {
    const replyContext = {
      channel: "whatsapp",
      threadId: "+40751845717",
      accountId: "default",
      messageId: "msg-123",
    };
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toEqual({
      threadId: "+40751845717",
      accountId: "default",
      messageId: "msg-123",
    });
    expect(channelAttrs).not.toHaveProperty("channel");
  });

  it("handles replyContext with unknown future attributes", () => {
    const replyContext = {
      channel: "telegram",
      threadId: "chat-123",
      topicId: 42,
      someNewField: "value",
    } as Record<string, unknown>;
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toHaveProperty("topicId", 42);
    expect(channelAttrs).toHaveProperty("someNewField", "value");
    expect(channelAttrs).not.toHaveProperty("channel");
  });

  it("handles empty replyContext", () => {
    const replyContext = { channel: "webchat" };
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toEqual({});
  });

  it("handles undefined replyContext", () => {
    const replyContext = undefined;
    const { channel: _, ...channelAttrs } = replyContext ?? { channel: "unknown" };
    expect(channelAttrs).toEqual({});
  });
});
```

## Files Changed

| File | Change |
|------|--------|
| `src/cortex/loop.ts` | Replace two cherry-picked channelContext blocks with replyContext spread |
| `src/cortex/__tests__/e2e-op-lifecycle.test.ts` | Add arbitrary-attributes round-trip test |
| `src/cortex/__tests__/dispatch-context-spread.test.ts` | New: spread logic integration tests |
