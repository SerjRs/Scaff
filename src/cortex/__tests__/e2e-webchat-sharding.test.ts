/**
 * 020f — E2E Webchat Foreground Sharding
 *
 * Category G — Foreground Sharding (shard assignment, boundary detection, ops triggers)
 *
 * G1: Messages assigned to shards (cortex_shards table populated)
 * G2: Shard boundary on token overflow (new shard created when budget exceeded)
 * G3: Ops trigger assigned to correct shard
 *
 * Uses programmatic Cortex API — no gateway, no WebSocket.
 * All LLMs are mocked. All tests are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { DEFAULT_FOREGROUND_CONFIG } from "../shards.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020f-cortex-e2e/TEST-RESULTS.md",
);
const reporter = new TestReporter();

afterAll(() => {
  reporter.writeReport(REPORT_PATH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-shard-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeWebchatEnvelope(content: string, senderId = "serj") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: senderId, name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

// ---------------------------------------------------------------------------
// G — Foreground Sharding
// ---------------------------------------------------------------------------

describe("G — Foreground Sharding", () => {
  it("G1: Messages assigned to shards (cortex_shards table populated)", async () => {
    const t = { id: "G1", name: "messages assigned to shards", category: "G — Foreground Sharding" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        foregroundConfig: { ...DEFAULT_FOREGROUND_CONFIG },
        callLLM: async () => ({ text: "reply", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      // Send 3 messages
      for (let i = 0; i < 3; i++) {
        instance.enqueue(makeWebchatEnvelope(`shard test ${i}`));
      }
      await wait(800);

      // Check cortex_shards table
      const shards = instance.db.prepare(
        `SELECT id, channel, topic, ended_at, message_count, token_count, issuer
         FROM cortex_shards ORDER BY created_at`,
      ).all() as Record<string, unknown>[];

      expect(shards.length).toBeGreaterThanOrEqual(1);

      // Verify the active shard has messages assigned
      const activeShard = shards.find((s) => s.ended_at === null);
      expect(activeShard).toBeDefined();
      expect(activeShard!.channel).toBe("webchat");

      // Verify messages have shard_id set
      const assignedMsgs = instance.db.prepare(
        `SELECT COUNT(*) as cnt FROM cortex_session WHERE shard_id IS NOT NULL`,
      ).get() as { cnt: number };
      expect(assignedMsgs.cnt).toBeGreaterThanOrEqual(3);

      reporter.record({
        ...t, passed: true,
        expected: ">=1 shard, >=3 assigned messages",
        actual: `shards=${shards.length}, assignedMsgs=${assignedMsgs.cnt}, activeChannel=${activeShard?.channel}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: ">=1 shard, >=3 assigned messages", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("G2: Shard boundary on token overflow (new shard created when budget exceeded)", async () => {
    const t = { id: "G2", name: "shard boundary on token overflow", category: "G — Foreground Sharding" };

    try {
      // Use a very small maxShardTokens to trigger boundary quickly
      // estimateTokens = Math.ceil(text.length / 4), so 100 tokens = 400 chars
      const smallConfig = {
        ...DEFAULT_FOREGROUND_CONFIG,
        maxShardTokens: 100, // 100 tokens = ~400 chars
        timeGapMinutes: 999, // Disable time-gap detection
      };

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        foregroundConfig: smallConfig,
        callLLM: async () => ({ text: "ok", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      // Send a large message that exceeds the 100-token budget (~400 chars)
      const bigMessage = "x".repeat(500); // 500 chars = 125 tokens > 100
      instance.enqueue(makeWebchatEnvelope(bigMessage));
      await wait(400);

      // First message creates shard, exceeds budget, closes it.
      // Send a second message — should go to a NEW shard.
      instance.enqueue(makeWebchatEnvelope("second message after overflow"));
      await wait(400);

      const shards = instance.db.prepare(
        `SELECT id, channel, ended_at, token_count, message_count
         FROM cortex_shards ORDER BY created_at`,
      ).all() as Record<string, unknown>[];

      // We should have at least 2 shards: one closed (overflow), one active
      expect(shards.length).toBeGreaterThanOrEqual(2);
      const closedShards = shards.filter((s) => s.ended_at !== null);
      const activeShards = shards.filter((s) => s.ended_at === null);
      expect(closedShards.length).toBeGreaterThanOrEqual(1);
      expect(activeShards.length).toBeGreaterThanOrEqual(1);

      reporter.record({
        ...t, passed: true,
        expected: ">=2 shards (>=1 closed, >=1 active)",
        actual: `shards=${shards.length}, closed=${closedShards.length}, active=${activeShards.length}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: ">=2 shards (>=1 closed, >=1 active)", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("G3: Ops trigger assigned to correct shard", async () => {
    const t = { id: "G3", name: "ops trigger assigned to correct shard", category: "G — Foreground Sharding" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        foregroundConfig: { ...DEFAULT_FOREGROUND_CONFIG },
        callLLM: async () => ({ text: "reply", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      // Send a webchat message first to establish a shard
      instance.enqueue(makeWebchatEnvelope("initial webchat message"));
      await wait(400);

      // Get the active shard ID before ops trigger
      const shardBefore = instance.db.prepare(
        `SELECT id FROM cortex_shards WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      ).get() as { id: string } | undefined;
      expect(shardBefore).toBeDefined();
      const activeShardId = shardBefore!.id;

      // Enqueue an ops_trigger (as gateway-bridge would for a completed task)
      const opsTrigger = createEnvelope({
        channel: "router",
        sender: { id: "router:task", name: "Router", relationship: "internal" },
        content: "",
        priority: "urgent",
        metadata: {
          ops_trigger: true,
          taskId: "task-shard-001",
          taskDescription: "Research something",
          taskStatus: "completed",
          taskResult: "Here is the result.",
          replyChannel: "webchat",
        },
      });
      instance.enqueue(opsTrigger);
      await wait(400);

      // The ops trigger message should be assigned to the webchat shard
      // (loop.ts uses replyChannel for ops triggers, not the "router" channel)
      const opsMessages = instance.db.prepare(
        `SELECT shard_id FROM cortex_session
         WHERE sender_id = 'cortex:ops' AND shard_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      ).get() as { shard_id: string } | undefined;

      expect(opsMessages).toBeDefined();
      expect(opsMessages!.shard_id).toBe(activeShardId);

      reporter.record({
        ...t, passed: true,
        expected: "ops trigger assigned to active webchat shard",
        actual: `activeShard=${activeShardId.slice(0, 8)}, opsShard=${opsMessages?.shard_id?.slice(0, 8)}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "ops trigger assigned to active webchat shard", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
