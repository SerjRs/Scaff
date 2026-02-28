/**
 * Hippocampus Phase 4 — Gardener Subsystem Tests
 *
 * Tests for Channel Compactor, Fact Extractor, Vector Evictor,
 * and the full gardener lifecycle E2E.
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
  getSessionHistory,
} from "../session.js";
import {
  initHotMemoryTable,
  initColdStorage,
  insertHotFact,
  getTopHotFacts,
  getStaleHotFacts,
  searchColdFacts,
} from "../hippocampus.js";
import {
  compactChannel,
  runChannelCompactor,
  runFactExtractor,
  runVectorEvictor,
  type FactExtractorLLM,
} from "../gardener.js";
import type { EmbedFunction } from "../tools.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(channel = "webchat", content = "test", senderId = "serj") {
  return createEnvelope({
    channel,
    sender: { id: senderId, name: senderId === "serj" ? "Serj" : senderId, relationship: "partner" },
    content,
    timestamp: new Date().toISOString(),
  });
}

function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    emb[i] = Math.sin(seed * (i + 1));
  }
  return emb;
}

/** Mock summarizer that returns a canned summary */
const mockSummarize: FactExtractorLLM = async (prompt: string) => {
  return "Serj discussed project setup and preferred dark mode.";
};

/** Mock fact extractor that returns canned facts */
const mockExtractLLM: FactExtractorLLM = async (prompt: string) => {
  return JSON.stringify([
    "Serj prefers dark mode",
    "Project uses TypeScript",
  ]);
};

/** Mock embed function */
const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  return mockEmbedding(Math.abs(seed));
};

// ---------------------------------------------------------------------------
// Task 4.1: Channel Compactor
// ---------------------------------------------------------------------------

