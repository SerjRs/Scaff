import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession } from "../session.js";
import { createEnvelope } from "../types.js";
import {
  createShard,
  closeShard,
  assignMessageToShard,
  getActiveShard,
  getShardMessages,
  detectTopicShift,
  labelShardAsync,
  applyTopicShift,
  updateShardTopic,
  type ShardLLMFunction,
  type ShardMessage,
} from "../shards.js";
import { estimateTokens } from "../context.js";
import { executeFetchChatHistory } from "../tools.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shards-sem-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function appendAndGetId(channel = "webchat", content = "test", timestamp?: string): number {
  const env = createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    timestamp: timestamp ?? new Date().toISOString(),
  });
  appendToSession(db, env);
  const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number | bigint };
  return Number(row.id);
}

// ---------------------------------------------------------------------------
// detectTopicShift
// ---------------------------------------------------------------------------

describe("detectTopicShift", () => {
  it("detects a clear topic shift", async () => {
    const messages: ShardMessage[] = [
      { id: 1, role: "user", senderId: "serj", content: "Let's fix the token monitor bug", timestamp: "2026-03-09T10:00:00Z" },
      { id: 2, role: "assistant", senderId: "cortex", content: "Sure, I see the issue in the TASK column", timestamp: "2026-03-09T10:01:00Z" },
      { id: 3, role: "user", senderId: "serj", content: "Great, that's fixed. Now let's work on the executor sandbox", timestamp: "2026-03-09T10:10:00Z" },
      { id: 4, role: "assistant", senderId: "cortex", content: "OK, looking at the executor isolation setup", timestamp: "2026-03-09T10:11:00Z" },
      { id: 5, role: "user", senderId: "serj", content: "The sandbox needs to restrict filesystem access", timestamp: "2026-03-09T10:12:00Z" },
    ];

    const mockLLM: ShardLLMFunction = async () =>
      '{"shifted": true, "splitAtId": 3, "oldTopic": "Token monitor bug fix", "newTopic": "Executor sandbox setup"}';

    const result = await detectTopicShift(messages, mockLLM);
    expect(result.shifted).toBe(true);
    expect(result.splitAtId).toBe(3);
    expect(result.oldTopic).toBe("Token monitor bug fix");
    expect(result.newTopic).toBe("Executor sandbox setup");
  });

  it("returns no shift for same-topic messages", async () => {
    const messages: ShardMessage[] = [
      { id: 1, role: "user", senderId: "serj", content: "The token monitor shows wrong counts", timestamp: "2026-03-09T10:00:00Z" },
      { id: 2, role: "assistant", senderId: "cortex", content: "Let me check the aggregation logic", timestamp: "2026-03-09T10:01:00Z" },
      { id: 3, role: "user", senderId: "serj", content: "Also the TASK column is empty", timestamp: "2026-03-09T10:02:00Z" },
    ];

    const mockLLM: ShardLLMFunction = async () => '{"shifted": false}';

    const result = await detectTopicShift(messages, mockLLM);
    expect(result.shifted).toBe(false);
    expect(result.splitAtId).toBeUndefined();
  });

  it("returns no shift for fewer than 3 messages", async () => {
    const messages: ShardMessage[] = [
      { id: 1, role: "user", senderId: "serj", content: "hello", timestamp: "2026-03-09T10:00:00Z" },
      { id: 2, role: "assistant", senderId: "cortex", content: "hi", timestamp: "2026-03-09T10:01:00Z" },
    ];

    const mockLLM: ShardLLMFunction = vi.fn();

    const result = await detectTopicShift(messages, mockLLM);
    expect(result.shifted).toBe(false);
    // LLM should not have been called
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it("handles LLM failure gracefully", async () => {
    const messages: ShardMessage[] = [
      { id: 1, role: "user", senderId: "serj", content: "a", timestamp: "2026-03-09T10:00:00Z" },
      { id: 2, role: "assistant", senderId: "cortex", content: "b", timestamp: "2026-03-09T10:01:00Z" },
      { id: 3, role: "user", senderId: "serj", content: "c", timestamp: "2026-03-09T10:02:00Z" },
    ];

    const mockLLM: ShardLLMFunction = async () => { throw new Error("API timeout"); };

    const result = await detectTopicShift(messages, mockLLM);
    expect(result.shifted).toBe(false);
  });

  it("rejects invalid splitAtId", async () => {
    const messages: ShardMessage[] = [
      { id: 1, role: "user", senderId: "serj", content: "a", timestamp: "2026-03-09T10:00:00Z" },
      { id: 2, role: "assistant", senderId: "cortex", content: "b", timestamp: "2026-03-09T10:01:00Z" },
      { id: 3, role: "user", senderId: "serj", content: "c", timestamp: "2026-03-09T10:02:00Z" },
    ];

    // LLM returns a splitAtId that doesn't exist in the messages
    const mockLLM: ShardLLMFunction = async () =>
      '{"shifted": true, "splitAtId": 999, "oldTopic": "Old", "newTopic": "New"}';

    const result = await detectTopicShift(messages, mockLLM);
    expect(result.shifted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// labelShardAsync
// ---------------------------------------------------------------------------

describe("labelShardAsync", () => {
  it("labels a shard and updates the topic", async () => {
    const msgId1 = appendAndGetId("webchat", "Let's fix the TASK column", "2026-03-09T10:00:00Z");
    const msgId2 = appendAndGetId("webchat", "I found the issue in the evaluator", "2026-03-09T10:01:00Z");

    const shard = createShard(db, "webchat", msgId1, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId1, shard.id);
    assignMessageToShard(db, msgId2, shard.id);
    closeShard(db, shard.id, msgId2, "2026-03-09T10:01:00Z");

    const mockLLM: ShardLLMFunction = async () => "TASK column evaluator fix";

    const label = await labelShardAsync(db, shard.id, mockLLM);
    expect(label).toBe("TASK column evaluator fix");

    // Verify the shard topic was updated in the database
    const row = db.prepare("SELECT topic FROM cortex_shards WHERE id = ?").get(shard.id) as { topic: string };
    expect(row.topic).toBe("TASK column evaluator fix");
  });

  it("handles empty shard gracefully", async () => {
    const msgId = appendAndGetId("webchat", "hello", "2026-03-09T10:00:00Z");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    // Don't assign any messages to the shard

    const mockLLM: ShardLLMFunction = vi.fn();

    const label = await labelShardAsync(db, shard.id, mockLLM);
    expect(label).toBe("Empty conversation");
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it("handles LLM failure gracefully", async () => {
    const msgId = appendAndGetId("webchat", "hello", "2026-03-09T10:00:00Z");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId, shard.id);

    const mockLLM: ShardLLMFunction = async () => { throw new Error("API error"); };

    const label = await labelShardAsync(db, shard.id, mockLLM);
    expect(label).toBe("Continued conversation");
  });
});

// ---------------------------------------------------------------------------
// applyTopicShift
// ---------------------------------------------------------------------------

describe("applyTopicShift", () => {
  it("splits a shard at the detected shift point", () => {
    // Create 5 messages, shift at message 4
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(appendAndGetId("webchat", `msg ${i}`, `2026-03-09T10:0${i}:00Z`));
    }

    const shard = createShard(db, "webchat", ids[0], "2026-03-09T10:00:00Z");
    for (const id of ids) {
      assignMessageToShard(db, id, shard.id);
    }
    // Update shard counts
    db.prepare("UPDATE cortex_shards SET last_message_id = ?, message_count = 5, token_count = 50 WHERE id = ?")
      .run(ids[4], shard.id);

    const newShardId = applyTopicShift(db, "webchat", shard.id, ids[3], "Old topic", "New topic");

    // Old shard should be closed with old topic
    const oldRow = db.prepare("SELECT topic, ended_at FROM cortex_shards WHERE id = ?").get(shard.id) as any;
    expect(oldRow.topic).toBe("Old topic");
    expect(oldRow.ended_at).not.toBeNull();

    // New shard should exist with new topic
    expect(newShardId).not.toBe(shard.id);
    const newRow = db.prepare("SELECT topic, message_count FROM cortex_shards WHERE id = ?").get(newShardId) as any;
    expect(newRow.topic).toBe("New topic");
    expect(Number(newRow.message_count)).toBe(2); // messages 4 and 5

    // Messages should be reassigned
    const oldMsgs = getShardMessages(db, shard.id);
    const newMsgs = getShardMessages(db, newShardId);
    expect(oldMsgs).toHaveLength(3); // messages 1-3
    expect(newMsgs).toHaveLength(2); // messages 4-5
  });

  it("does nothing when splitAtId is the first message", () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(appendAndGetId("webchat", `msg ${i}`, `2026-03-09T10:0${i}:00Z`));
    }

    const shard = createShard(db, "webchat", ids[0], "2026-03-09T10:00:00Z");
    for (const id of ids) {
      assignMessageToShard(db, id, shard.id);
    }

    // Can't split at first message (nothing would go in old shard)
    const result = applyTopicShift(db, "webchat", shard.id, ids[0], "Old", "New");
    expect(result).toBe(shard.id); // Returns original shard ID
  });
});

// ---------------------------------------------------------------------------
// fetch_chat_history shard_id mode
// ---------------------------------------------------------------------------

describe("fetch_chat_history shard_id mode", () => {
  it("returns all messages from a specific shard", () => {
    const msgId1 = appendAndGetId("webchat", "shard msg A", "2026-03-09T10:00:00Z");
    const msgId2 = appendAndGetId("webchat", "shard msg B", "2026-03-09T10:01:00Z");
    appendAndGetId("webchat", "unsharded msg", "2026-03-09T10:02:00Z");

    const shard = createShard(db, "webchat", msgId1, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId1, shard.id);
    assignMessageToShard(db, msgId2, shard.id);

    const result = JSON.parse(
      executeFetchChatHistory(db, { channel: "webchat", shard_id: shard.id }),
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("shard msg A");
    expect(result[1].content).toBe("shard msg B");
  });

  it("returns empty array for non-existent shard", () => {
    const result = JSON.parse(
      executeFetchChatHistory(db, { channel: "webchat", shard_id: "non-existent-id" }),
    );
    expect(result).toHaveLength(0);
  });

  it("existing channel/limit/before mode still works", () => {
    appendAndGetId("webchat", "msg 1", "2026-03-09T10:00:00Z");
    appendAndGetId("webchat", "msg 2", "2026-03-09T10:01:00Z");
    appendAndGetId("webchat", "msg 3", "2026-03-09T10:02:00Z");

    const result = JSON.parse(
      executeFetchChatHistory(db, { channel: "webchat", limit: 2 }),
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("msg 2");
    expect(result[1].content).toBe("msg 3");
  });
});
