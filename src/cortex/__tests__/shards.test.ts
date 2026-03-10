import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession, getSessionHistory } from "../session.js";
import { createEnvelope } from "../types.js";
import {
  getActiveShard,
  createShard,
  closeShard,
  assignMessageToShard,
  getShardTokenCount,
  getClosedShards,
  getShardMessages,
  assignMessageWithBoundaryDetection,
  DEFAULT_FOREGROUND_CONFIG,
  type ForegroundConfig,
} from "../shards.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shards-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEnvelope(channel = "webchat", content = "test", timestamp?: string) {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

function appendAndGetId(channel = "webchat", content = "test", timestamp?: string): number {
  const env = makeEnvelope(channel, content, timestamp);
  appendToSession(db, env);
  const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number | bigint };
  return Number(row.id);
}

// ---------------------------------------------------------------------------
// Schema Migration
// ---------------------------------------------------------------------------

describe("schema migration", () => {
  it("creates cortex_shards table on init", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_shards'"
    ).get() as { name: string } | undefined;
    expect(tables).toBeDefined();
    expect(tables!.name).toBe("cortex_shards");
  });

  it("adds shard_id column to cortex_session", () => {
    const cols = db.prepare("PRAGMA table_info(cortex_session)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("shard_id");
  });
});

// ---------------------------------------------------------------------------
// Create & Close Shard
// ---------------------------------------------------------------------------

