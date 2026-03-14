/**
 * E2E: Task Dispatch Context Lifecycle (007)
 *
 * Tests for cortex_task_dispatch table and dispatch context management.
 * Replaces the old cortex_pending_ops functionality with correlation-based
 * task ownership by Cortex.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { storeDispatch, getDispatch, completeDispatch, initSessionTables, type TaskDispatch } from "../session.js";

describe("cortex_task_dispatch lifecycle", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    // Create in-memory database and run migrations
    db = new DatabaseSync(":memory:");
    initSessionTables(db);
  });

  it("storeDispatch + getDispatch round-trips correctly", () => {
    const taskId = "test-task-123";
    const sampleChannelContext = {
      threadId: "+40751845717",
      accountId: "default",
      messageId: "msg-456"
    };

    // Store dispatch with full context
    storeDispatch(db, {
      taskId,
      channel: "whatsapp",
      channelContext: sampleChannelContext,
      counterpartId: "serj",
      counterpartName: "Serj",
      shardId: "shard-789",
      taskSummary: "Test task for unit testing",
      priority: "urgent",
      executor: "coding",
      issuer: "agent:main:cortex",
    });

    // Retrieve and verify
    const dispatch = getDispatch(db, taskId);
    expect(dispatch).toBeDefined();
    expect(dispatch!.taskId).toBe(taskId);
    expect(dispatch!.channel).toBe("whatsapp");
    expect(dispatch!.channelContext).toEqual(sampleChannelContext);
    expect(dispatch!.counterpartId).toBe("serj");
    expect(dispatch!.counterpartName).toBe("Serj");
    expect(dispatch!.shardId).toBe("shard-789");
    expect(dispatch!.taskSummary).toBe("Test task for unit testing");
    expect(dispatch!.priority).toBe("urgent");
    expect(dispatch!.executor).toBe("coding");
    expect(dispatch!.issuer).toBe("agent:main:cortex");
    expect(dispatch!.status).toBe("pending");
    expect(dispatch!.completedAt).toBeNull();
    expect(dispatch!.result).toBeNull();
    expect(dispatch!.error).toBeNull();
    expect(dispatch!.dispatchedAt).toBeDefined();
  });

  it("completeDispatch updates status and result", () => {
    const taskId = "test-task-456";

    // Store initial dispatch
    storeDispatch(db, {
      taskId,
      channel: "webchat",
      taskSummary: "Task to be completed",
      priority: "normal",
    });

    // Complete with success
    completeDispatch(db, taskId, "completed", "Task completed successfully");

    // Verify completion
    const dispatch = getDispatch(db, taskId);
    expect(dispatch!.status).toBe("completed");
    expect(dispatch!.result).toBe("Task completed successfully");
    expect(dispatch!.completedAt).toBeDefined();
    expect(dispatch!.error).toBeNull();

    // Test failure completion
    const failedTaskId = "test-task-789";
    storeDispatch(db, {
      taskId: failedTaskId,
      channel: "webchat",
      taskSummary: "Task to fail",
      priority: "normal",
    });

    completeDispatch(db, failedTaskId, "failed", undefined, "Something went wrong");

    const failedDispatch = getDispatch(db, failedTaskId);
    expect(failedDispatch!.status).toBe("failed");
    expect(failedDispatch!.error).toBe("Something went wrong");
    expect(failedDispatch!.result).toBeNull();
    expect(failedDispatch!.completedAt).toBeDefined();
  });

  it("getDispatch returns null for unknown taskId", () => {
    const result = getDispatch(db, "nonexistent-task");
    expect(result).toBeNull();
  });

  it("channelContext handles null gracefully", () => {
    const taskId = "test-task-null-context";

    // Store with null channelContext
    storeDispatch(db, {
      taskId,
      channel: "cron",
      channelContext: null,
      taskSummary: "System task with no channel context",
      priority: "background",
    });

    // Verify null is preserved
    const dispatch = getDispatch(db, taskId);
    expect(dispatch!.channelContext).toBeNull();
    expect(dispatch!.channel).toBe("cron");
  });

  it("JSON serialization handles complex channel context", () => {
    const taskId = "test-complex-context";
    const complexContext = {
      guildId: "123456789",
      channelId: "987654321",
      threadId: "555444333",
      nested: {
        data: "value",
        array: [1, 2, 3]
      }
    };

    storeDispatch(db, {
      taskId,
      channel: "discord",
      channelContext: complexContext,
      taskSummary: "Discord task with complex context",
      priority: "normal",
    });

    const dispatch = getDispatch(db, taskId);
    expect(dispatch!.channelContext).toEqual(complexContext);
  });

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
      priority: "normal",
    });
    const dispatch = getDispatch(db, taskId);
    expect(dispatch!.channelContext).toEqual({
      threadId: "chat-123",
      topicId: 42,
      botToken: "prod",
      customField: "whatever-future-channels-need",
    });
  });
});
