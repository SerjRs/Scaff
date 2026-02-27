/**
 * E2E: Sub-agent & Router Awareness (Task 19)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope } from "../types.js";
import { getSessionHistory, addPendingOp, getPendingOps } from "../session.js";

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-sa-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) { await instance.stop(); instance = null; }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("E2E: Sub-agent & Router Awareness", () => {
  it("Router job result arrives in Cortex session", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "router",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Simulate Router result arriving
    instance.enqueue(createEnvelope({
      channel: "router",
      sender: { id: "router:job-42", name: "Router", relationship: "internal" },
      content: "Berlin is the capital of Germany",
      metadata: { jobId: "job-42", tier: "haiku" },
    }));
    await wait(300);

    const history = getSessionHistory(instance.db);
    const routerMsg = history.find((m) => m.channel === "router");
    expect(routerMsg).toBeDefined();
    expect(routerMsg!.content).toBe("Berlin is the capital of Germany");
  });

  it("sub-agent completion arrives in Cortex session", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "subagent",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    instance.enqueue(createEnvelope({
      channel: "subagent",
      sender: { id: "subagent:weather-check", name: "Subagent", relationship: "internal" },
      content: "Weather: 22°C, sunny in Bucharest",
      metadata: { label: "weather-check", status: "completed" },
    }));
    await wait(300);

    const history = getSessionHistory(instance.db);
    expect(history.some((m) => m.content.includes("22°C"))).toBe(true);
  });

  it("pending operations tracked across messages", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    // Add pending ops
    addPendingOp(instance.db, {
      id: "job-1",
      type: "router_job",
      description: "Analyze code",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
    });
    addPendingOp(instance.db, {
      id: "sa-1",
      type: "subagent",
      description: "Check weather",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "subagent",
    });

    const ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.id)).toContain("job-1");
    expect(ops.map((o) => o.id)).toContain("sa-1");
  });

  it("sub-agent failure arrives as envelope and is handled", async () => {
    const errors: Error[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
      onError: (err) => { errors.push(err); },
    });
    instance.registerAdapter({
      channelId: "subagent",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    instance.enqueue(createEnvelope({
      channel: "subagent",
      sender: { id: "subagent:failed-task", name: "Subagent", relationship: "internal" },
      content: "Task failed: timeout after 30s",
      metadata: { label: "failed-task", status: "failed", error: "timeout" },
    }));
    await wait(300);

    // Error message in session, no crash
    const history = getSessionHistory(instance.db);
    expect(history.some((m) => m.content.includes("timeout"))).toBe(true);
    expect(instance.isRunning() || instance.stats().processedCount > 0).toBe(true);
  });
});
