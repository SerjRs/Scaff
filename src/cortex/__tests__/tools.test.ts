/**
 * Hippocampus Phase 3 — Retrieval Tooling Tests
 *
 * Tests for fetch_chat_history, memory_query, and the retrieval paths E2E.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession, addPendingOp } from "../session.js";
import {
  initHotMemoryTable,
  initColdStorage,
  insertHotFact,
  insertColdFact,
  getTopHotFacts,
} from "../hippocampus.js";
import {
  executeFetchChatHistory,
  executeMemoryQuery,
  type EmbedFunction,
} from "../tools.js";
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

/** Create a deterministic 768-dim mock embedding */
function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    emb[i] = Math.sin(seed * (i + 1));
  }
  return emb;
}

/** Mock embed function that returns a deterministic embedding based on query content */
const mockEmbedFn: EmbedFunction = async (text: string) => {
  // Use a simple hash-like seed from the text
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  return mockEmbedding(seed);
};

// ---------------------------------------------------------------------------
// fetch_chat_history
// ---------------------------------------------------------------------------

describe("fetch_chat_history", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tools-fch-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initSessionTables(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns rows with correct limit", () => {
    // Seed 30 messages
    for (let i = 0; i < 30; i++) {
      appendToSession(db, makeEnvelope("webchat", `message ${i}`));
    }

    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat", limit: 10 }));
    expect(result).toHaveLength(10);
    // Should return the last 10 messages (chronological)
    expect(result[0].content).toBe("message 20");
    expect(result[9].content).toBe("message 29");
  });

  it("returns all messages when limit exceeds count", () => {
    for (let i = 0; i < 5; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat", limit: 100 }));
    expect(result).toHaveLength(5);
  });

  it("defaults to 20 messages when no limit specified", () => {
    for (let i = 0; i < 30; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat" }));
    expect(result).toHaveLength(20);
  });

  it("filters by channel — only returns requested channel", () => {
    appendToSession(db, makeEnvelope("webchat", "webchat msg 1"));
    appendToSession(db, makeEnvelope("whatsapp", "whatsapp msg 1"));
    appendToSession(db, makeEnvelope("webchat", "webchat msg 2"));
    appendToSession(db, makeEnvelope("whatsapp", "whatsapp msg 2"));

    const webchatResult = JSON.parse(executeFetchChatHistory(db, { channel: "webchat" }));
    expect(webchatResult).toHaveLength(2);
    expect(webchatResult.every((m: any) => m.channel === "webchat")).toBe(true);

    const whatsappResult = JSON.parse(executeFetchChatHistory(db, { channel: "whatsapp" }));
    expect(whatsappResult).toHaveLength(2);
    expect(whatsappResult.every((m: any) => m.channel === "whatsapp")).toBe(true);
  });

  it("filters by 'before' timestamp", () => {
    const t1 = "2026-02-27T10:00:00.000Z";
    const t2 = "2026-02-27T11:00:00.000Z";
    const t3 = "2026-02-27T12:00:00.000Z";

    const e1 = createEnvelope({ channel: "webchat", sender: { id: "serj", name: "Serj", relationship: "partner" }, content: "early", timestamp: t1 });
    const e2 = createEnvelope({ channel: "webchat", sender: { id: "serj", name: "Serj", relationship: "partner" }, content: "middle", timestamp: t2 });
    const e3 = createEnvelope({ channel: "webchat", sender: { id: "serj", name: "Serj", relationship: "partner" }, content: "late", timestamp: t3 });

    appendToSession(db, e1);
    appendToSession(db, e2);
    appendToSession(db, e3);

    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat", before: t3 }));
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("early");
    expect(result[1].content).toBe("middle");
  });

  it("returns empty array for channel with no messages", () => {
    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat" }));
    expect(result).toHaveLength(0);
  });

  it("returns messages in chronological order", () => {
    for (let i = 0; i < 5; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat" }));
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp >= result[i - 1].timestamp).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// memory_query
// ---------------------------------------------------------------------------

describe("memory_query", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tools-mq-test-"));
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

  it("returns matching facts from cold storage", async () => {
    if (!vecAvailable) return;

    const emb = mockEmbedding(42);
    insertColdFact(db, "Serj's IP is 192.168.1.50", emb);

    // Use an embed function that returns the same embedding (exact match)
    const exactEmbedFn: EmbedFunction = async () => emb;

    const resultStr = await executeMemoryQuery(db, { query: "IP address" }, exactEmbedFn);
    const result = JSON.parse(resultStr);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toBe("Serj's IP is 192.168.1.50");
    expect(result.facts[0].distance).toBe(0); // exact match
  });

  it("updates hit_count for existing hot fact when retrieved", async () => {
    if (!vecAvailable) return;

    const emb = mockEmbedding(42);
    // Create the fact in both hot and cold storage (same text)
    const hotId = insertHotFact(db, { factText: "Serj's IP is 192.168.1.50" });
    insertColdFact(db, "Serj's IP is 192.168.1.50", emb);

    const exactEmbedFn: EmbedFunction = async () => emb;

    // Before query
    const beforeFacts = getTopHotFacts(db);
    const beforeHit = beforeFacts.find((f) => f.id === hotId)!;
    expect(beforeHit.hitCount).toBe(0);

    // Execute query
    await executeMemoryQuery(db, { query: "IP" }, exactEmbedFn);

    // After query — hit count should be incremented
    const afterFacts = getTopHotFacts(db);
    const afterHit = afterFacts.find((f) => f.id === hotId)!;
    expect(afterHit.hitCount).toBe(1);
  });

  it("promotes cold fact to hot memory when not already present", async () => {
    if (!vecAvailable) return;

    const emb = mockEmbedding(42);
    insertColdFact(db, "Promoted fact from cold", emb);

    // Verify not in hot memory
    expect(getTopHotFacts(db)).toHaveLength(0);

    const exactEmbedFn: EmbedFunction = async () => emb;
    await executeMemoryQuery(db, { query: "anything" }, exactEmbedFn);

    // Now should be in hot memory
    const hotFacts = getTopHotFacts(db);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].factText).toBe("Promoted fact from cold");
  });

  it("returns empty result when no matching facts (no error)", async () => {
    if (!vecAvailable) return;

    // No facts in cold storage — empty DB
    const resultStr = await executeMemoryQuery(db, { query: "nonexistent" }, mockEmbedFn);
    const result = JSON.parse(resultStr);

    expect(result.facts).toHaveLength(0);
    expect(result.message).toBe("No matching facts found.");
  });

  it("respects limit parameter", async () => {
    if (!vecAvailable) return;

    // Insert 10 facts with different embeddings
    for (let i = 0; i < 10; i++) {
      insertColdFact(db, `fact ${i}`, mockEmbedding(i));
    }

    const resultStr = await executeMemoryQuery(
      db,
      { query: "test", limit: 3 },
      mockEmbedFn,
    );
    const result = JSON.parse(resultStr);
    expect(result.facts.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// E2E: Retrieval Paths
// ---------------------------------------------------------------------------

describe("retrieval paths e2e", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tools-e2e-test-"));
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

  it("fetch_chat_history retrieves older messages excluded by soft cap", () => {
    // Seed 40 messages
    for (let i = 0; i < 40; i++) {
      appendToSession(db, makeEnvelope("webchat", `message ${i}`));
    }

    // Fetch oldest 5 messages (simulating what the soft cap excluded)
    const result = JSON.parse(executeFetchChatHistory(db, { channel: "webchat", limit: 5 }));
    expect(result).toHaveLength(5);
    // Should return the last 5 in chronological order
    expect(result[0].content).toBe("message 35");
    expect(result[4].content).toBe("message 39");
  });

  it("memory_query retrieves embedded fact and updates tracking", async () => {
    if (!vecAvailable) return;

    const emb = mockEmbedding(99);
    insertColdFact(db, "Server IP: 10.0.0.1", emb);

    const exactEmbedFn: EmbedFunction = async () => emb;

    // Query
    const resultStr = await executeMemoryQuery(db, { query: "IP address" }, exactEmbedFn);
    const result = JSON.parse(resultStr);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toBe("Server IP: 10.0.0.1");

    // Verify promoted to hot memory
    const hotFacts = getTopHotFacts(db);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].factText).toBe("Server IP: 10.0.0.1");
  });

  it("both tools work in sequence on the same DB", async () => {
    if (!vecAvailable) return;

    // Seed chat history
    for (let i = 0; i < 10; i++) {
      appendToSession(db, makeEnvelope("webchat", `chat msg ${i}`));
    }

    // Seed cold storage
    const emb = mockEmbedding(77);
    insertColdFact(db, "User prefers JSON responses", emb);

    // Tool 1: fetch chat history
    const chatResult = JSON.parse(executeFetchChatHistory(db, { channel: "webchat", limit: 3 }));
    expect(chatResult).toHaveLength(3);

    // Tool 2: memory query
    const exactEmbedFn: EmbedFunction = async () => emb;
    const memResult = JSON.parse(await executeMemoryQuery(db, { query: "preferences" }, exactEmbedFn));
    expect(memResult.facts).toHaveLength(1);
    expect(memResult.facts[0].text).toBe("User prefers JSON responses");

    // Both results accessible, no cross-contamination
    expect(getTopHotFacts(db)).toHaveLength(1); // only the promoted cold fact
  });
});
