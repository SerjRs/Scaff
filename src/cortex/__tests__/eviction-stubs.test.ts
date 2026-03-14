/**
 * 017h — Eviction Edge Stubs + Revival Tests
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
  initColdStorage,
  initGraphVecTable,
  insertFact,
  insertEdge,
  getTopFactsWithEdges,
  getStaleGraphFacts,
  evictFact,
  reviveFact,
  pruneOldStubs,
  touchGraphFact,
} from "../hippocampus.js";
import { executeMemoryQuery } from "../tools.js";
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

const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  return mockEmbedding(Math.abs(seed));
};

/** Insert a fact with an old last_accessed_at to make it stale */
function insertStaleFact(
  db: DatabaseSync,
  factText: string,
  daysOld: number,
  hitCount = 1,
): string {
  const id = insertFact(db, { factText });
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - daysOld);
  db.prepare(`
    UPDATE hippocampus_facts
    SET last_accessed_at = ?, hit_count = ?
    WHERE id = ?
  `).run(oldDate.toISOString(), hitCount, id);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Eviction Edge Stubs", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-eviction-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    initSessionTables(db);
    initHotMemoryTable(db);
    await initColdStorage(db);
    await initGraphVecTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
  });

  // 1. evictFact moves fact to cold + sets edges as stubs
  it("evictFact moves fact to cold storage and sets edges as stubs", async () => {
    const factA = insertFact(db, { factText: "Alpha fact about testing" });
    const factB = insertFact(db, { factText: "Beta fact about deployment" });
    const edgeId = insertEdge(db, { fromFactId: factA, toFactId: factB, edgeType: "related_to" });

    const embedding = await mockEmbedFn("Alpha fact about testing");
    evictFact(db, factA, embedding);

    // Fact should be evicted
    const fact = db.prepare(`SELECT status FROM hippocampus_facts WHERE id = ?`).get(factA) as { status: string };
    expect(fact.status).toBe("evicted");

    // Edge should be a stub with topic
    const edge = db.prepare(`SELECT is_stub, stub_topic FROM hippocampus_edges WHERE id = ?`).get(edgeId) as { is_stub: number; stub_topic: string };
    expect(edge.is_stub).toBe(1);
    expect(edge.stub_topic).toBe("Alpha fact about testing");

    // Cold storage should have the fact
    const cold = db.prepare(`SELECT fact_text FROM cortex_cold_memory WHERE fact_text = ?`).get("Alpha fact about testing") as { fact_text: string } | undefined;
    expect(cold).toBeDefined();
    expect(cold!.fact_text).toBe("Alpha fact about testing");
  });

  // 2. evictFact stores cold_vector_id
  it("evictFact stores cold_vector_id on the hippocampus_facts row", async () => {
    const factA = insertFact(db, { factText: "Fact with cold vector ID" });
    const embedding = await mockEmbedFn("Fact with cold vector ID");
    evictFact(db, factA, embedding);

    const row = db.prepare(`SELECT cold_vector_id FROM hippocampus_facts WHERE id = ?`).get(factA) as { cold_vector_id: number | null };
    expect(row.cold_vector_id).not.toBeNull();
    expect(typeof row.cold_vector_id).toBe("number");
  });

  // 3. Evicted facts excluded from getTopFactsWithEdges
  it("evicted facts do not appear in getTopFactsWithEdges", async () => {
    const factA = insertFact(db, { factText: "Active fact" });
    const factB = insertFact(db, { factText: "To be evicted fact" });

    const embedding = await mockEmbedFn("To be evicted fact");
    evictFact(db, factB, embedding);

    const top = getTopFactsWithEdges(db, 50);
    const ids = top.map((f) => f.id);
    expect(ids).toContain(factA);
    expect(ids).not.toContain(factB);
  });

  // 4. reviveFact restores status and reconnects edges
  it("reviveFact restores status and reconnects edges with active endpoints", async () => {
    const factA = insertFact(db, { factText: "Fact A for revival" });
    const factB = insertFact(db, { factText: "Fact B stays active" });
    const edgeId = insertEdge(db, { fromFactId: factA, toFactId: factB, edgeType: "related_to" });

    // Evict A
    const embedding = await mockEmbedFn("Fact A for revival");
    evictFact(db, factA, embedding);

    // Verify edge is stub
    let edge = db.prepare(`SELECT is_stub FROM hippocampus_edges WHERE id = ?`).get(edgeId) as { is_stub: number };
    expect(edge.is_stub).toBe(1);

    // Revive A
    reviveFact(db, factA);

    // Fact should be active again
    const fact = db.prepare(`SELECT status, hit_count, cold_vector_id FROM hippocampus_facts WHERE id = ?`).get(factA) as { status: string; hit_count: number; cold_vector_id: number | null };
    expect(fact.status).toBe("active");
    expect(fact.hit_count).toBe(1);
    expect(fact.cold_vector_id).toBeNull();

    // Edge should be reconnected (B is active)
    edge = db.prepare(`SELECT is_stub FROM hippocampus_edges WHERE id = ?`).get(edgeId) as { is_stub: number };
    expect(edge.is_stub).toBe(0);
  });

  // 5. reviveFact leaves stubs for still-evicted endpoints
  it("reviveFact leaves stubs when the other endpoint is still evicted", async () => {
    const factA = insertFact(db, { factText: "Fact A both evicted" });
    const factB = insertFact(db, { factText: "Fact B both evicted" });
    const edgeId = insertEdge(db, { fromFactId: factA, toFactId: factB, edgeType: "because" });

    // Evict both
    evictFact(db, factA, await mockEmbedFn("Fact A both evicted"));
    evictFact(db, factB, await mockEmbedFn("Fact B both evicted"));

    // Revive only A
    reviveFact(db, factA);

    // Edge should still be a stub (B is still evicted)
    const edge = db.prepare(`SELECT is_stub FROM hippocampus_edges WHERE id = ?`).get(edgeId) as { is_stub: number };
    expect(edge.is_stub).toBe(1);
  });

  // 6. pruneOldStubs deletes old stubs where both endpoints evicted
  it("pruneOldStubs deletes old stubs where both endpoints are evicted", async () => {
    const factA = insertFact(db, { factText: "Old stub fact A" });
    const factB = insertFact(db, { factText: "Old stub fact B" });

    // Evict both
    evictFact(db, factA, await mockEmbedFn("Old stub fact A"));
    evictFact(db, factB, await mockEmbedFn("Old stub fact B"));

    // Manually insert an old edge (created 100 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    db.prepare(`
      INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, is_stub, stub_topic, created_at)
      VALUES ('old-edge-1', ?, ?, 'related_to', 1, 'test topic', ?)
    `).run(factA, factB, oldDate.toISOString());

    const deleted = pruneOldStubs(db, 90);
    expect(deleted).toBe(1);

    // Edge should be gone
    const edge = db.prepare(`SELECT id FROM hippocampus_edges WHERE id = 'old-edge-1'`).get();
    expect(edge).toBeUndefined();
  });

  // 7. pruneOldStubs keeps stubs where one endpoint is active
  it("pruneOldStubs keeps stubs where one endpoint is active", async () => {
    const factA = insertFact(db, { factText: "Active endpoint fact" });
    const factB = insertFact(db, { factText: "Evicted endpoint fact" });

    // Only evict B
    evictFact(db, factB, await mockEmbedFn("Evicted endpoint fact"));

    // Insert old stub edge
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    db.prepare(`
      INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, is_stub, stub_topic, created_at)
      VALUES ('keep-edge-1', ?, ?, 'related_to', 1, 'test topic', ?)
    `).run(factA, factB, oldDate.toISOString());

    const deleted = pruneOldStubs(db, 90);
    expect(deleted).toBe(0);

    // Edge should still exist
    const edge = db.prepare(`SELECT id FROM hippocampus_edges WHERE id = 'keep-edge-1'`).get();
    expect(edge).toBeDefined();
  });

  // 8. getStaleGraphFacts returns only active stale facts
  it("getStaleGraphFacts returns only active stale facts", async () => {
    // Insert a stale active fact (20 days old, 1 hit)
    const staleId = insertStaleFact(db, "Stale active fact", 20, 1);

    // Insert a fresh active fact (1 day old)
    const freshId = insertStaleFact(db, "Fresh active fact", 1, 1);

    // Insert an evicted stale fact (should NOT be returned)
    const evictedId = insertStaleFact(db, "Stale evicted fact", 20, 1);
    evictFact(db, evictedId, await mockEmbedFn("Stale evicted fact"));

    const stale = getStaleGraphFacts(db, 14, 3);
    const ids = stale.map((f) => f.id);

    expect(ids).toContain(staleId);
    expect(ids).not.toContain(freshId);
    expect(ids).not.toContain(evictedId);
  });

  // 9. executeMemoryQuery revives evicted graph fact on cold hit
  it("executeMemoryQuery revives evicted graph fact on cold hit", async () => {
    const factText = "Important fact about API endpoints";
    const factId = insertFact(db, { factText });

    // Evict the fact (this puts it in cold storage)
    const embedding = await mockEmbedFn(factText);
    evictFact(db, factId, embedding);

    // Verify it's evicted
    let row = db.prepare(`SELECT status FROM hippocampus_facts WHERE id = ?`).get(factId) as { status: string };
    expect(row.status).toBe("evicted");

    // Query cold storage — should find and revive
    await executeMemoryQuery(db, { query: factText }, mockEmbedFn);

    // Verify it's been revived
    row = db.prepare(`SELECT status FROM hippocampus_facts WHERE id = ?`).get(factId) as { status: string };
    expect(row.status).toBe("active");
  });
});
