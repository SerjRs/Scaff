/**
 * graph_traverse tool — traverseGraph() tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import {
  initHotMemoryTable,
  insertFact,
  insertEdge,
  setEdgeStub,
  updateFactStatus,
  traverseGraph,
} from "../hippocampus.js";

describe("traverseGraph", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-traverse-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initHotMemoryTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1-hop from a fact with edges returns immediate connections", () => {
    const f1 = insertFact(db, { factText: "Budget is 2.4M" });
    const f2 = insertFact(db, { factText: "O-RAN deployment North" });
    const f3 = insertFact(db, { factText: "hardware 1.8M" });
    insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "constrains" });
    insertEdge(db, { fromFactId: f1, toFactId: f3, edgeType: "part" });

    const result = traverseGraph(db, f1, 1);

    expect(result).toContain("Budget is 2.4M");
    expect(result).toContain("O-RAN deployment North");
    expect(result).toContain("hardware 1.8M");
    expect(result).toContain("constrains");
    expect(result).toContain("part");
    expect(result).toContain("3 nodes");
  });

  it("2-hop returns edges of edges", () => {
    const f1 = insertFact(db, { factText: "root" });
    const f2 = insertFact(db, { factText: "child" });
    const f3 = insertFact(db, { factText: "grandchild" });
    insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "has" });
    insertEdge(db, { fromFactId: f2, toFactId: f3, edgeType: "contains" });

    const result = traverseGraph(db, f1, 2);

    expect(result).toContain("root");
    expect(result).toContain("child");
    expect(result).toContain("grandchild");
    expect(result).toContain("3 nodes");
  });

  it("direction='outgoing' only follows outgoing edges", () => {
    const f1 = insertFact(db, { factText: "center" });
    const f2 = insertFact(db, { factText: "downstream" });
    const f3 = insertFact(db, { factText: "upstream" });
    insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "causes" });
    insertEdge(db, { fromFactId: f3, toFactId: f1, edgeType: "feeds" });

    const result = traverseGraph(db, f1, 2, "outgoing");

    expect(result).toContain("downstream");
    expect(result).not.toContain("upstream");
  });

  it("direction='incoming' only follows incoming edges", () => {
    const f1 = insertFact(db, { factText: "center" });
    const f2 = insertFact(db, { factText: "downstream" });
    const f3 = insertFact(db, { factText: "upstream" });
    insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "causes" });
    insertEdge(db, { fromFactId: f3, toFactId: f1, edgeType: "feeds" });

    const result = traverseGraph(db, f1, 2, "incoming");

    expect(result).toContain("upstream");
    expect(result).not.toContain("downstream");
  });

  it("depth capped at 4 (passing 10 returns max 4)", () => {
    // Build a chain: f0 -> f1 -> f2 -> f3 -> f4 -> f5
    const facts: string[] = [];
    for (let i = 0; i <= 5; i++) {
      facts.push(insertFact(db, { factText: `node-${i}` }));
    }
    for (let i = 0; i < 5; i++) {
      insertEdge(db, { fromFactId: facts[i], toFactId: facts[i + 1], edgeType: "next" });
    }

    const result = traverseGraph(db, facts[0], 10);

    // Should contain depth=4 in header (capped)
    expect(result).toContain("depth=4");
    // Should include nodes at depth 0-4 (f0 through f4) but NOT f5 (depth 5)
    expect(result).toContain("node-0");
    expect(result).toContain("node-4");
    expect(result).not.toContain("node-5");
  });

  it("node cap at 50 enforced", () => {
    // Create a star graph: center + 55 children
    const center = insertFact(db, { factText: "center-star" });
    for (let i = 0; i < 55; i++) {
      const child = insertFact(db, { factText: `child-${i}` });
      insertEdge(db, { fromFactId: center, toFactId: child, edgeType: "has" });
    }

    const result = traverseGraph(db, center, 1);

    // Should cap at 50 nodes
    expect(result).toContain("50 nodes");
  });

  it("unknown fact_id returns error string", () => {
    const result = traverseGraph(db, "nonexistent-id");

    expect(result).toBe('Error: fact "nonexistent-id" not found in knowledge graph.');
  });

  it("stub edges shown as [EVICTED: topic]", () => {
    const f1 = insertFact(db, { factText: "main fact" });
    const f2 = insertFact(db, { factText: "evicted fact" });
    const edgeId = insertEdge(db, { fromFactId: f1, toFactId: f2, edgeType: "deadline" });
    setEdgeStub(db, edgeId, "Q3 deadline");
    updateFactStatus(db, f2, "evicted");

    const result = traverseGraph(db, f1, 1);

    expect(result).toContain("[EVICTED: Q3 deadline]");
  });

  it("empty graph (fact with no edges) returns just the starting node", () => {
    const f1 = insertFact(db, { factText: "lonely fact" });

    const result = traverseGraph(db, f1);

    expect(result).toContain("lonely fact");
    expect(result).toContain("1 nodes");
  });
});
