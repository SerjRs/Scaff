/**
 * 020h — E2E Webchat Library Integration
 *
 * Category I — Library Integration
 *
 * I1: library_ingest tool triggers onSpawn callback with Librarian details
 * I2: Article ingestion writes to hippocampus graph (source node + facts + sourced_from edges)
 *
 * Uses programmatic Cortex API — no gateway, no WebSocket.
 * All LLMs are mocked. All tests are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { SpawnParams } from "../loop.js";
import { insertFact, insertEdge } from "../hippocampus.js";
import { storeLibraryTaskMeta } from "../../library/db.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020h-cortex-e2e/TEST-RESULTS.md",
);
const reporter = new TestReporter();

afterAll(() => {
  const dir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  reporter.writeReport(REPORT_PATH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-lib-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeWebchatEnvelope(content: string, senderId = "serj") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: senderId, name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

// ---------------------------------------------------------------------------
// I — Library Integration
// ---------------------------------------------------------------------------

describe("I — Library Integration", () => {
  it("I1: library_ingest tool triggers onSpawn callback with Librarian details", async () => {
    const t = { id: "I1", name: "library_ingest → onSpawn with Librarian prompt", category: "I — Library Integration" };
    const spawnCalls: SpawnParams[] = [];

    try {
      // Mock global fetch to return fake article content (no network)
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<html><body><h1>Test Article</h1><p>Some interesting content about TypeScript patterns.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({
          text: "I'll ingest that article for you.",
          toolCalls: [
            {
              id: "tc-lib-1",
              name: "library_ingest",
              arguments: {
                url: "https://example.com/typescript-patterns",
              },
            },
          ],
          _rawContent: [
            { type: "text", text: "I'll ingest that article for you." },
            {
              type: "tool_use",
              id: "tc-lib-1",
              name: "library_ingest",
              input: { url: "https://example.com/typescript-patterns" },
            },
          ],
        }),
        onSpawn: (params) => {
          spawnCalls.push(params);
          return "lib-job-001";
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("check out https://example.com/typescript-patterns"));
      await wait(1500);

      // onSpawn should have been called with a Librarian prompt
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].task).toContain("You are a Librarian");
      expect(spawnCalls[0].task).toContain("https://example.com/typescript-patterns");
      expect(spawnCalls[0].task).toContain("TypeScript patterns");
      expect(spawnCalls[0].resultPriority).toBe("normal");
      expect(spawnCalls[0].taskId).toBeDefined();
      expect(spawnCalls[0].envelopeId).toBeDefined();

      // fetch should have been called with the URL
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/typescript-patterns",
        expect.objectContaining({
          headers: expect.objectContaining({ "User-Agent": expect.any(String) }),
        }),
      );

      reporter.record({
        ...t,
        passed: true,
        expected: "onSpawn called with Librarian prompt containing URL and content",
        actual: `spawns=${spawnCalls.length}, taskContainsLibrarian=${spawnCalls[0].task.includes("Librarian")}, taskContainsUrl=${spawnCalls[0].task.includes("example.com")}, priority=${spawnCalls[0].resultPriority}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "onSpawn called with Librarian prompt", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("I2: Article ingestion writes to hippocampus graph (source + facts + edges)", async () => {
    const t = { id: "I2", name: "article → hippocampus graph ingestion", category: "I — Library Integration" };

    try {
      // Start Cortex with hippocampus enabled so graph tables are initialized
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      const db = instance.db;

      // Simulate the gateway-bridge graph ingestion pattern:
      // This mirrors the code in gateway-bridge.ts lines 388-446
      // which runs when a Librarian executor completes and returns parsed facts/edges.

      const parsedResult = {
        title: "TypeScript Discriminated Unions",
        facts: [
          { id: "f1", text: "Discriminated unions use a literal type property to narrow types", type: "fact", confidence: "high" },
          { id: "f2", text: "The discriminant property must be a literal type (string, number, or boolean)", type: "fact", confidence: "high" },
          { id: "f3", text: "Exhaustive checking via never ensures all cases are handled", type: "decision", confidence: "medium" },
        ],
        edges: [
          { from: "f1", to: "f2", type: "related_to" },
          { from: "f3", to: "f1", type: "informed_by" },
        ],
      };

      const itemId = 42; // Simulated Library item ID

      // 1. Create article source node
      const sourceFactId = insertFact(db, {
        factText: `Article: ${parsedResult.title}`,
        factType: "source",
        confidence: "high",
        sourceType: "article",
        sourceRef: `library://item/${itemId}`,
      });

      // 2. Insert facts and map local IDs to real UUIDs
      const idMap = new Map<string, string>();
      for (const f of parsedResult.facts) {
        const factId = insertFact(db, {
          factText: f.text,
          factType: f.type,
          confidence: f.confidence,
          sourceType: "article",
          sourceRef: `library://item/${itemId}`,
        });
        idMap.set(f.id, factId);

        // Link fact to article source (sourced_from edge)
        insertEdge(db, {
          fromFactId: factId,
          toFactId: sourceFactId,
          edgeType: "sourced_from",
        });
      }

      // 3. Insert edges between facts
      for (const e of parsedResult.edges) {
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

      // Verify: source node exists
      const sourceFact = db.prepare(
        "SELECT fact_text, fact_type, source_type, source_ref FROM hippocampus_facts WHERE id = ?",
      ).get(sourceFactId) as Record<string, unknown>;
      expect(sourceFact).toBeDefined();
      expect(sourceFact.fact_type).toBe("source");
      expect(sourceFact.source_type).toBe("article");
      expect(sourceFact.source_ref).toBe(`library://item/${itemId}`);
      expect(sourceFact.fact_text).toContain("TypeScript Discriminated Unions");

      // Verify: 3 facts were inserted
      const allFacts = db.prepare(
        "SELECT id, fact_text, fact_type, source_ref FROM hippocampus_facts WHERE source_ref = ? AND fact_type != 'source'",
      ).all(`library://item/${itemId}`) as Array<Record<string, unknown>>;
      expect(allFacts).toHaveLength(3);

      // Verify: sourced_from edges (one per fact → source)
      const sourcedFromEdges = db.prepare(
        "SELECT from_fact_id, to_fact_id, edge_type FROM hippocampus_edges WHERE edge_type = 'sourced_from' AND to_fact_id = ?",
      ).all(sourceFactId) as Array<Record<string, unknown>>;
      expect(sourcedFromEdges).toHaveLength(3);

      // Verify: inter-fact edges (related_to, informed_by)
      const interEdges = db.prepare(
        "SELECT edge_type FROM hippocampus_edges WHERE edge_type != 'sourced_from'",
      ).all() as Array<Record<string, unknown>>;
      expect(interEdges).toHaveLength(2);
      const edgeTypes = interEdges.map((e) => e.edge_type);
      expect(edgeTypes).toContain("related_to");
      expect(edgeTypes).toContain("informed_by");

      // Verify: total graph integrity (1 source + 3 facts = 4 nodes, 3 sourced_from + 2 inter = 5 edges)
      const totalFacts = db.prepare("SELECT COUNT(*) as cnt FROM hippocampus_facts").get() as { cnt: number };
      const totalEdges = db.prepare("SELECT COUNT(*) as cnt FROM hippocampus_edges").get() as { cnt: number };
      expect(totalFacts.cnt).toBe(4);
      expect(totalEdges.cnt).toBe(5);

      reporter.record({
        ...t,
        passed: true,
        expected: "4 facts (1 source + 3), 5 edges (3 sourced_from + 2 inter-fact)",
        actual: `facts=${totalFacts.cnt}, edges=${totalEdges.cnt}, sourcedFrom=${sourcedFromEdges.length}, interEdges=${interEdges.length}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "hippocampus graph with source + facts + edges", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
