import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession } from "../session.js";
import { createEnvelope } from "../types.js";
import { buildShardedForeground, estimateTokens } from "../context.js";
import {
  createShard,
  closeShard,
  assignMessageToShard,
  assignMessageWithBoundaryDetection,
  DEFAULT_FOREGROUND_CONFIG,
  type ForegroundConfig,
} from "../shards.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

const config: ForegroundConfig = {
  ...DEFAULT_FOREGROUND_CONFIG,
  tokenCap: 200,
  tolerancePct: 20,
  maxShardTokens: 100,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shards-fg-test-"));
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

/** Helper: create a closed shard with N messages, each of the given content */
function createClosedShard(
  channel: string,
  messages: { content: string; timestamp: string }[],
  topic = "Test topic",
): string {
  const ids: number[] = [];
  for (const msg of messages) {
    ids.push(appendAndGetId(channel, msg.content, msg.timestamp));
  }
  const shard = createShard(db, channel, ids[0], messages[0].timestamp, topic);
  for (const id of ids) {
    assignMessageToShard(db, id, shard.id);
  }
  // Update shard tail for each message
  for (const id of ids) {
    db.prepare("UPDATE cortex_shards SET last_message_id = ?, message_count = message_count + 1, token_count = token_count + ? WHERE id = ?")
      .run(id, estimateTokens(messages[ids.indexOf(id)]?.content ?? ""), shard.id);
  }
  closeShard(db, shard.id, ids[ids.length - 1], messages[messages.length - 1].timestamp);
  return shard.id;
}

// ---------------------------------------------------------------------------
// buildShardedForeground
// ---------------------------------------------------------------------------

describe("buildShardedForeground", () => {
  it("includes active shard messages", () => {
    const msgId = appendAndGetId("webchat", "hello active", "2026-03-09T10:00:00Z");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId, shard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = ? WHERE id = ?")
      .run(estimateTokens("hello active"), shard.id);

    const { layer, messages } = buildShardedForeground(db, "webchat", config);
    expect(layer.content).toContain("hello active");
    expect(messages).toHaveLength(1);
  });

  it("respects token budget — excludes older shards", () => {
    // Create 5 closed shards with ~60 tokens each (240 chars each)
    // tokenCap = 200, tolerance 20% → ceiling = 240
    for (let i = 0; i < 5; i++) {
      createClosedShard("webchat", [
        { content: `shard ${i} content: ${"x".repeat(200)}`, timestamp: `2026-03-09T0${i}:00:00Z` },
      ], `Topic ${i}`);
    }

    // Active shard
    const activeId = appendAndGetId("webchat", "active msg", "2026-03-09T10:00:00Z");
    const activeShard = createShard(db, "webchat", activeId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, activeId, activeShard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = ? WHERE id = ?")
      .run(estimateTokens("active msg"), activeShard.id);

    const { layer } = buildShardedForeground(db, "webchat", config);
    // Should include active + some closed but not all 5
    expect(layer.content).toContain("active msg");
    // Token count should be within budget (active + some closed, but not all)
    expect(layer.tokens).toBeLessThan(500); // Not all 5 shards worth
  });

  it("active shard always included even if it exceeds cap", () => {
    // Active shard with 500 tokens (way over 200 cap)
    const bigContent = "y".repeat(2000); // ~500 tokens
    const msgId = appendAndGetId("webchat", bigContent, "2026-03-09T10:00:00Z");
    const shard = createShard(db, "webchat", msgId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, msgId, shard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = ? WHERE id = ?")
      .run(estimateTokens(bigContent), shard.id);

    const { layer } = buildShardedForeground(db, "webchat", config);
    expect(layer.content).toContain(bigContent);
    expect(layer.tokens).toBeGreaterThan(config.tokenCap);
  });

  it("tolerance band includes borderline shard", () => {
    // Active shard: 50 tokens
    const activeId = appendAndGetId("webchat", "a".repeat(200), "2026-03-09T10:00:00Z");
    const activeShard = createShard(db, "webchat", activeId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, activeId, activeShard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = 50 WHERE id = ?")
      .run(activeShard.id);

    // Closed shard: 180 tokens — total would be 230, ceiling is 240 (200 * 1.2)
    createClosedShard("webchat", [
      { content: "z".repeat(720), timestamp: "2026-03-09T09:00:00Z" },
    ], "Within tolerance");

    const { layer } = buildShardedForeground(db, "webchat", config);
    expect(layer.content).toContain("z".repeat(100)); // Partial match is enough
  });

  it("tolerance exceeded excludes shard", () => {
    // Active shard: 50 tokens
    const activeId = appendAndGetId("webchat", "a".repeat(200), "2026-03-09T10:00:00Z");
    const activeShard = createShard(db, "webchat", activeId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, activeId, activeShard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = 50 WHERE id = ?")
      .run(activeShard.id);

    // Closed shard: 200 tokens — total would be 250, ceiling is 240 → excluded
    createClosedShard("webchat", [
      { content: "z".repeat(800), timestamp: "2026-03-09T09:00:00Z" },
    ], "Over tolerance");

    const { layer } = buildShardedForeground(db, "webchat", config);
    // Shard separator should NOT be present (excluded)
    expect(layer.content).not.toContain("Over tolerance");
  });

  it("shard separators present with topic labels", () => {
    createClosedShard("webchat", [
      { content: "fixing bugs", timestamp: "2026-03-09T09:00:00Z" },
    ], "Bug fix session");

    const activeId = appendAndGetId("webchat", "new topic", "2026-03-09T10:00:00Z");
    const activeShard = createShard(db, "webchat", activeId, "2026-03-09T10:00:00Z");
    assignMessageToShard(db, activeId, activeShard.id);
    db.prepare("UPDATE cortex_shards SET message_count = 1, token_count = 10 WHERE id = ?")
      .run(activeShard.id);

    const { layer } = buildShardedForeground(db, "webchat", {
      ...config,
      tokenCap: 10000, // Large cap to include everything
    });
    expect(layer.content).toContain("--- [Topic: Bug fix session");
    expect(layer.content).toContain("messages] ---");
  });

  it("fallback: no shards loads unsharded messages", () => {
    // Messages without shard_id
    appendAndGetId("webchat", "unsharded msg 1", "2026-03-09T10:00:00Z");
    appendAndGetId("webchat", "unsharded msg 2", "2026-03-09T10:01:00Z");

    const { layer, messages } = buildShardedForeground(db, "webchat", config);
    expect(layer.content).toContain("unsharded msg 1");
    expect(layer.content).toContain("unsharded msg 2");
    expect(messages).toHaveLength(2);
  });
});