describe("Channel Compactor", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gardener-cc-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initSessionTables(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compactChannel produces a concise summary from chat logs", async () => {
    const messages = [
      { role: "user", content: "Can we use dark mode?", senderId: "serj" },
      { role: "assistant", content: "Sure, I'll enable dark mode for you.", senderId: "cortex" },
      { role: "user", content: "Also set up the project with TypeScript", senderId: "serj" },
      { role: "assistant", content: "Done, TypeScript is configured.", senderId: "cortex" },
    ];

    const summary = await compactChannel(messages, mockSummarize);
    expect(summary).toBeTruthy();
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });

  it("compactChannel returns empty string for empty messages", async () => {
    const summary = await compactChannel([], mockSummarize);
    expect(summary).toBe("");
  });

  it("runChannelCompactor demotes idle foreground channels to background", async () => {
    // Create a foreground channel with old last_message_at
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    updateChannelState(db, "whatsapp", {
      lastMessageAt: oldTime,
      layer: "foreground",
    });

    // Add some session history for that channel
    appendToSession(db, makeEnvelope("whatsapp", "hello from whatsapp"));

    const result = await runChannelCompactor({
      db,
      summarize: mockSummarize,
      idleHours: 1,
    });

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify channel was demoted to background
    const states = getChannelStates(db);
    const whatsapp = states.find((s) => s.channel === "whatsapp");
    expect(whatsapp!.layer).toBe("background");
    expect(whatsapp!.summary).toBeTruthy();
  });

  it("skips channels that are still active (within idle threshold)", async () => {
    const recentTime = new Date().toISOString(); // just now
    updateChannelState(db, "webchat", {
      lastMessageAt: recentTime,
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "active chat"));

    const result = await runChannelCompactor({
      db,
      summarize: mockSummarize,
      idleHours: 1,
    });

    expect(result.processed).toBe(0);

    // Verify channel remains foreground
    const states = getChannelStates(db);
    const webchat = states.find((s) => s.channel === "webchat");
    expect(webchat!.layer).toBe("foreground");
  });

  it("skips channels already in background layer", async () => {
    updateChannelState(db, "telegram", {
      lastMessageAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      summary: "existing summary",
      layer: "background",
    });

    const result = await runChannelCompactor({
      db,
      summarize: mockSummarize,
      idleHours: 1,
    });

    expect(result.processed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2: Fact Extractor
// ---------------------------------------------------------------------------

describe("Fact Extractor", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gardener-fe-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initSessionTables(db);
    initHotMemoryTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts facts from recent session messages into hot memory", async () => {
    updateChannelState(db, "webchat", {
      lastMessageAt: new Date().toISOString(),
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "I prefer dark mode"));
    appendToSession(db, makeEnvelope("webchat", "Use TypeScript for the project"));

    const result = await runFactExtractor({
      db,
      extractLLM: mockExtractLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(0);

    const facts = getTopHotFacts(db);
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.factText)).toContain("Serj prefers dark mode");
    expect(facts.map((f) => f.factText)).toContain("Project uses TypeScript");
  });

  it("skips duplicate facts already in hot memory", async () => {
    insertHotFact(db, { factText: "Serj prefers dark mode" });

    updateChannelState(db, "webchat", {
      lastMessageAt: new Date().toISOString(),
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "something"));

    const result = await runFactExtractor({
      db,
      extractLLM: mockExtractLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    // Only "Project uses TypeScript" should be new
    expect(result.processed).toBe(1);
    expect(getTopHotFacts(db)).toHaveLength(2); // 1 existing + 1 new
  });

  it("handles LLM returning non-JSON gracefully", async () => {
    updateChannelState(db, "webchat", {
      lastMessageAt: new Date().toISOString(),
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "test"));

    const badLLM: FactExtractorLLM = async () => "Sorry, I can't extract facts from this.";

    const result = await runFactExtractor({
      db,
      extractLLM: badLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.processed).toBe(0);
    expect(result.errors).toHaveLength(0); // no error — just no facts parsed
  });

  it("handles LLM returning JSON in code block", async () => {
    updateChannelState(db, "webchat", {
      lastMessageAt: new Date().toISOString(),
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "test"));

    const codeLLM: FactExtractorLLM = async () =>
      '```json\n["fact from code block"]\n```';

    const result = await runFactExtractor({
      db,
      extractLLM: codeLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.processed).toBe(1);
    const facts = getTopHotFacts(db);
    expect(facts[0].factText).toBe("fact from code block");
  });
});

// ---------------------------------------------------------------------------
// Task 4.3: Vector Evictor
// ---------------------------------------------------------------------------

describe("Vector Evictor", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gardener-ve-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    initSessionTables(db);
    initHotMemoryTable(db);
    try {
      await initColdStorage(db);
    } catch {
      vecAvailable = false;
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("selects only stale + low-hit facts for eviction", () => {
    if (!vecAvailable) return;

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);

    // Fresh fact — should NOT be evicted
    insertHotFact(db, { factText: "fresh fact" });

    // Stale + high hits — should NOT be evicted
    const highHitId = insertHotFact(db, { factText: "stale high hits" });
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 10 WHERE id = ?`)
      .run(oldDate.toISOString(), highHitId);

    // Stale + low hits — SHOULD be evicted
    const staleLowId = insertHotFact(db, { factText: "stale low hits" });
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 1 WHERE id = ?`)
      .run(oldDate.toISOString(), staleLowId);

    const stale = getStaleHotFacts(db, 14, 3);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe(staleLowId);
  });

  it("moves stale facts from hot to cold storage", async () => {
    if (!vecAvailable) return;

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);

    // Create a stale fact
    const staleId = insertHotFact(db, { factText: "evictable fact" });
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 0 WHERE id = ?`)
      .run(oldDate.toISOString(), staleId);

    // Verify it's in hot, not in cold
    expect(getTopHotFacts(db)).toHaveLength(1);

    const result = await runVectorEvictor({
      db,
      embedFn: mockEmbedFn,
      olderThanDays: 14,
      maxHitCount: 3,
    });

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Removed from hot
    expect(getTopHotFacts(db)).toHaveLength(0);

    // Present in cold — search with a mock embedding
    const embedding = await mockEmbedFn("evictable fact");
    const cold = searchColdFacts(db, embedding, 10);
    expect(cold.length).toBeGreaterThan(0);
    expect(cold.some((f) => f.factText === "evictable fact")).toBe(true);
  });

  it("skips facts that fail embedding (partial success)", async () => {
    if (!vecAvailable) return;

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);

    // Two stale facts
    const id1 = insertHotFact(db, { factText: "fact one" });
    const id2 = insertHotFact(db, { factText: "FAIL_EMBED" });
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 0 WHERE id = ?`)
      .run(oldDate.toISOString(), id1);
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 0 WHERE id = ?`)
      .run(oldDate.toISOString(), id2);

    // Embed function that fails for specific text
    const failingEmbedFn: EmbedFunction = async (text: string) => {
      if (text === "FAIL_EMBED") throw new Error("Embedding service down");
      return mockEmbedFn(text);
    };

    const result = await runVectorEvictor({
      db,
      embedFn: failingEmbedFn,
      olderThanDays: 14,
      maxHitCount: 3,
    });

    expect(result.processed).toBe(1); // only fact one succeeded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Embedding service down");

    // fact one removed from hot, FAIL_EMBED still there
    const remaining = getTopHotFacts(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].factText).toBe("FAIL_EMBED");
  });
});

// ---------------------------------------------------------------------------
// E2E: Gardener Lifecycle
// ---------------------------------------------------------------------------

describe("gardener lifecycle e2e", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gardener-e2e-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    initSessionTables(db);
    initHotMemoryTable(db);
    try {
      await initColdStorage(db);
    } catch {
      vecAvailable = false;
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: extract facts → age them → evict to cold storage", async () => {
    if (!vecAvailable) return;

    // 1. Set up a channel with messages
    updateChannelState(db, "webchat", {
      lastMessageAt: new Date().toISOString(),
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("webchat", "My IP is 192.168.1.50"));
    appendToSession(db, makeEnvelope("webchat", "I always use dark mode"));

    // 2. Run fact extractor
    const extractResult = await runFactExtractor({
      db,
      extractLLM: mockExtractLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(extractResult.processed).toBe(2);

    // Verify facts in hot memory
    let hotFacts = getTopHotFacts(db);
    expect(hotFacts).toHaveLength(2);

    // 3. Simulate aging: backdate the facts to 30 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    for (const fact of hotFacts) {
      db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ? WHERE id = ?`)
        .run(oldDate.toISOString(), fact.id);
    }

    // 4. Run vector evictor
    const evictResult = await runVectorEvictor({
      db,
      embedFn: mockEmbedFn,
      olderThanDays: 14,
      maxHitCount: 3,
    });
    expect(evictResult.processed).toBe(2);
    expect(evictResult.errors).toHaveLength(0);

    // 5. Verify: hot memory is empty, cold storage has the facts
    hotFacts = getTopHotFacts(db);
    expect(hotFacts).toHaveLength(0);

    // Cold storage should have both facts
    const coldMeta = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_cold_memory`).get() as { cnt: number };
    expect(coldMeta.cnt).toBe(2);
  });

  it("compactor + evictor full cycle: foreground → background + hot → cold", async () => {
    if (!vecAvailable) return;

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // 1. Set up idle foreground channel
    updateChannelState(db, "whatsapp", {
      lastMessageAt: twoHoursAgo,
      layer: "foreground",
    });
    appendToSession(db, makeEnvelope("whatsapp", "Hey, dinner at 7?"));

    // 2. Add a stale hot fact
    const staleId = insertHotFact(db, { factText: "Old preference: light mode" });
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ?, hit_count = 0 WHERE id = ?`)
      .run(thirtyDaysAgo.toISOString(), staleId);

    // 3. Run compactor — should demote whatsapp
    const compactResult = await runChannelCompactor({
      db,
      summarize: mockSummarize,
      idleHours: 1,
    });
    expect(compactResult.processed).toBe(1);

    const states = getChannelStates(db);
    expect(states.find((s) => s.channel === "whatsapp")!.layer).toBe("background");

    // 4. Run evictor — should move stale fact to cold
    const evictResult = await runVectorEvictor({
      db,
      embedFn: mockEmbedFn,
      olderThanDays: 14,
      maxHitCount: 3,
    });
    expect(evictResult.processed).toBe(1);

    // Hot memory empty, cold has the fact
    expect(getTopHotFacts(db)).toHaveLength(0);
    const coldCount = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_cold_memory`).get() as { cnt: number };
    expect(coldCount.cnt).toBe(1);
  });
});
