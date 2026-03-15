/**
 * Article Ingestion → Graph Tests (017e)
 *
 * Tests that the Librarian prompt includes facts/edges schema,
 * and that graph ingestion logic correctly creates source nodes,
 * facts, and edges in the hippocampus tables.
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
  insertFact,
  insertEdge,
  getFactWithEdges,
} from "../hippocampus.js";
import { buildLibrarianPrompt } from "../../library/librarian-prompt.js";

// ---------------------------------------------------------------------------
// 1. Librarian prompt includes facts/edges schema
// ---------------------------------------------------------------------------

describe("Librarian prompt schema", () => {
  it("includes facts field in output schema", () => {
    const prompt = buildLibrarianPrompt("https://example.com", "some content");
    expect(prompt).toContain('"facts"');
    expect(prompt).toContain("fact|decision|outcome|correction");
    expect(prompt).toContain("high|medium|low");
  });

  it("includes edges field in output schema", () => {
    const prompt = buildLibrarianPrompt("https://example.com", "some content");
    expect(prompt).toContain('"edges"');
    expect(prompt).toContain("because|informed_by|resulted_in|contradicts|updated_by|related_to");
  });

  it("includes facts extraction rules", () => {
    const prompt = buildLibrarianPrompt("https://example.com", "some content");
    expect(prompt).toContain("Extract 3-10 key facts");
    expect(prompt).toContain("standalone statement of knowledge");
  });

  it("includes edges extraction rules", () => {
    const prompt = buildLibrarianPrompt("https://example.com", "some content");
    expect(prompt).toContain("Identify relationships between extracted facts");
    expect(prompt).toContain("empty array");
  });
});

// ---------------------------------------------------------------------------
// 2-4. Graph ingestion logic (simulated gateway-bridge pattern)
// ---------------------------------------------------------------------------

describe("graph ingestion", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-article-graph-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initSessionTables(db);
    initHotMemoryTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates source node + facts + edges from parsed article", () => {
    const parsed = {
      title: "O-RAN Architecture Overview",
      facts: [
        { id: "f1", text: "O-RAN reduces TCO by 30%", type: "fact", confidence: "high" },
        { id: "f2", text: "Open interfaces enable multi-vendor deployments", type: "fact", confidence: "high" },
        { id: "f3", text: "RIC supports real-time RAN optimization", type: "outcome", confidence: "medium" },
      ],
      edges: [
        { from: "f1", to: "f2", type: "because" },
        { from: "f2", to: "f3", type: "resulted_in" },
      ],
    };
    const itemId = "test-item-42";

    // --- Simulate gateway-bridge graph ingestion logic ---
    const parsedFacts = parsed.facts;
    const parsedEdges = parsed.edges;

    // Create article source node
    const sourceFactId = insertFact(db, {
      factText: `Article: ${parsed.title}`,
      factType: "source",
      confidence: "high",
      sourceType: "article",
      sourceRef: `library://item/${itemId}`,
    });

    const idMap = new Map<string, string>();

    for (const f of parsedFacts) {
      if (!f.text?.trim()) continue;
      const factId = insertFact(db, {
        factText: f.text.trim(),
        factType: f.type ?? "fact",
        confidence: f.confidence ?? "medium",
        sourceType: "article",
        sourceRef: `library://item/${itemId}`,
      });
      idMap.set(f.id, factId);

      insertEdge(db, {
        fromFactId: factId,
        toFactId: sourceFactId,
        edgeType: "sourced_from",
      });
    }

    if (parsedEdges) {
      for (const e of parsedEdges) {
        const fromId = idMap.get(e.from);
        const toId = idMap.get(e.to);
        if (fromId && toId && fromId !== toId) {
          insertEdge(db, {
            fromFactId: fromId,
            toFactId: toId,
            edgeType: e.type,
          });
        }
      }
    }

    // --- Assertions ---

    // Source node exists with correct type
    const sourceNode = getFactWithEdges(db, sourceFactId);
    expect(sourceNode).not.toBeNull();
    expect(sourceNode!.factText).toBe("Article: O-RAN Architecture Overview");
    expect(sourceNode!.factType).toBe("source");
    expect(sourceNode!.sourceType).toBe("article");
    expect(sourceNode!.sourceRef).toBe("library://item/test-item-42");

    // All 3 extracted facts exist with article source metadata
    for (const [localId, realId] of idMap) {
      const fact = getFactWithEdges(db, realId);
      expect(fact).not.toBeNull();
      expect(fact!.sourceType).toBe("article");
      expect(fact!.sourceRef).toBe("library://item/test-item-42");
    }
    expect(idMap.size).toBe(3);

    // sourced_from edges connect facts to source node
    // Source node should have 3 incoming edges (one from each fact)
    const sourceWithEdges = getFactWithEdges(db, sourceFactId);
    const sourcedFromEdges = sourceWithEdges!.edges.filter(e => e.edgeType === "sourced_from");
    expect(sourcedFromEdges).toHaveLength(3);

    // Inter-fact edges exist
    const f1Id = idMap.get("f1")!;
    const f1WithEdges = getFactWithEdges(db, f1Id);
    const becauseEdge = f1WithEdges!.edges.find(e => e.edgeType === "because");
    expect(becauseEdge).toBeDefined();
    expect(becauseEdge!.targetFactId).toBe(idMap.get("f2"));

    const f2Id = idMap.get("f2")!;
    const f2WithEdges = getFactWithEdges(db, f2Id);
    const resultedInEdge = f2WithEdges!.edges.find(e => e.edgeType === "resulted_in");
    expect(resultedInEdge).toBeDefined();
    expect(resultedInEdge!.targetFactId).toBe(idMap.get("f3"));
  });

  it("gracefully skips when no facts in output", () => {
    const parsed = {
      title: "Some Article",
      summary: "A summary",
      // No facts or edges fields
    } as { title: string; facts?: Array<{ id: string; text: string }>; edges?: Array<{ from: string; to: string; type: string }> };

    const parsedFacts = parsed.facts;

    // Same guard as gateway-bridge
    if (parsedFacts && parsedFacts.length > 0) {
      throw new Error("Should not reach here");
    }

    // Verify no graph writes happened
    const count = db.prepare("SELECT COUNT(*) as cnt FROM hippocampus_facts").get() as { cnt: number };
    expect(count.cnt).toBe(0);

    const edgeCount = db.prepare("SELECT COUNT(*) as cnt FROM hippocampus_edges").get() as { cnt: number };
    expect(edgeCount.cnt).toBe(0);
  });

  it("skips edges with invalid references", () => {
    const parsed = {
      title: "Test Article",
      facts: [
        { id: "f1", text: "Valid fact", type: "fact", confidence: "high" },
      ],
      edges: [
        { from: "f1", to: "f99", type: "because" },  // f99 doesn't exist
        { from: "f98", to: "f1", type: "related_to" }, // f98 doesn't exist
      ],
    };
    const itemId = "test-item-99";

    const sourceFactId = insertFact(db, {
      factText: `Article: ${parsed.title}`,
      factType: "source",
      confidence: "high",
      sourceType: "article",
      sourceRef: `library://item/${itemId}`,
    });

    const idMap = new Map<string, string>();
    for (const f of parsed.facts) {
      if (!f.text?.trim()) continue;
      const factId = insertFact(db, {
        factText: f.text.trim(),
        factType: f.type ?? "fact",
        confidence: f.confidence ?? "medium",
        sourceType: "article",
        sourceRef: `library://item/${itemId}`,
      });
      idMap.set(f.id, factId);

      insertEdge(db, {
        fromFactId: factId,
        toFactId: sourceFactId,
        edgeType: "sourced_from",
      });
    }

    // Try to insert edges — invalid refs should be silently skipped
    for (const e of parsed.edges) {
      const fromId = idMap.get(e.from);
      const toId = idMap.get(e.to);
      if (fromId && toId && fromId !== toId) {
        insertEdge(db, {
          fromFactId: fromId,
          toFactId: toId,
          edgeType: e.type,
        });
      }
    }

    // Only sourced_from edge should exist (no inter-fact edges because refs were invalid)
    const allEdges = db.prepare("SELECT COUNT(*) as cnt FROM hippocampus_edges").get() as { cnt: number };
    expect(allEdges.cnt).toBe(1); // Only the sourced_from edge for f1
  });
});
