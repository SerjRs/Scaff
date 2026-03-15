/**
 * Consolidator Tests — Cross-Connection Discovery
 *
 * Tests for runConsolidation: finding missing edges between facts
 * via embedding similarity + LLM relationship identification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables } from "../session.js";
import {
  initHotMemoryTable,
  initGraphVecTable,
  insertFact,
  insertEdge,
} from "../hippocampus.js";
import { runConsolidation } from "../consolidator.js";
import type { FactExtractorLLM } from "../gardener.js";
import type { EmbedFunction } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    emb[i] = Math.sin(seed * (i + 1));
  }
  return emb;
}

/** Deterministic embed function based on text content */
const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  return mockEmbedding(Math.abs(seed));
};

/** Helper to insert a fact with embedding for vec search */
function insertFactWithEmbedding(
  db: DatabaseSync,
  opts: { factText: string; factType?: string; sourceType?: string; createdAt?: string },
): string {
  const id = insertFact(db, {
    factText: opts.factText,
    factType: opts.factType ?? "fact",
    sourceType: opts.sourceType ?? "conversation",
  });

  // Override created_at if specified
  if (opts.createdAt) {
    db.prepare(`UPDATE hippocampus_facts SET created_at = ? WHERE id = ?`).run(opts.createdAt, id);
  }

  // Insert embedding into vec table
  let seed = 0;
  for (let i = 0; i < opts.factText.length; i++) {
    seed = (seed * 31 + opts.factText.charCodeAt(i)) | 0;
  }
  const embedding = mockEmbedding(Math.abs(seed));
  const row = db.prepare(`SELECT rowid FROM hippocampus_facts WHERE id = ?`).get(id) as { rowid: number | bigint };
  const rowidNum = Number(row.rowid);
  db.prepare(`INSERT INTO hippocampus_facts_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(
    rowidNum,
    new Uint8Array(embedding.buffer),
  );

  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Consolidator", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-consolidator-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    initSessionTables(db);
    initHotMemoryTable(db);
    await initGraphVecTable(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch { /* */ }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* */ }
  });

  it("discovers edge between two unconnected facts about same topic", async () => {
    const recentTime = new Date().toISOString();
    const id1 = insertFactWithEmbedding(db, {
      factText: "Serj uses TypeScript for all projects",
      createdAt: recentTime,
    });
    const id2 = insertFactWithEmbedding(db, {
      factText: "The project is built with TypeScript and Node.js",
      createdAt: recentTime,
    });

    const mockLLM: FactExtractorLLM = async () => {
      return JSON.stringify({
        edges: [{ from: id1, to: id2, type: "related_to" }],
      });
    };

    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: mockLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.factsScanned).toBe(2);
    expect(result.edgesDiscovered).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify edge was actually inserted
    const edges = db.prepare(
      `SELECT * FROM hippocampus_edges WHERE from_fact_id = ? AND to_fact_id = ?`,
    ).all(id1, id2) as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("related_to");
    expect(edges[0].confidence).toBe("medium");
  });

  it("discovers cross-source edges between conversation and article facts", async () => {
    const recentTime = new Date().toISOString();
    const id1 = insertFactWithEmbedding(db, {
      factText: "Team decided to use Redis for caching",
      sourceType: "conversation",
      createdAt: recentTime,
    });
    const id2 = insertFactWithEmbedding(db, {
      factText: "Redis provides in-memory data structure store for caching",
      sourceType: "article",
      createdAt: recentTime,
    });

    const mockLLM: FactExtractorLLM = async () => {
      return JSON.stringify({
        edges: [{ from: id1, to: id2, type: "informed_by" }],
      });
    };

    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: mockLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.edgesDiscovered).toBe(1);

    const edges = db.prepare(
      `SELECT * FROM hippocampus_edges WHERE from_fact_id = ? AND to_fact_id = ?`,
    ).all(id1, id2) as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("informed_by");
  });

  it("does not create duplicate edges for already-connected facts", async () => {
    const recentTime = new Date().toISOString();
    const id1 = insertFactWithEmbedding(db, {
      factText: "Application uses PostgreSQL database",
      createdAt: recentTime,
    });
    const id2 = insertFactWithEmbedding(db, {
      factText: "PostgreSQL is configured with connection pooling",
      createdAt: recentTime,
    });

    // Pre-insert an edge
    insertEdge(db, { fromFactId: id1, toFactId: id2, edgeType: "related_to" });

    const mockLLM: FactExtractorLLM = async () => {
      return JSON.stringify({
        edges: [{ from: id1, to: id2, type: "related_to" }],
      });
    };

    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: mockLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.edgesDiscovered).toBe(0);

    // Only the original edge should exist
    const edges = db.prepare(
      `SELECT * FROM hippocampus_edges WHERE from_fact_id = ? AND to_fact_id = ?`,
    ).all(id1, id2) as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
  });

  it("returns no-op when no recent facts exist", async () => {
    // Set since far in the future
    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: async () => '{"edges": []}',
      since: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(result.factsScanned).toBe(0);
    expect(result.edgesDiscovered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles LLM returning empty edges array without crashing", async () => {
    const recentTime = new Date().toISOString();
    insertFactWithEmbedding(db, {
      factText: "Some fact about the system",
      createdAt: recentTime,
    });
    insertFactWithEmbedding(db, {
      factText: "Another completely different fact",
      createdAt: recentTime,
    });

    const mockLLM: FactExtractorLLM = async () => {
      return JSON.stringify({ edges: [] });
    };

    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: mockLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.factsScanned).toBe(2);
    expect(result.edgesDiscovered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles malformed LLM output gracefully", async () => {
    const recentTime = new Date().toISOString();
    insertFactWithEmbedding(db, {
      factText: "A fact for malformed test",
      createdAt: recentTime,
    });
    insertFactWithEmbedding(db, {
      factText: "Another fact for malformed test",
      createdAt: recentTime,
    });

    const mockLLM: FactExtractorLLM = async () => {
      return "This is not JSON at all, just garbage text!!!";
    };

    const result = await runConsolidation({
      db,
      embedFn: mockEmbedFn,
      llmFn: mockLLM,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect(result.factsScanned).toBe(2);
    expect(result.edgesDiscovered).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("malformed");
  });
});
