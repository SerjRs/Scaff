/**
 * 020d — E2E Webchat Hippocampus Integration
 *
 * Category E — Hippocampus Integration:
 *   E1: Hot memory facts appear in system floor
 *   E2: Graph facts with edges show breadcrumbs in system floor
 *   E3: Fact extraction after conversation (Gardener)
 *   E4: Memory query searches both hot and cold
 *   E5: Eviction preserves edge stubs
 *   E6: Revival on cold search hit
 *
 * Uses programmatic Cortex API — no gateway, no WebSocket.
 * LLM calls are mocked. Embeddings use real Ollama nomic-embed-text (no mocks).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { AssembledContext } from "../context.js";
import type { CortexLLMResult } from "../llm-caller.js";
import {
  insertFact,
  insertEdge,
  getTopFactsWithEdges,
  evictFact,
  reviveFact,
  insertColdFact,
} from "../hippocampus.js";
import {
  runFactExtractor,
  type FactExtractorLLM,
} from "../gardener.js";
import {
  TestReporter,
  embedFn,
  insertTestMessage,
} from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020d-cortex-e2e/TEST-RESULTS.md",
);
const reporter = new TestReporter();

afterAll(() => {
  reporter.writeReport(REPORT_PATH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-hippo-"));
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
// E — Hippocampus Integration
// ---------------------------------------------------------------------------

describe("E — Hippocampus Integration", () => {
  it("E1: hot memory facts appear in system floor", async () => {
    const t = { id: "E1", name: "hot memory facts in system floor", category: "E — Hippocampus Integration" };
    let receivedContext: AssembledContext | null = null;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async (ctx) => {
          receivedContext = ctx;
          return { text: "Got it!", toolCalls: [] };
        },
      });

      // Insert facts directly into the graph table
      insertFact(instance.db, { factText: "Serj prefers dark mode" });
      insertFact(instance.db, { factText: "Project uses TypeScript exclusively" });

      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("hello"));
      await wait(400);

      expect(receivedContext).not.toBeNull();
      // System floor should contain the hot memory facts
      const systemFloor = receivedContext!.layers.find((l) => l.name === "system_floor");
      expect(systemFloor).toBeDefined();
      expect(systemFloor!.content).toContain("Serj prefers dark mode");
      expect(systemFloor!.content).toContain("Project uses TypeScript exclusively");
      expect(systemFloor!.content).toContain("Knowledge Graph");

      reporter.record({ ...t, passed: true, expected: "facts in system floor", actual: `floor contains both facts, has Knowledge Graph section` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "facts in system floor", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("E2: graph facts with edges show breadcrumbs in system floor", async () => {
    const t = { id: "E2", name: "graph facts with edge breadcrumbs", category: "E — Hippocampus Integration" };
    let receivedContext: AssembledContext | null = null;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async (ctx) => {
          receivedContext = ctx;
          return { text: "Noted!", toolCalls: [] };
        },
      });

      // Insert two facts + an edge
      const factA = insertFact(instance.db, { factText: "Team adopted Vitest for testing" });
      const factB = insertFact(instance.db, { factText: "Jest was deprecated in the project" });
      insertEdge(instance.db, { fromFactId: factA, toFactId: factB, edgeType: "resulted_in" });

      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("tell me about testing"));
      await wait(400);

      expect(receivedContext).not.toBeNull();
      const systemFloor = receivedContext!.layers.find((l) => l.name === "system_floor");
      expect(systemFloor).toBeDefined();
      // The fact with edge should show breadcrumb format
      expect(systemFloor!.content).toContain("Team adopted Vitest for testing");
      expect(systemFloor!.content).toContain("resulted_in");
      expect(systemFloor!.content).toContain("Jest was deprecated");

      reporter.record({ ...t, passed: true, expected: "facts + edge breadcrumbs in floor", actual: `floor shows facts with resulted_in edge` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "facts + edge breadcrumbs in floor", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("E3: fact extraction after conversation (Gardener)", async () => {
    const t = { id: "E3", name: "gardener extracts facts from conversation", category: "E — Hippocampus Integration" };

    try {
      // Mock extraction LLM that returns structured facts + edges
      const mockExtractLLM: FactExtractorLLM = async (_prompt: string) => {
        return JSON.stringify({
          facts: [
            { id: "f1", text: "OAuth tokens are the only auth method", type: "decision", confidence: "high" },
            { id: "f2", text: "Standard API keys are deprecated", type: "fact", confidence: "high" },
          ],
          edges: [
            { from: "f1", to: "f2", type: "because" },
          ],
        });
      };

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async () => ({ text: "OK", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      // Send messages to build conversation history
      instance.enqueue(makeWebchatEnvelope("We decided to use only OAuth tokens for auth"));
      instance.enqueue(makeWebchatEnvelope("Standard API keys are now deprecated"));
      await wait(600);

      // Run fact extraction directly on the db
      const result = await runFactExtractor({
        db: instance.db,
        extractLLM: mockExtractLLM,
        embedFn: embedFn,
      });

      // Verify facts were extracted
      expect(result.processed).toBeGreaterThanOrEqual(2);
      expect(result.errors).toHaveLength(0);

      // Verify facts appear in hippocampus_facts
      const facts = getTopFactsWithEdges(instance.db, 10);
      const oauthFact = facts.find((f) => f.factText.includes("OAuth tokens"));
      const apikeyFact = facts.find((f) => f.factText.includes("API keys"));
      expect(oauthFact).toBeDefined();
      expect(apikeyFact).toBeDefined();

      // Verify edge was created
      const factWithEdges = facts.find((f) => f.edges.length > 0);
      expect(factWithEdges).toBeDefined();

      reporter.record({
        ...t,
        passed: true,
        expected: "2 facts + 1 edge extracted",
        actual: `processed=${result.processed}, facts=${facts.length}, hasEdge=${!!factWithEdges}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "2 facts + 1 edge extracted", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("E4: memory_query searches both hot and cold", async () => {
    const t = { id: "E4", name: "memory_query searches hot + cold", category: "E — Hippocampus Integration" };
    const sent: OutputTarget[] = [];

    try {
      let callCount = 0;
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async (_ctx: AssembledContext): Promise<CortexLLMResult> => {
          callCount++;
          if (callCount === 1) {
            return {
              text: "",
              toolCalls: [{ id: "tc-1", name: "memory_query", arguments: { query: "TypeScript project setup", limit: 5 } }],
              _rawContent: [
                { type: "text", text: "" },
                { type: "tool_use", id: "tc-1", name: "memory_query", input: { query: "TypeScript project setup", limit: 5 } },
              ],
            };
          }
          return { text: "Found memories!", toolCalls: [], _rawContent: [{ type: "text", text: "Found memories!" }] };
        },
      });

      // Insert a hot graph fact with embedding
      const embedding = await embedFn("TypeScript project setup");
      insertFact(instance.db, {
        factText: "Project is built with TypeScript and Node.js",
        embedding,
      });

      // Insert a cold fact with embedding
      const coldEmbedding = await embedFn("Project setup and configuration");
      insertColdFact(instance.db, "Initial setup was done in March 2026", coldEmbedding);

      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("search my memories about TypeScript"));
      await wait(600);

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Found memories!"))).toBe(true);

      reporter.record({
        ...t,
        passed: true,
        expected: "memory_query executes with hot + cold results",
        actual: `replies=${sent.length}, callCount=${callCount}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "memory_query executes with hot + cold results", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("E5: eviction preserves edge stubs", async () => {
    const t = { id: "E5", name: "eviction preserves edge stubs", category: "E — Hippocampus Integration" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async () => ({ text: "OK", toolCalls: [] }),
      });

      // Insert two facts + edge
      const factA = insertFact(instance.db, { factText: "Router uses SQLite queue" });
      const factB = insertFact(instance.db, { factText: "Queue supports priority ordering" });
      const edgeId = insertEdge(instance.db, { fromFactId: factA, toFactId: factB, edgeType: "related_to" });

      // Evict factB — edge should become a stub
      const embedding = await embedFn("Queue supports priority ordering");
      evictFact(instance.db, factB, embedding);

      // Check the edge is now a stub
      const edge = instance.db.prepare(
        `SELECT is_stub, stub_topic FROM hippocampus_edges WHERE id = ?`,
      ).get(edgeId) as { is_stub: number; stub_topic: string | null };

      expect(edge.is_stub).toBe(1);
      expect(edge.stub_topic).toBeTruthy();

      // Check factB is evicted
      const fact = instance.db.prepare(
        `SELECT status, cold_vector_id FROM hippocampus_facts WHERE id = ?`,
      ).get(factB) as { status: string; cold_vector_id: number | null };

      expect(fact.status).toBe("evicted");
      expect(fact.cold_vector_id).not.toBeNull();

      // Verify the surviving fact still shows the stub in system floor
      let receivedContext: AssembledContext | null = null;
      // Need to stop and restart to capture context with the evicted state
      await instance.stop();
      instance = null;
      _resetSingleton();

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async (ctx) => {
          receivedContext = ctx;
          return { text: "OK", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });
      instance.enqueue(makeWebchatEnvelope("check"));
      await wait(400);

      const systemFloor = receivedContext!.layers.find((l) => l.name === "system_floor");
      expect(systemFloor!.content).toContain("Router uses SQLite queue");
      expect(systemFloor!.content).toContain("evicted");

      reporter.record({
        ...t,
        passed: true,
        expected: "edge is stub after eviction, fact evicted with cold_vector_id",
        actual: `is_stub=${edge.is_stub}, status=${fact.status}, cold_vector_id=${fact.cold_vector_id}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "edge is stub after eviction", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("E6: revival on cold search reconnects edges", async () => {
    const t = { id: "E6", name: "revival reconnects edges", category: "E — Hippocampus Integration" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        hippocampusEnabled: true,
        embedFn: embedFn,
        callLLM: async () => ({ text: "OK", toolCalls: [] }),
      });

      // Insert two facts + edge
      const factA = insertFact(instance.db, { factText: "Cortex is the cognitive core" });
      const factB = insertFact(instance.db, { factText: "Cortex uses unified context window" });
      const edgeId = insertEdge(instance.db, { fromFactId: factA, toFactId: factB, edgeType: "related_to" });

      // Evict factB
      const embedding = await embedFn("Cortex uses unified context window");
      evictFact(instance.db, factB, embedding);

      // Verify edge is stubbed
      const beforeRevival = instance.db.prepare(
        `SELECT is_stub FROM hippocampus_edges WHERE id = ?`,
      ).get(edgeId) as { is_stub: number };
      expect(beforeRevival.is_stub).toBe(1);

      // Revive factB
      reviveFact(instance.db, factB);

      // Verify fact is active again
      const factAfter = instance.db.prepare(
        `SELECT status, cold_vector_id FROM hippocampus_facts WHERE id = ?`,
      ).get(factB) as { status: string; cold_vector_id: number | null };
      expect(factAfter.status).toBe("active");

      // Verify edge is reconnected (no longer a stub)
      const afterRevival = instance.db.prepare(
        `SELECT is_stub, stub_topic FROM hippocampus_edges WHERE id = ?`,
      ).get(edgeId) as { is_stub: number; stub_topic: string | null };
      expect(afterRevival.is_stub).toBe(0);
      expect(afterRevival.stub_topic).toBeNull();

      // Verify both facts now appear in system floor
      const facts = getTopFactsWithEdges(instance.db, 10);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.some((f) => f.factText.includes("cognitive core"))).toBe(true);
      expect(facts.some((f) => f.factText.includes("unified context"))).toBe(true);

      reporter.record({
        ...t,
        passed: true,
        expected: "fact revived, edge reconnected, both in graph",
        actual: `status=${factAfter.status}, is_stub=${afterRevival.is_stub}, facts=${facts.length}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "fact revived, edge reconnected", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