describe("createShard / closeShard", () => {
  it("creates a shard with correct defaults", () => {
    const msgId = appendAndGetId("webchat", "hello");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");

    expect(shard.id).toBeDefined();
    expect(shard.channel).toBe("webchat");
    expect(shard.topic).toBe("Continued conversation");
    expect(shard.firstMessageId).toBe(msgId);
    expect(shard.tokenCount).toBe(0);
    expect(shard.messageCount).toBe(0);
    expect(shard.endedAt).toBeNull();
    expect(shard.createdBy).toBe("inline");
  });

  it("closes a shard with correct token_count and message_count", () => {
    const msgId1 = appendAndGetId("webchat", "first message here");
    const shard = createShard(db, "webchat", msgId1, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId1, shard.id);

    const msgId2 = appendAndGetId("webchat", "second message here");
    assignMessageToShard(db, msgId2, shard.id);

    closeShard(db, shard.id, msgId2, "2026-03-09T10:05:00Z");

    // Read back
    const closed = getClosedShards(db, "webchat");
    expect(closed).toHaveLength(1);
    expect(closed[0].endedAt).toBe("2026-03-09T10:05:00Z");
    expect(closed[0].lastMessageId).toBe(msgId2);
    expect(closed[0].messageCount).toBe(2);
    expect(closed[0].tokenCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getActiveShard
// ---------------------------------------------------------------------------

describe("getActiveShard", () => {
  it("returns null when no shards exist", () => {
    expect(getActiveShard(db, "webchat")).toBeNull();
  });

  it("returns the open shard", () => {
    const msgId = appendAndGetId("webchat", "hello");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    const active = getActiveShard(db, "webchat");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(shard.id);
  });

  it("returns null after shard is closed", () => {
    const msgId = appendAndGetId("webchat", "hello");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId, shard.id);
    closeShard(db, shard.id, msgId, "2026-03-09T10:05:00Z");
    expect(getActiveShard(db, "webchat")).toBeNull();
  });

  it("is per-channel — different channels have different active shards", () => {
    const msgW = appendAndGetId("webchat", "w");
    const shardW = createShard(db, "webchat", msgW, "2026-03-09T10:00:00Z");
    const msgWa = appendAndGetId("whatsapp", "wa");
    const shardWa = createShard(db, "whatsapp", msgWa, "2026-03-09T10:00:00Z");

    expect(getActiveShard(db, "webchat")!.id).toBe(shardW.id);
    expect(getActiveShard(db, "whatsapp")!.id).toBe(shardWa.id);
  });
});

// ---------------------------------------------------------------------------
// Message Assignment
// ---------------------------------------------------------------------------

describe("assignMessageToShard", () => {
  it("sets shard_id on the session message", () => {
    const msgId = appendAndGetId("webchat", "hello");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId, shard.id);

    const messages = getSessionHistory(db, { channel: "webchat" });
    expect(messages[0].shardId).toBe(shard.id);
  });
});

// ---------------------------------------------------------------------------
// assignMessageWithBoundaryDetection
// ---------------------------------------------------------------------------

describe("assignMessageWithBoundaryDetection", () => {
  const config: ForegroundConfig = {
    ...DEFAULT_FOREGROUND_CONFIG,
    timeGapMinutes: 25,
    maxShardTokens: 200, // Low for testing
  };

  it("creates a shard for the first message", () => {
    const msgId = appendAndGetId("webchat", "first message", "2026-03-09T10:00:00Z");
    const shardId = assignMessageWithBoundaryDetection(
      db, msgId, "webchat", "first message", "2026-03-09T10:00:00Z", config,
    );
    expect(shardId).toBeDefined();

    const active = getActiveShard(db, "webchat");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(shardId);
  });

  it("assigns consecutive messages to the same shard", () => {
    const msgId1 = appendAndGetId("webchat", "msg 1", "2026-03-09T10:00:00Z");
    const sid1 = assignMessageWithBoundaryDetection(db, msgId1, "webchat", "msg 1", "2026-03-09T10:00:00Z", config);

    const msgId2 = appendAndGetId("webchat", "msg 2", "2026-03-09T10:01:00Z");
    const sid2 = assignMessageWithBoundaryDetection(db, msgId2, "webchat", "msg 2", "2026-03-09T10:01:00Z", config);

    expect(sid1).toBe(sid2);
  });

  it("Tier 1A: time gap creates new shard", () => {
    const msgId1 = appendAndGetId("webchat", "before gap", "2026-03-09T10:00:00Z");
    const sid1 = assignMessageWithBoundaryDetection(db, msgId1, "webchat", "before gap", "2026-03-09T10:00:00Z", config);

    // 30 minutes later — exceeds 25 min gap
    const msgId2 = appendAndGetId("webchat", "after gap", "2026-03-09T10:30:00Z");
    const sid2 = assignMessageWithBoundaryDetection(db, msgId2, "webchat", "after gap", "2026-03-09T10:30:00Z", config);

    expect(sid1).not.toBe(sid2);

    // First shard should be closed
    const closed = getClosedShards(db, "webchat");
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe(sid1);
  });

  it("Tier 1B: token overflow closes shard", () => {
    // config.maxShardTokens = 200 tokens = ~800 chars
    // Send a big message that exceeds the threshold
    const bigContent = "x".repeat(900); // ~225 tokens > 200 threshold
    const msgId1 = appendAndGetId("webchat", bigContent, "2026-03-09T10:00:00Z");
    const sid1 = assignMessageWithBoundaryDetection(db, msgId1, "webchat", bigContent, "2026-03-09T10:00:00Z", config);

    // The shard should now be closed (token overflow)
    expect(getActiveShard(db, "webchat")).toBeNull();

    // Next message gets a new shard
    const msgId2 = appendAndGetId("webchat", "next", "2026-03-09T10:01:00Z");
    const sid2 = assignMessageWithBoundaryDetection(db, msgId2, "webchat", "next", "2026-03-09T10:01:00Z", config);

    expect(sid1).not.toBe(sid2);
  });

  it("no shard assignment when hippocampus disabled (not called)", () => {
    // This test validates that without calling assignMessageWithBoundaryDetection,
    // messages have no shard_id (backward compat)
    appendAndGetId("webchat", "no sharding");
    const msgs = getSessionHistory(db, { channel: "webchat" });
    expect(msgs[0].shardId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getShardMessages
// ---------------------------------------------------------------------------

describe("getShardMessages", () => {
  it("returns messages for a specific shard", () => {
    const msgId1 = appendAndGetId("webchat", "msg A", "2026-03-09T10:00:00Z");
    const shard = createShard(db, "webchat", msgId1, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId1, shard.id);

    const msgId2 = appendAndGetId("webchat", "msg B", "2026-03-09T10:01:00Z");
    assignMessageToShard(db, msgId2, shard.id);

    // Unrelated message — no shard
    appendAndGetId("webchat", "unsharded");

    const messages = getShardMessages(db, shard.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("msg A");
    expect(messages[1].content).toBe("msg B");
  });
});

// ---------------------------------------------------------------------------
// getShardTokenCount
// ---------------------------------------------------------------------------

describe("getShardTokenCount", () => {
  it("approximates tokens from message content lengths", () => {
    const msgId1 = appendAndGetId("webchat", "a".repeat(100)); // 25 tokens
    const shard = createShard(db, "webchat", msgId1, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId1, shard.id);

    const msgId2 = appendAndGetId("webchat", "b".repeat(200)); // 50 tokens
    assignMessageToShard(db, msgId2, shard.id);

    const tokens = getShardTokenCount(db, shard.id);
    expect(tokens).toBe(75); // 300 chars / 4
  });
});
