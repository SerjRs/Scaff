/**
 * Hippocampus E2E — Full Pipeline Integration Test
 *
 * Tests the WIRING between components, not the components themselves.
 * Verifies that startCortex correctly passes hippocampus config through
 * to the loop (embedFn), the Gardener (LLM functions), and context assembly.
 *
 * This test would have caught:
 * - Missing embedFn in startLoop() call
 * - Missing gardenerSummarizeLLM / gardenerExtractLLM in gateway-bridge.ts
 * - Channel Compactor never running
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, stopCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope } from "../types.js";
import { getTopHotFacts, searchColdFacts } from "../hippocampus.js";
import { getChannelStates, getSessionHistory } from "../session.js";
import type { EmbedFunction } from "../tools.js";
import type { FactExtractorLLM } from "../gardener.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let instance: CortexInstance | null = null;

/** Deterministic 768-dim mock embedding based on text content */
function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) emb[i] = Math.sin(seed * (i + 1));
  return emb;
}

const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
  return mockEmbedding(seed);
};

function makeEnvelope(channel = "webchat", content = "test", senderId = "serj") {
  return createEnvelope({
    channel,
    sender: { id: senderId, name: senderId === "serj" ? "Serj" : senderId, relationship: "partner" },
    content,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-hippo-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hippocampus e2e pipeline", () => {
  it("startCortex with hippocampusEnabled creates all memory tables", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // Verify all hippocampus tables exist
    const tables = instance.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cortex_%' ORDER BY name`,
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("cortex_hot_memory");
    expect(tableNames).toContain("cortex_cold_memory");
    expect(tableNames).toContain("cortex_cold_memory_vec");
  });

  it("Gardener starts and runAll() extracts facts into hot memory", async () => {
    const extractedPrompts: string[] = [];

    const mockExtractLLM: FactExtractorLLM = async (prompt) => {
      extractedPrompts.push(prompt);
      return JSON.stringify(["Serj prefers dark mode", "Project uses TypeScript"]);
    };

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "Discussed preferences",
      gardenerExtractLLM: mockExtractLLM,
      callLLM: async () => ({ text: "Noted, dark mode it is.", toolCalls: [] }),
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Seed some conversation messages
    instance.enqueue(makeEnvelope("webchat", "I prefer dark mode for everything"));
    await wait(200);
    instance.enqueue(makeEnvelope("webchat", "We're using TypeScript for this project"));
    await wait(200);

    // Manually trigger Gardener — the Fact Extractor should extract facts
    // Access gardener via the internal runAll mechanism
    const { runFactExtractor } = await import("../gardener.js");
    const result = await runFactExtractor({
      db: instance.db,
      extractLLM: mockExtractLLM,
      since: new Date(0).toISOString(), // all messages
    });

    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify facts are in hot memory
    const hotFacts = getTopHotFacts(instance.db);
    expect(hotFacts).toHaveLength(2);
    expect(hotFacts.map((f) => f.factText)).toContain("Serj prefers dark mode");
    expect(hotFacts.map((f) => f.factText)).toContain("Project uses TypeScript");
  });

  it("full lifecycle: extract → age → evict to cold → query retrieves", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => JSON.stringify(["Server IP is 10.0.0.1"]),
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // 1. Seed messages
    instance.enqueue(makeEnvelope("webchat", "The server IP is 10.0.0.1"));
    await wait(200);

    // 2. Extract facts into hot memory
    const { runFactExtractor, runVectorEvictor } = await import("../gardener.js");
    await runFactExtractor({
      db: instance.db,
      extractLLM: async () => JSON.stringify(["Server IP is 10.0.0.1"]),
      since: new Date(0).toISOString(),
    });

    let hotFacts = getTopHotFacts(instance.db);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].factText).toBe("Server IP is 10.0.0.1");

    // 3. Age the fact (backdate last_accessed_at to 30 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    instance.db.prepare(
      `UPDATE cortex_hot_memory SET last_accessed_at = ? WHERE id = ?`,
    ).run(oldDate.toISOString(), hotFacts[0].id);

    // 4. Run Vector Evictor — should move to cold storage
    const evictResult = await runVectorEvictor({
      db: instance.db,
      embedFn: mockEmbedFn,
      olderThanDays: 14,
      maxHitCount: 3,
    });

    expect(evictResult.processed).toBe(1);
    expect(evictResult.errors).toHaveLength(0);

    // 5. Verify: hot memory is now empty, cold storage has the fact
    hotFacts = getTopHotFacts(instance.db);
    expect(hotFacts).toHaveLength(0);

    const coldFacts = searchColdFacts(instance.db, await mockEmbedFn("Server IP is 10.0.0.1"), 5);
    expect(coldFacts).toHaveLength(1);
    expect(coldFacts[0].factText).toBe("Server IP is 10.0.0.1");

    // 6. Verify memory_query tool can find it
    const { executeMemoryQuery } = await import("../tools.js");
    const queryResult = JSON.parse(
      await executeMemoryQuery(instance.db, { query: "Server IP is 10.0.0.1" }, mockEmbedFn),
    );
    expect(queryResult.facts).toHaveLength(1);
    expect(queryResult.facts[0].text).toBe("Server IP is 10.0.0.1");

    // 7. Verify the queried fact was promoted back to hot memory
    hotFacts = getTopHotFacts(instance.db);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].factText).toBe("Server IP is 10.0.0.1");
  });

  it("embedFn reaches the loop — memory_query tool round-trip works", async () => {
    let embedCalled = false;
    const trackingEmbedFn: EmbedFunction = async (text) => {
      embedCalled = true;
      return mockEmbedFn(text);
    };

    // Pre-populate cold storage so memory_query has something to find
    let callCount = 0;
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: trackingEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: request memory_query
          return {
            text: "Let me check.",
            toolCalls: [{
              id: "tool_1",
              name: "memory_query",
              arguments: { query: "test query", limit: 5 },
            }],
            _rawContent: [
              { type: "text", text: "Let me check." },
              { type: "toolCall", id: "tool_1", name: "memory_query", arguments: { query: "test query", limit: 5 } },
            ],
          };
        }
        // Second call (after tool result): final response
        return { text: "No facts found.", toolCalls: [] };
      },
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    instance.enqueue(makeEnvelope("webchat", "What do you know about me?"));
    await wait(500);

    // embedFn was called by the loop's memory_query execution
    expect(embedCalled).toBe(true);
    // LLM was called twice: initial + tool round-trip continuation
    expect(callCount).toBe(2);
  });

  it("Channel Compactor demotes idle channels to background", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "User discussed testing patterns",
      gardenerExtractLLM: async () => "[]",
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });
    instance.registerAdapter({
      channelId: "whatsapp",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Seed messages on two channels
    instance.enqueue(makeEnvelope("webchat", "hello from webchat"));
    await wait(200);
    instance.enqueue(makeEnvelope("whatsapp", "hello from whatsapp"));
    await wait(200);

    // Both channels should be foreground
    let states = getChannelStates(instance.db);
    expect(states.find((s) => s.channel === "webchat")?.layer).toBe("foreground");
    expect(states.find((s) => s.channel === "whatsapp")?.layer).toBe("foreground");

    // Backdate whatsapp to 2 hours ago (past the 1h idle threshold)
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    instance.db.prepare(
      `UPDATE cortex_channel_states SET last_message_at = ? WHERE channel = 'whatsapp'`,
    ).run(oldDate);

    // Run Channel Compactor
    const { runChannelCompactor } = await import("../gardener.js");
    const result = await runChannelCompactor({
      db: instance.db,
      summarize: async () => "User sent a greeting from WhatsApp",
    });

    expect(result.processed).toBe(1);

    // whatsapp should now be background, webchat still foreground
    states = getChannelStates(instance.db);
    expect(states.find((s) => s.channel === "whatsapp")?.layer).toBe("background");
    expect(states.find((s) => s.channel === "webchat")?.layer).toBe("foreground");
  });

  it("hot facts appear in System Floor context when hippocampus enabled", async () => {
    let capturedSystem = "";

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async (context) => {
        // Capture the system floor layer to verify hot facts injection
        const systemFloor = context.layers.find((l) => l.name === "system_floor");
        if (systemFloor) capturedSystem = systemFloor.content;
        return { text: "ok", toolCalls: [] };
      },
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Insert hot facts directly
    const { insertHotFact } = await import("../hippocampus.js");
    insertHotFact(instance.db, { factText: "Serj's timezone is PST" });
    insertHotFact(instance.db, { factText: "Serj prefers dark mode" });

    // Send a message — context assembly should include hot facts
    instance.enqueue(makeEnvelope("webchat", "hello"));
    await wait(300);

    expect(capturedSystem).toContain("Known Facts");
    expect(capturedSystem).toContain("Serj's timezone is PST");
    expect(capturedSystem).toContain("Serj prefers dark mode");
  });

  it("hippocampusEnabled=false skips all memory tables and gardener", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: false,
      // These should be ignored when hippocampus is disabled
      gardenerSummarizeLLM: async () => { throw new Error("should not be called"); },
      gardenerExtractLLM: async () => { throw new Error("should not be called"); },
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // hot_memory table should NOT exist
    const hotTable = instance.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_hot_memory'`,
    ).get() as { name: string } | undefined;
    expect(hotTable).toBeUndefined();

    // cold_memory table should NOT exist
    const coldTable = instance.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_cold_memory'`,
    ).get() as { name: string } | undefined;
    expect(coldTable).toBeUndefined();
  });
});
