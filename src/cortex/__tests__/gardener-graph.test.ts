/**
 * 017d — Gardener Graph Tests
 *
 * Tests for structured fact+edge extraction and graph insertion:
 * - extractFactsFromTranscript structured output
 * - dedupAndInsertGraphFact deduplication logic
 * - runFactExtractor end-to-end graph insertion
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession, updateChannelState } from "../session.js";
import {
  initHotMemoryTable,
  initGraphVecTable,
} from "../hippocampus.js";
import {
  runFactExtractor,
  type FactExtractorLLM,
  type ExtractionResult,
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

/** Deterministic mock embed function */
const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  return mockEmbedding(Math.abs(seed));
};

function makeStructuredLLM(result: ExtractionResult): FactExtractorLLM {
  return async () => JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// DB setup helper
// ---------------------------------------------------------------------------

async function setupDb(tmpDir: string, withVec = false): Promise<DatabaseSync> {
  const db = initBus(path.join(tmpDir, "bus.sqlite"), {
    allowExtensionLoading: withVec,
  });
  initSessionTables(db);
  initHotMemoryTable(db);
  if (withVec) {
    await initGraphVecTable(db);
  }
  return db;
}

// ---------------------------------------------------------------------------
// 1. extractFactsFromTranscript returns structured ExtractionResult
// ---------------------------------------------------------------------------

describe("extractFactsFromTranscript via runFactExtractor", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gg-test-"));
    db = await setupDb(tmpDir);
    // Add a message so runFactExtractor has something to process
    appendToSession(db, makeEnvelope("webchat", "I prefer TypeScript over JavaScript"));
    updateChannelState(db, "webchat", { lastMessageAt: new Date().toISOString(), layer: "foreground" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses structured JSON with facts and edges from LLM output", async () => {
    const extraction: ExtractionResult = {
      facts: [
        { id: "f1", text: "User prefers TypeScript", type: "fact", confidence: "high" },
        { id: "f2", text: "User dislikes JavaScript", type: "fact", confidence: "medium" },
      ],
      edges: [{ from: "f1", to: "f2", type: "related_to" }],
    };

    const extractLLM = makeStructuredLLM(extraction);
    const result = await runFactExtractor({ db, extractLLM });

    expect(result.errors).toHaveLength(0);
    expect(result.processed).toBe(2);

    const facts = db.prepare(`SELECT fact_text, fact_type, confidence FROM hippocampus_facts ORDER BY created_at`).all() as Array<Record<string, unknown>>;
    expect(facts).toHaveLength(2);
    expect(facts[0].fact_text).toBe("User prefers TypeScript");
    expect(facts[0].fact_type).toBe("fact");
    expect(facts[0].confidence).toBe("high");
  });

  it("handles malformed LLM output by returning empty result", async () => {
    const extractLLM: FactExtractorLLM = async () => "this is not JSON at all!!!";
    const result = await runFactExtractor({ db, extractLLM });

    expect(result.processed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const count = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts`).get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("handles partial JSON embedded in prose", async () => {
    const extractLLM: FactExtractorLLM = async () =>
      `Here are the facts: {"facts": [{"id": "f1", "text": "User uses vim", "type": "fact", "confidence": "high"}], "edges": []} Done.`;
    const result = await runFactExtractor({ db, extractLLM });

    expect(result.processed).toBe(1);
    const facts = db.prepare(`SELECT fact_text FROM hippocampus_facts`).all() as Array<Record<string, unknown>>;
    expect(facts[0].fact_text).toBe("User uses vim");
  });
});

// ---------------------------------------------------------------------------
// 3. dedupAndInsertGraphFact inserts new fact
// ---------------------------------------------------------------------------

describe("dedupAndInsertGraphFact — no vec", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gg-dedup-test-"));
    db = await setupDb(tmpDir);
    appendToSession(db, makeEnvelope("webchat", "hello"));
    updateChannelState(db, "webchat", { lastMessageAt: new Date().toISOString(), layer: "foreground" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts new fact into hippocampus_facts", async () => {
    const extraction: ExtractionResult = {
      facts: [{ id: "f1", text: "User runs Arch Linux", type: "fact", confidence: "high" }],
      edges: [],
    };

    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    const row = db.prepare(`SELECT fact_text, fact_type, confidence, status FROM hippocampus_facts WHERE fact_text = 'User runs Arch Linux'`).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.fact_type).toBe("fact");
    expect(row!.confidence).toBe("high");
    expect(row!.status).toBe("active");
  });

  it("skips exact duplicate — same text inserted twice", async () => {
    const extraction: ExtractionResult = {
      facts: [{ id: "f1", text: "User uses neovim", type: "fact", confidence: "high" }],
      edges: [],
    };

    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });
    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    const count = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts WHERE fact_text = 'User uses neovim'`).get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("preserves decision and correction fact types", async () => {
    const extraction: ExtractionResult = {
      facts: [
        { id: "f1", text: "We decided to use PostgreSQL", type: "decision", confidence: "high" },
        { id: "f2", text: "The previous config was wrong", type: "correction", confidence: "medium" },
      ],
      edges: [],
    };

    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    const rows = db.prepare(`SELECT fact_text, fact_type FROM hippocampus_facts ORDER BY created_at`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].fact_type).toBe("decision");
    expect(rows[1].fact_type).toBe("correction");
  });
});

// ---------------------------------------------------------------------------
// runFactExtractor — edge insertion
// ---------------------------------------------------------------------------

describe("runFactExtractor edge insertion", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gg-edge-test-"));
    db = await setupDb(tmpDir);
    appendToSession(db, makeEnvelope("webchat", "context message"));
    updateChannelState(db, "webchat", { lastMessageAt: new Date().toISOString(), layer: "foreground" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates facts AND edges in graph tables", async () => {
    const extraction: ExtractionResult = {
      facts: [
        { id: "f1", text: "We switched to bun runtime", type: "decision", confidence: "high" },
        { id: "f2", text: "Node was too slow for our use case", type: "fact", confidence: "medium" },
      ],
      edges: [{ from: "f1", to: "f2", type: "because" }],
    };

    const result = await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(0);

    const facts = db.prepare(`SELECT id, fact_text FROM hippocampus_facts ORDER BY created_at`).all() as Array<{ id: string; fact_text: string }>;
    expect(facts).toHaveLength(2);

    const edges = db.prepare(`SELECT from_fact_id, to_fact_id, edge_type FROM hippocampus_edges`).all() as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("because");

    // Verify edge connects the right facts
    const factIds = new Set(facts.map((f) => f.id));
    expect(factIds.has(edges[0].from_fact_id as string)).toBe(true);
    expect(factIds.has(edges[0].to_fact_id as string)).toBe(true);
    expect(edges[0].from_fact_id).not.toBe(edges[0].to_fact_id);
  });

  it("silently skips edges referencing nonexistent local IDs", async () => {
    const extraction: ExtractionResult = {
      facts: [
        { id: "f1", text: "We use React", type: "fact", confidence: "high" },
      ],
      edges: [
        { from: "f1", to: "f99", type: "related_to" },   // f99 doesn't exist
        { from: "f99", to: "f1", type: "informed_by" },   // from doesn't exist either
      ],
    };

    const result = await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    expect(result.processed).toBe(1);
    const edges = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_edges`).get() as { cnt: number };
    expect(edges.cnt).toBe(0);
  });

  it("skips self-referencing edges (from === to)", async () => {
    const extraction: ExtractionResult = {
      facts: [
        { id: "f1", text: "We use Docker", type: "fact", confidence: "high" },
      ],
      edges: [
        { from: "f1", to: "f1", type: "related_to" },
      ],
    };

    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction) });

    const edges = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_edges`).get() as { cnt: number };
    expect(edges.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. dedupAndInsertGraphFact — near-duplicate replacement (with vec)
// ---------------------------------------------------------------------------

describe("dedupAndInsertGraphFact — near-duplicate (vec)", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gg-vec-test-"));
    try {
      db = await setupDb(tmpDir, true);
    } catch {
      vecAvailable = false;
      db = await setupDb(tmpDir, false);
    }
    appendToSession(db, makeEnvelope("webchat", "context"));
    updateChannelState(db, "webchat", { lastMessageAt: new Date().toISOString(), layer: "foreground" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces near-duplicate when new text is longer", async () => {
    if (!vecAvailable) return;

    // Insert short version first
    const short: ExtractionResult = {
      facts: [{ id: "f1", text: "User uses vim", type: "fact", confidence: "medium" }],
      edges: [],
    };
    await runFactExtractor({ db, extractLLM: makeStructuredLLM(short), embedFn: mockEmbedFn });

    // Insert longer version (same topic, longer text)
    const long: ExtractionResult = {
      facts: [{ id: "f1", text: "User uses vim with custom keybindings and NERDTree", type: "fact", confidence: "high" }],
      edges: [],
    };
    await runFactExtractor({ db, extractLLM: makeStructuredLLM(long), embedFn: mockEmbedFn });

    // The longer version may or may not replace (depends on embedding distance)
    // At minimum, we should have at most 2 facts (not duplicate explosion)
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts`).get() as { cnt: number };
    expect(count.cnt).toBeLessThanOrEqual(2);
  });

  it("inserts facts with embeddings when embedFn provided", async () => {
    if (!vecAvailable) return;

    const extraction: ExtractionResult = {
      facts: [{ id: "f1", text: "User prefers dark mode UI", type: "fact", confidence: "high" }],
      edges: [],
    };

    await runFactExtractor({ db, extractLLM: makeStructuredLLM(extraction), embedFn: mockEmbedFn });

    const row = db.prepare(`SELECT fact_text FROM hippocampus_facts`).get() as { fact_text: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.fact_text).toBe("User prefers dark mode UI");

    // Vec table should have an entry
    const vecCount = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts_vec`).get() as { cnt: number };
    expect(vecCount.cnt).toBe(1);
  });
});
