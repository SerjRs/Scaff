/**
 * E2E Tests — memory_query returns graph facts in a realistic integration path
 *
 * Uses real Ollama embeddings (nomic-embed-text at 127.0.0.1:11434) — NO mocks.
 * Test 2 uses real Sonnet via simple-complete.ts for the extraction LLM.
 *
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
  evictFact,
  reviveFact,
  searchGraphFacts,
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
    console.warn("⚠ Ollama not available at 127.0.0.1:11434 — skipping e2e-memory-query-graph tests");
  }
});

// ---------------------------------------------------------------------------
// E2E Test Suite
// ---------------------------------------------------------------------------

describe("memory_query graph E2E", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    if (!ollamaAvailable) return;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mq-graph-e2e-"));
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
  // E2E 1: Full pipeline — graph facts with real embeddings
  // -------------------------------------------------------------------------

  it("full pipeline: graph facts with edges returned via memory_query with real embeddings", async () => {
    if (!ollamaAvailable) return;

    // Seed the graph with a realistic knowledge cluster
    const facts = [
      "Scaff was created on February 3, 2026, as an AI assistant",
      "Serj is the primary partner and creator of Scaff",
      "The first conversation happened on 2026-02-03 in webchat channel",
      "Scaff runs on the OpenClaw platform with Cortex as its cognitive core",
      "Daily journal logs have been maintained since first activation",
    ];

    const factIds: string[] = [];
    for (const text of facts) {
      const embedding = await cachedEmbed(text);
      const id = insertFact(db, { factText: text, embedding });
      factIds.push(id);
    }

    // Create edges: creation fact -> sourced_from -> first conversation
    insertEdge(db, { fromFactId: factIds[0], toFactId: factIds[2], edgeType: "sourced_from" });
    // Serj -> created -> Scaff
    insertEdge(db, { fromFactId: factIds[1], toFactId: factIds[0], edgeType: "related_to" });
    // Journal logs -> temporal -> first activation
    insertEdge(db, { fromFactId: factIds[4], toFactId: factIds[0], edgeType: "temporal" });

    // Also add an unrelated cold fact to verify cold results appear
    const coldText = "Config file is stored at ~/.openclaw/openclaw.json";
    const coldEmb = await cachedEmbed(coldText);
    insertColdFact(db, coldText, coldEmb);

    // Query about Scaff's creation — should find graph facts preferentially
    const resultStr = await executeMemoryQuery(
      db,
      { query: "When was Scaff first created and who made it?", limit: 10 },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    // Should have results
    expect(result.facts.length).toBeGreaterThan(0);

    // Should include graph-sourced facts
    const graphFacts = result.facts.filter((f: any) => f.source === "graph");
    expect(graphFacts.length).toBeGreaterThan(0);

    // The creation fact should be among top results
    const creationFact = graphFacts.find((f: any) =>
      f.text.includes("February 3, 2026"),
    );
    expect(creationFact).toBeDefined();
    expect(creationFact.factId).toBeDefined();

    // It should have edges
    expect(creationFact.edges).toBeDefined();
    expect(creationFact.edges.length).toBeGreaterThan(0);

    // Check edge types
    const edgeTypes = creationFact.edges.map((e: any) => e.type);
    expect(edgeTypes.length).toBeGreaterThan(0);

    // Results should be sorted by distance
    for (let i = 1; i < result.facts.length; i++) {
      expect(result.facts[i].distance).toBeGreaterThanOrEqual(
        result.facts[i - 1].distance,
      );
    }

    // Verify side effect: graph facts got touched (hit_count incremented)
    for (const gf of graphFacts) {
      const row = db.prepare(
        `SELECT hit_count FROM hippocampus_facts WHERE id = ?`,
      ).get(gf.factId) as { hit_count: number } | undefined;
      if (row) {
        expect(row.hit_count).toBeGreaterThan(0);
      }
    }

    // Verify side effect: facts promoted to hot memory
    const hotFacts = db.prepare(
      `SELECT fact_text FROM cortex_hot_memory`,
    ).all() as { fact_text: string }[];
    expect(hotFacts.length).toBeGreaterThan(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // E2E 2: Eviction → cold search → revival
  // -------------------------------------------------------------------------

  it("evicted graph fact found via cold storage and revived", async () => {
    if (!ollamaAvailable) return;

    // Insert a fact with embedding in graph
    const factText = "The webchat gateway uses WebSocket protocol for real-time messaging";
    const embedding = await cachedEmbed(factText);
    const factId = insertFact(db, { factText, embedding });

    // Insert a connected fact and edge
    const relatedText = "WebSocket connections are authenticated via OAuth tokens";
    const relatedEmb = await cachedEmbed(relatedText);
    const relatedId = insertFact(db, { factText: relatedText, embedding: relatedEmb });
    insertEdge(db, { fromFactId: factId, toFactId: relatedId, edgeType: "related_to" });

    // Verify fact exists in graph search before eviction
    const beforeEviction = searchGraphFacts(db, embedding, 5);
    expect(beforeEviction.some((f) => f.id === factId)).toBe(true);

    // Evict the fact — moves to cold storage, marks edges as stubs
    evictFact(db, factId, embedding);

    // Verify it's gone from graph search (status = evicted)
    const afterEviction = searchGraphFacts(db, embedding, 5);
    expect(afterEviction.some((f) => f.id === factId)).toBe(false);

    // Now search via memory_query — should find it from cold storage
    const resultStr = await executeMemoryQuery(
      db,
      { query: "WebSocket real-time messaging protocol" },
      cachedEmbed,
    );
    const result = JSON.parse(resultStr);

    expect(result.facts.length).toBeGreaterThan(0);
    const matchingFact = result.facts.find((f: any) =>
      f.text.includes("WebSocket protocol"),
    );
    expect(matchingFact).toBeDefined();

    // The memory_query side effect should have revived the evicted fact
    const revivedRow = db.prepare(
      `SELECT status FROM hippocampus_facts WHERE id = ?`,
    ).get(factId) as { status: string } | undefined;
    expect(revivedRow).toBeDefined();
    expect(revivedRow!.status).toBe("active");

    // Edges should be reconnected (un-stubbed) since the other endpoint is active
    const edge = db.prepare(
      `SELECT is_stub FROM hippocampus_edges WHERE from_fact_id = ? AND to_fact_id = ?`,
    ).get(factId, relatedId) as { is_stub: number } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.is_stub).toBe(0);
  }, 30_000);
});
