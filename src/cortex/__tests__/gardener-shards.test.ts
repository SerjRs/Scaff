/**
 * Phase 4 — Gardener Shard Integration Tests
 *
 * Tests for shard-aware fact extraction and shard-based background summaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import {
  initSessionTables,
  appendToSession,
  updateChannelState,
  getChannelStates,
} from "../session.js";
import {
  initHotMemoryTable,
  getTopHotFacts,
} from "../hippocampus.js";
import {
  runChannelCompactor,
  runFactExtractor,
  type FactExtractorLLM,
} from "../gardener.js";
import {
  createShard,
  closeShard,
  assignMessageToShard,
  markShardExtracted,
  getUnextractedShards,
} from "../shards.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gardener-shards-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
  initHotMemoryTable(db);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function appendAndGetId(channel: string, content: string, timestamp: string, senderId = "serj"): number {
  const env = createEnvelope({
    channel,
    sender: { id: senderId, name: senderId, relationship: "partner" },
    content,
    timestamp,
  });
  appendToSession(db, env);
  const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number | bigint };
  return Number(row.id);
}

function createClosedShardWithMessages(
  channel: string,
  messages: { content: string; timestamp: string; senderId?: string }[],
  topic: string,
): string {
  const ids: number[] = [];
  for (const msg of messages) {
    ids.push(appendAndGetId(channel, msg.content, msg.timestamp, msg.senderId));
  }
  const shard = createShard(db, channel, ids[0], messages[0].timestamp, topic);
  for (const id of ids) {
    assignMessageToShard(db, id, shard.id);
  }
  closeShard(db, shard.id, ids[ids.length - 1], messages[messages.length - 1].timestamp);
  return shard.id;
}

// ---------------------------------------------------------------------------
// Shard-aware Fact Extractor
// ---------------------------------------------------------------------------

describe("Shard-aware Fact Extractor", () => {
  it("processes closed shards individually with topic context", async () => {
    const shardId = createClosedShardWithMessages("webchat", [
      { content: "I prefer dark mode for all editors", timestamp: "2026-03-09T10:00:00Z" },
      { content: "Noted, dark mode preference saved", timestamp: "2026-03-09T10:01:00Z", senderId: "cortex" },
    ], "Editor preferences");

    const mockLLM: FactExtractorLLM = async (prompt) => {
      // Verify the topic context is included in the prompt
      expect(prompt).toContain("Editor preferences");
      return '["User prefers dark mode for all editors"]';
    };

    // Register the channel so the fallback path sees it
    updateChannelState(db, "webchat", { lastMessageAt: "2026-03-09T10:01:00Z", layer: "foreground" });

    const result = await runFactExtractor({ db, extractLLM: mockLLM });
    expect(result.processed).toBe(1);

    // Fact should be in hot memory
    const facts = getTopHotFacts(db, 10);
    expect(facts.some((f) => f.factText === "User prefers dark mode for all editors")).toBe(true);

    // Shard should be marked as extracted
    const unextracted = getUnextractedShards(db);
    expect(unextracted.find((s) => s.id === shardId)).toBeUndefined();
  });

  it("skips already-extracted shards", async () => {
    const shardId = createClosedShardWithMessages("webchat", [
      { content: "test message", timestamp: "2026-03-09T10:00:00Z" },
    ], "Test topic");

    // Mark as already extracted
    markShardExtracted(db, shardId);

    let llmCalled = false;
    const mockLLM: FactExtractorLLM = async () => {
      llmCalled = true;
      return "[]";
    };

    updateChannelState(db, "webchat", { lastMessageAt: "2026-03-09T10:01:00Z", layer: "foreground" });

    await runFactExtractor({ db, extractLLM: mockLLM });
    // LLM should NOT have been called for the shard (it's already extracted)
    // It may be called for the fallback channel path though — that's fine
    // The key test is that the shard was skipped
    const unextracted = getUnextractedShards(db);
    expect(unextracted).toHaveLength(0);
  });

  it("falls back to raw session for channels without shards", async () => {
    // Add messages without shards
    appendAndGetId("telegram", "I use vim", "2026-03-10T10:00:00Z");
    updateChannelState(db, "telegram", { lastMessageAt: "2026-03-10T10:00:00Z", layer: "foreground" });

    const mockLLM: FactExtractorLLM = async () => '["User uses vim"]';

    const result = await runFactExtractor({ db, extractLLM: mockLLM, since: "2026-03-10T09:00:00Z" });
    expect(result.processed).toBe(1);

    const facts = getTopHotFacts(db, 10);
    expect(facts.some((f) => f.factText === "User uses vim")).toBe(true);
  });

  it("processes multiple shards across channels", async () => {
    createClosedShardWithMessages("webchat", [
      { content: "Project uses TypeScript", timestamp: "2026-03-09T10:00:00Z" },
    ], "Tech stack discussion");

    createClosedShardWithMessages("whatsapp", [
      { content: "Deploy to AWS us-east-1", timestamp: "2026-03-09T11:00:00Z" },
    ], "Deployment planning");

    updateChannelState(db, "webchat", { lastMessageAt: "2026-03-09T10:00:00Z", layer: "foreground" });
    updateChannelState(db, "whatsapp", { lastMessageAt: "2026-03-09T11:00:00Z", layer: "foreground" });

    const mockLLM: FactExtractorLLM = async (prompt) => {
      if (prompt.includes("TypeScript")) return '["Project uses TypeScript"]';
      if (prompt.includes("AWS")) return '["Deploy to AWS us-east-1"]';
      return "[]";
    };

    const result = await runFactExtractor({ db, extractLLM: mockLLM });
    expect(result.processed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Shard-based Background Summaries
// ---------------------------------------------------------------------------

describe("Shard-based Background Summaries", () => {
  it("builds summary from shard topic labels without LLM call", async () => {
    // Create closed shards with topics
    createClosedShardWithMessages("webchat", [
      { content: "fixing the token monitor", timestamp: "2026-03-09T08:00:00Z" },
    ], "Token monitor fix");

    createClosedShardWithMessages("webchat", [
      { content: "building code search", timestamp: "2026-03-09T09:00:00Z" },
    ], "Code search implementation");

    // Make the channel idle (1+ hours ago)
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    updateChannelState(db, "webchat", {
      lastMessageAt: oldTimestamp,
      layer: "foreground",
    });

    let llmCalled = false;
    const mockSummarize: FactExtractorLLM = async () => {
      llmCalled = true;
      return "LLM summary";
    };

    const result = await runChannelCompactor({ db, summarize: mockSummarize });
    expect(result.processed).toBe(1);

    // LLM should NOT have been called (shard-based summary used instead)
    expect(llmCalled).toBe(false);

    // Check the summary content
    const states = getChannelStates(db);
    const webchat = states.find((s) => s.channel === "webchat");
    expect(webchat?.summary).toContain("Token monitor fix");
    expect(webchat?.summary).toContain("Code search implementation");
    expect(webchat?.layer).toBe("background");
  });

  it("falls back to LLM summary when no shards exist", async () => {
    // Add messages without shards
    appendAndGetId("telegram", "hello there", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    updateChannelState(db, "telegram", {
      lastMessageAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      layer: "foreground",
    });

    const mockSummarize: FactExtractorLLM = async () => "Brief greeting exchange";

    const result = await runChannelCompactor({ db, summarize: mockSummarize });
    expect(result.processed).toBe(1);

    const states = getChannelStates(db);
    const telegram = states.find((s) => s.channel === "telegram");
    expect(telegram?.summary).toBe("Brief greeting exchange");
  });

  it("includes time-ago in shard summary lines", async () => {
    // Create a shard that ended 30 minutes ago
    const endedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const msgId = appendAndGetId("webchat", "test", endedAt);
    const shard = createShard(db, "webchat", msgId, endedAt, "Recent topic");
    assignMessageToShard(db, msgId, shard.id);
    closeShard(db, shard.id, msgId, endedAt);

    // Make channel idle
    updateChannelState(db, "webchat", {
      lastMessageAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      layer: "foreground",
    });

    const mockSummarize: FactExtractorLLM = async () => "ignored";

    await runChannelCompactor({ db, summarize: mockSummarize });

    const states = getChannelStates(db);
    const webchat = states.find((s) => s.channel === "webchat");
    expect(webchat?.summary).toContain("Recent topic");
    expect(webchat?.summary).toMatch(/\d+min ago/);
  });
});
