/**
 * Unit Tests — memory_query searches hippocampus_facts_vec (graph facts)
 *
 * Uses real Ollama embeddings (nomic-embed-text at 127.0.0.1:11434) — NO mocks.
 * @see workspace/pipeline/Cooking/023-memory-query-graph-search/SPEC.md
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables } from "../session.js";
import {
  initHotMemoryTable,
  initColdStorage,
  initGraphVecTable,
  insertFact,
  insertEdge,
  insertColdFact,
} from "../hippocampus.js";
import {
  executeMemoryQuery,
  embedViaOllama,
  type EmbedFunction,
} from "../tools.js";

// ---------------------------------------------------------------------------
// Real Ollama embed function
// ---------------------------------------------------------------------------

const embedFn: EmbedFunction = embedViaOllama;

/** Cache embeddings to reduce Ollama calls within a single test run */
const embeddingCache = new Map<string, Float32Array>();
async function cachedEmbed(text: string): Promise<Float32Array> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;
  const emb = await embedFn(text);
  embeddingCache.set(text, emb);
  return emb;
}

// ---------------------------------------------------------------------------
// Ollama availability check
// ---------------------------------------------------------------------------

let ollamaAvailable = false;

beforeAll(async () => {
  try {
    const emb = await embedFn("ping");
    ollamaAvailable = emb.length === 768;
  } catch {
    console.warn("⚠ Ollama not available at 127.0.0.1:11434 — skipping unit-memory-query tests");
  }
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("memory_query graph search", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    if (!ollamaAvailable) return;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mq-graph-unit-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    initSessionTables(db);
    initHotMemoryTable(db);
    await initColdStorage(db);
    await initGraphVecTable(db);
  });

  afterEach(() => {
    if (!ollamaAvailable) return;
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Graph facts appear in memory_query results
  // -------------------------------------------------------------------------

  it("graph facts appear in memory_query results", async () => {
    if (!ollamaAvailable) return;

    const factText = "Scaff was created on February 3, 2026";
    const embedding = await cachedEmbed(factText);
    insertFact(db, { factText, embedding });

    const resultStr = await executeMemoryQuery(
      db,
      { query: "when was Scaff created" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    expect(result.facts.length).toBeGreaterThan(0);
    const graphFact = result.facts.find((f: any) => f.source === "graph");
    expect(graphFact).toBeDefined();
    expect(graphFact.text).toBe(factText);
    expect(graphFact.factId).toBeDefined();
    expect(typeof graphFact.factId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // 2. Graph facts include edge hints
  // -------------------------------------------------------------------------

  it("graph facts include edge hints", async () => {
    if (!ollamaAvailable) return;

    const factAText = "Scaff was created on February 3, 2026";
    const factBText = "2026-02-03 daily log entry";
    const embA = await cachedEmbed(factAText);
    const embB = await cachedEmbed(factBText);

    const factAId = insertFact(db, { factText: factAText, embedding: embA });
    const factBId = insertFact(db, { factText: factBText, embedding: embB });
    insertEdge(db, { fromFactId: factAId, toFactId: factBId, edgeType: "sourced_from" });

    const resultStr = await executeMemoryQuery(
      db,
      { query: "Scaff creation date" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    const graphFact = result.facts.find((f: any) => f.source === "graph" && f.text === factAText);
    expect(graphFact).toBeDefined();
    expect(graphFact.edges).toBeDefined();
    expect(graphFact.edges.length).toBeGreaterThan(0);

    const edge = graphFact.edges.find((e: any) => e.type === "sourced_from");
    expect(edge).toBeDefined();
    expect(edge.target).toContain("2026-02-03");
  });

  // -------------------------------------------------------------------------
  // 3. Cold facts still returned alongside graph facts
  // -------------------------------------------------------------------------

  it("cold facts returned alongside graph facts, sorted by distance", async () => {
    if (!ollamaAvailable) return;

    // Insert a graph fact about creation
    const graphText = "Scaff was created on February 3, 2026";
    const graphEmb = await cachedEmbed(graphText);
    insertFact(db, { factText: graphText, embedding: graphEmb });

    // Insert a cold fact about something related
    const coldText = "The first activation happened in early February 2026";
    const coldEmb = await cachedEmbed(coldText);
    insertColdFact(db, coldText, coldEmb);

    const resultStr = await executeMemoryQuery(
      db,
      { query: "when was the system first created", limit: 10 },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    const sources = result.facts.map((f: any) => f.source);
    expect(sources).toContain("graph");
    expect(sources).toContain("cold");

    // Verify sorted by distance
    for (let i = 1; i < result.facts.length; i++) {
      expect(result.facts[i].distance).toBeGreaterThanOrEqual(result.facts[i - 1].distance);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Dedup: same fact in both cold and graph → prefer graph
  // -------------------------------------------------------------------------

  it("deduplicates same fact text across graph and cold, preferring graph", async () => {
    if (!ollamaAvailable) return;

    const sharedText = "Scaff was created on February 3, 2026";
    const embedding = await cachedEmbed(sharedText);

    // Insert in both cold and graph
    insertFact(db, { factText: sharedText, embedding });
    insertColdFact(db, sharedText, embedding);

    const resultStr = await executeMemoryQuery(
      db,
      { query: "when was Scaff created" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    // Should have exactly one result for this fact text (no duplicate)
    const matching = result.facts.filter((f: any) => f.text === sharedText);
    expect(matching).toHaveLength(1);
    expect(matching[0].source).toBe("graph"); // graph preferred
    expect(matching[0].factId).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 5. Empty graph + populated cold still works (backward compat)
  // -------------------------------------------------------------------------

  it("returns cold facts when graph is empty", async () => {
    if (!ollamaAvailable) return;

    const coldText = "Some archived knowledge about the system";
    const embedding = await cachedEmbed(coldText);
    insertColdFact(db, coldText, embedding);

    // No graph facts inserted
    const resultStr = await executeMemoryQuery(
      db,
      { query: "system knowledge" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].source).toBe("cold");
    expect(result.facts[0].archivedAt).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. Empty cold + populated graph works
  // -------------------------------------------------------------------------

  it("returns graph facts when cold storage is empty", async () => {
    if (!ollamaAvailable) return;

    const graphText = "Daily logs span from 2026-02-03 to present";
    const embedding = await cachedEmbed(graphText);
    insertFact(db, { factText: graphText, embedding });

    // No cold facts inserted
    const resultStr = await executeMemoryQuery(
      db,
      { query: "daily logs date range" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].source).toBe("graph");
    expect(result.facts[0].factId).toBeDefined();
  });
});
