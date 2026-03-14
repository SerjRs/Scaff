/**
 * Hippocampus Graph — hippocampus_facts + hippocampus_edges Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import {
  initHotMemoryTable,
  initGraphTables,
  migrateHotMemoryToGraph,
  insertHotFact,
  insertFact,
  insertEdge,
  getFactWithEdges,
  getTopFactsWithEdges,
  updateFactStatus,
  setEdgeStub,
  touchGraphFact,
} from "../hippocampus.js";

describe("graph schema", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graph-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initHotMemoryTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // initGraphTables
  // ---------------------------------------------------------------------------

  describe("initGraphTables", () => {
    it("creates hippocampus_facts table", () => {
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='hippocampus_facts'`,
      ).get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("hippocampus_facts");
    });

    it("creates hippocampus_edges table", () => {
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='hippocampus_edges'`,
      ).get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("hippocampus_edges");
    });

    it("is idempotent (calling twice is safe)", () => {
      initGraphTables(db);
      initGraphTables(db);
      const id = insertFact(db, { factText: "still works" });
      expect(id).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // migrateHotMemoryToGraph
  // ---------------------------------------------------------------------------

  describe("migrateHotMemoryToGraph", () => {
    it("copies facts from cortex_hot_memory", () => {
      insertHotFact(db, { factText: "fact one" });
      insertHotFact(db, { factText: "fact two" });

      migrateHotMemoryToGraph(db);

      const count = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts`).get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it("preserves original id, timestamps, and hit_count", () => {
      const hotId = insertHotFact(db, { factText: "preserve me" });
      // Manually set a known hit_count
      db.prepare(`UPDATE cortex_hot_memory SET hit_count = 7 WHERE id = ?`).run(hotId);

      migrateHotMemoryToGraph(db);

      const row = db.prepare(`SELECT * FROM hippocampus_facts WHERE id = ?`).get(hotId) as Record<string, unknown>;
      expect(row.id).toBe(hotId);
      expect(row.fact_text).toBe("preserve me");
      expect(row.hit_count).toBe(7);
      expect(row.fact_type).toBe("fact");
      expect(row.source_type).toBe("conversation");
      expect(row.status).toBe("active");
      expect(row.confidence).toBe("medium");
    });

    it("is idempotent (no duplicates on second run)", () => {
      insertHotFact(db, { factText: "only once" });
      migrateHotMemoryToGraph(db);
      migrateHotMemoryToGraph(db);

      const count = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts`).get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // CRUD — insertFact + insertEdge
  // ---------------------------------------------------------------------------

  describe("insertFact + insertEdge", () => {
    it("inserts a fact and returns its ID", () => {
      const id = insertFact(db, { factText: "graph fact" });
      expect(id).toBeDefined();
      expect(typeof id).toBe("string");

      const row = db.prepare(`SELECT * FROM hippocampus_facts WHERE id = ?`).get(id) as Record<string, unknown>;
      expect(row.fact_text).toBe("graph fact");
      expect(row.fact_type).toBe("fact");
      expect(row.confidence).toBe("medium");
      expect(row.status).toBe("active");
      expect(row.hit_count).toBe(0);
    });

    it("accepts optional factType, confidence, sourceType, sourceRef", () => {
      const id = insertFact(db, {
        factText: "decision node",
        factType: "decision",
        confidence: "high",
        sourceType: "article",
        sourceRef: "library://item/42",
      });
      const row = db.prepare(`SELECT * FROM hippocampus_facts WHERE id = ?`).get(id) as Record<string, unknown>;
      expect(row.fact_type).toBe("decision");
      expect(row.confidence).toBe("high");
      expect(row.source_type).toBe("article");
      expect(row.source_ref).toBe("library://item/42");
    });

    it("inserts an edge between two facts", () => {
      const f1 = insertFact(db, { factText: "cause" });
      const f2 = insertFact(db, { factText: "effect" });
      const edgeId = insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "because" });

      expect(edgeId).toBeDefined();
      const row = db.prepare(`SELECT * FROM hippocampus_edges WHERE id = ?`).get(edgeId) as Record<string, unknown>;
      expect(row.from_fact_id).toBe(f1);
      expect(row.to_fact_id).toBe(f2);
      expect(row.edge_type).toBe("because");
      expect(row.confidence).toBe("medium");
    });
  });

  // ---------------------------------------------------------------------------
  // getFactWithEdges
  // ---------------------------------------------------------------------------

  describe("getFactWithEdges", () => {
    it("returns fact with its edges", () => {
      const f1 = insertFact(db, { factText: "central fact" });
      const f2 = insertFact(db, { factText: "related fact" });
      insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "related_to" });

      const result = getFactWithEdges(db, f1);
      expect(result).not.toBeNull();
      expect(result!.factText).toBe("central fact");
      expect(result!.edges).toHaveLength(1);
      expect(result!.edges[0].edgeType).toBe("related_to");
      expect(result!.edges[0].targetFactId).toBe(f2);
      expect(result!.edges[0].targetHint).toBe("related fact");
    });

    it("returns edges in both directions", () => {
      const f1 = insertFact(db, { factText: "node A" });
      const f2 = insertFact(db, { factText: "node B" });
      const f3 = insertFact(db, { factText: "node C" });
      insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "related_to" });
      insertEdge(db, { fromFactId: f3, toFactId: f1, edgeType: "informed_by" });

      const result = getFactWithEdges(db, f1);
      expect(result!.edges).toHaveLength(2);
    });

    it("returns null for non-existent fact", () => {
      const result = getFactWithEdges(db, "nonexistent");
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getTopFactsWithEdges
  // ---------------------------------------------------------------------------

  describe("getTopFactsWithEdges", () => {
    it("orders by hit_count DESC, edges limited to maxEdgesPerFact", () => {
      const f1 = insertFact(db, { factText: "popular" });
      const f2 = insertFact(db, { factText: "unpopular" });
      const f3 = insertFact(db, { factText: "edge target 1" });
      const f4 = insertFact(db, { factText: "edge target 2" });
      const f5 = insertFact(db, { factText: "edge target 3" });
      const f6 = insertFact(db, { factText: "edge target 4" });

      // Make f1 popular
      touchGraphFact(db, f1);
      touchGraphFact(db, f1);
      touchGraphFact(db, f1);

      // Add 4 edges to f1
      insertEdge(db, { fromFactId: f1, toFactId: f3, edgeType: "related_to" });
      insertEdge(db, { fromFactId: f1, toFactId: f4, edgeType: "related_to" });
      insertEdge(db, { fromFactId: f1, toFactId: f5, edgeType: "related_to" });
      insertEdge(db, { fromFactId: f1, toFactId: f6, edgeType: "related_to" });

      const results = getTopFactsWithEdges(db, 2, 3);
      expect(results[0].factText).toBe("popular");
      expect(results[0].hitCount).toBe(3);
      expect(results[0].edges.length).toBeLessThanOrEqual(3);
      expect(results).toHaveLength(2);
    });

    it("only returns active facts", () => {
      const f1 = insertFact(db, { factText: "active" });
      const f2 = insertFact(db, { factText: "evicted" });
      updateFactStatus(db, f2, "evicted");

      const results = getTopFactsWithEdges(db, 10);
      expect(results).toHaveLength(1);
      expect(results[0].factText).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // updateFactStatus
  // ---------------------------------------------------------------------------

  describe("updateFactStatus", () => {
    it("changes status to superseded", () => {
      const id = insertFact(db, { factText: "old info" });
      updateFactStatus(db, id, "superseded");

      const row = db.prepare(`SELECT status FROM hippocampus_facts WHERE id = ?`).get(id) as { status: string };
      expect(row.status).toBe("superseded");
    });

    it("changes status to evicted", () => {
      const id = insertFact(db, { factText: "evict me" });
      updateFactStatus(db, id, "evicted");

      const row = db.prepare(`SELECT status FROM hippocampus_facts WHERE id = ?`).get(id) as { status: string };
      expect(row.status).toBe("evicted");
    });
  });

  // ---------------------------------------------------------------------------
  // setEdgeStub
  // ---------------------------------------------------------------------------

  describe("setEdgeStub", () => {
    it("converts edge to stub with topic", () => {
      const f1 = insertFact(db, { factText: "kept fact" });
      const f2 = insertFact(db, { factText: "evicted fact" });
      const edgeId = insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "related_to" });

      setEdgeStub(db, edgeId, "user preferences");

      const result = getFactWithEdges(db, f1);
      expect(result!.edges[0].isStub).toBe(true);
      expect(result!.edges[0].targetHint).toBe("user preferences");
    });
  });

  // ---------------------------------------------------------------------------
  // touchGraphFact
  // ---------------------------------------------------------------------------

  describe("touchGraphFact", () => {
    it("increments hit_count and updates last_accessed_at", () => {
      const id = insertFact(db, { factText: "touchable" });

      const before = db.prepare(
        `SELECT hit_count, last_accessed_at FROM hippocampus_facts WHERE id = ?`,
      ).get(id) as { hit_count: number; last_accessed_at: string };
      expect(before.hit_count).toBe(0);

      touchGraphFact(db, id);

      const after = db.prepare(
        `SELECT hit_count, last_accessed_at FROM hippocampus_facts WHERE id = ?`,
      ).get(id) as { hit_count: number; last_accessed_at: string };
      expect(after.hit_count).toBe(1);
      expect(after.last_accessed_at >= before.last_accessed_at).toBe(true);
    });
  });
});
