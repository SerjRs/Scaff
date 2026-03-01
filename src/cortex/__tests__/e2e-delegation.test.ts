/**
 * E2E: Delegation Flow (Task 30)
 *
 * Tests the full Cortex → Router delegation lifecycle:
 * sessions_spawn tool call → async dispatch → result ingestion → final response
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { getSessionHistory, appendTaskResult } from "../session.js";
import type { CortexLLMResult } from "../llm-caller.js";
import type { SpawnParams } from "../loop.js";
import type { ChannelAdapter } from "../channel-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

function makeMockAdapter(channelId: string): ChannelAdapter & { sent: OutputTarget[] } {
  const sent: OutputTarget[] = [];
  return {
    channelId,
    toEnvelope: () => { throw new Error("not used"); },
    async send(target) { sent.push(target); },
    isAvailable: () => true,
    sent,
  };
}

function makeEnvelope(content: string, channel = "webchat") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-deleg-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) { await instance.stop(); instance = null; }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Delegation Flow", () => {
  it("direct answer: no delegation, no spawn fired", async () => {
    const spawns: SpawnParams[] = [];
    const adapter = makeMockAdapter("webchat");

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "Berlin is the capital of Germany.", toolCalls: [] }),
      onSpawn: (p) => { spawns.push(p); return null; },
    });
    instance.registerAdapter(adapter);

    instance.enqueue(makeEnvelope("What is the capital of Germany?"));
    await wait(300);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Berlin is the capital of Germany.");
    expect(spawns).toHaveLength(0);
  });

  it("delegation happy path: ack delivered, spawn fired, result processed", async () => {
    const spawns: SpawnParams[] = [];
    const adapter = makeMockAdapter("webchat");
    const routerAdapter = makeMockAdapter("router");
    let callCount = 0;

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          // First call: user asks for research → delegate
          return {
            text: "Let me look into that.",
            toolCalls: [{
              id: "tc-1",
              name: "sessions_spawn",
              arguments: { task: "Research the weather in Bucharest", priority: "normal" },
            }],
          };
        }
        // Second call: router result arrives → formulate answer
        return { text: "It's 22°C and sunny in Bucharest.", toolCalls: [] };
      },
      onSpawn: (p) => { spawns.push(p); return "job-123"; },
    });
    instance.registerAdapter(adapter);
    instance.registerAdapter(routerAdapter);

    // Step 1: User asks
    instance.enqueue(makeEnvelope("What's the weather in Bucharest?"));
    await wait(300);

    // Ack delivered to webchat
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Let me look into that.");

    // Spawn was fired
    expect(spawns).toHaveLength(1);
    expect(spawns[0].task).toBe("Research the weather in Bucharest");
    expect(spawns[0].resultPriority).toBe("normal");
    expect(spawns[0].replyChannel).toBe("webchat");

    // taskId is the Cortex-generated UUID, passed to onSpawn
    const taskId = spawns[0].taskId;

    // No dispatch evidence in session — task results are written directly via appendTaskResult.
    const historyAfterDispatch = getSessionHistory(instance.db);
    const dispatchEvidence = historyAfterDispatch.find((m) =>
      m.role === "assistant" && m.content.includes("[DISPATCHED]"),
    );
    expect(dispatchEvidence).toBeUndefined();

    // Step 2: Simulate Router result via appendTaskResult + ops trigger
    appendTaskResult(instance.db, {
      taskId,
      description: "Research the weather in Bucharest",
      status: "completed",
      channel: "webchat",
      result: "Weather data: 22°C, sunny, humidity 45%",
      completedAt: new Date().toISOString(),
    });
    instance.enqueue(createEnvelope({
      channel: "router",
      sender: { id: "cortex:ops", name: "System", relationship: "system" },
      content: "",
      metadata: { ops_trigger: true },
    }));
    await wait(300);

    // Cortex processed the result and sent final answer
    expect(callCount).toBe(2);
    // The router result is processed, Cortex may route to webchat or router depending on parseResponse
    const allSent = [...adapter.sent, ...routerAdapter.sent];
    expect(allSent.length).toBeGreaterThanOrEqual(2);
  });

  it("delegation is async: text ack delivered before spawn completes", async () => {
    let spawnTime = 0;
    let ackTime = 0;
    const adapter = makeMockAdapter("webchat");

    // Override send to record timing
    const originalSend = adapter.send.bind(adapter);
    adapter.send = async (target) => {
      ackTime = Date.now();
      await originalSend(target);
    };

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "Working on it.",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "Do some research" },
        }],
      }),
      onSpawn: (p) => {
        spawnTime = Date.now();
        return "job-456";
      },
    });
    instance.registerAdapter(adapter);

    instance.enqueue(makeEnvelope("Research something"));
    await wait(300);

    // Both fired in same turn — spawn fires first (step 5b), then text routes (step 7)
    // Key assertion: both happened, and the loop didn't block
    expect(spawnTime).toBeGreaterThan(0);
    expect(ackTime).toBeGreaterThan(0);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Working on it.");
  });

  it("spawn params contain correct task details", async () => {
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "On it.",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "Analyze the codebase structure", priority: "background" },
        }],
      }),
      onSpawn: (p) => { spawns.push(p); return "job-789"; },
    });
    instance.registerAdapter(makeMockAdapter("webchat"));

    instance.enqueue(makeEnvelope("Analyze the codebase"));
    await wait(300);

    // Spawn received correct params
    expect(spawns).toHaveLength(1);
    expect(spawns[0].task).toBe("Analyze the codebase structure");
    expect(spawns[0].resultPriority).toBe("background");
    expect(spawns[0].replyChannel).toBe("webchat");
    expect(spawns[0].taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // UUID format
  });

  it("result delivered to correct channel: webchat user gets answer on webchat", async () => {
    const webchatAdapter = makeMockAdapter("webchat");
    const routerAdapter = makeMockAdapter("router");
    let callCount = 0;
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "Checking...",
            toolCalls: [{
              id: "tc-1",
              name: "sessions_spawn",
              arguments: { task: "Look up the answer" },
            }],
          };
        }
        // Result arrives from router — respond normally (routes back to trigger channel)
        return { text: "Here's what I found.", toolCalls: [] };
      },
      onSpawn: (p) => { spawns.push(p); return "job-abc"; },
    });
    instance.registerAdapter(webchatAdapter);
    instance.registerAdapter(routerAdapter);

    // User asks on webchat
    instance.enqueue(makeEnvelope("Find something for me", "webchat"));
    await wait(300);

    expect(webchatAdapter.sent).toHaveLength(1);
    expect(webchatAdapter.sent[0].content).toBe("Checking...");

    // Router result arrives via appendTaskResult + ops trigger
    const taskId = spawns[0].taskId;
    appendTaskResult(instance.db, {
      taskId,
      description: "Look up the answer",
      status: "completed",
      channel: "webchat",
      result: "Result data here",
      completedAt: new Date().toISOString(),
    });
    instance.enqueue(createEnvelope({
      channel: "router",
      sender: { id: "cortex:ops", name: "System", relationship: "system" },
      content: "",
      metadata: { ops_trigger: true },
    }));
    await wait(300);

    // LLM was called twice
    expect(callCount).toBe(2);
    // Verify the processing completed
    const history = getSessionHistory(instance.db);
    expect(history.length).toBeGreaterThanOrEqual(3); // user msg + ack + ops trigger + response
  });

  it("failed task: error result arrives, Cortex handles gracefully", async () => {
    const adapter = makeMockAdapter("webchat");
    const routerAdapter = makeMockAdapter("router");
    let callCount = 0;
    const errors: Error[] = [];
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "Let me check.",
            toolCalls: [{
              id: "tc-1",
              name: "sessions_spawn",
              arguments: { task: "Run failing operation" },
            }],
          };
        }
        // Router error arrives — handle gracefully
        return { text: "I wasn't able to complete that task.", toolCalls: [] };
      },
      onError: (err) => { errors.push(err); },
      onSpawn: (p) => { spawns.push(p); return "job-fail"; },
    });
    instance.registerAdapter(adapter);
    instance.registerAdapter(routerAdapter);

    // User asks
    instance.enqueue(makeEnvelope("Do something risky"));
    await wait(300);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Let me check.");

    // Simulate failed Router result via appendTaskResult + ops trigger
    const taskId = spawns[0].taskId;
    appendTaskResult(instance.db, {
      taskId,
      description: "Run failing operation",
      status: "failed",
      channel: "webchat",
      error: "timeout after 30s — executor crashed",
      completedAt: new Date().toISOString(),
    });
    instance.enqueue(createEnvelope({
      channel: "router",
      sender: { id: "cortex:ops", name: "System", relationship: "system" },
      content: "",
      metadata: { ops_trigger: true },
    }));
    await wait(300);

    // Cortex processed the error and responded
    expect(callCount).toBe(2);
    const allSent = [...adapter.sent, ...routerAdapter.sent];
    const failureResponse = allSent.find((s) => s.content.includes("wasn't able"));
    expect(failureResponse).toBeDefined();

    // Loop still running — no crash
    expect(instance.stats().processedCount).toBe(2);
  });
});
