/**
 * E2E: Priority & Serialization (Task 21)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-pri-"));
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

describe("E2E: Priority & Serialization", () => {
  it("urgent processed before normal before background", async () => {
    const processOrder: string[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 20,
      callLLM: async (ctx) => {
        // Find the trigger message content from the foreground layer
        const fg = ctx.layers.find((l) => l.name === "foreground");
        if (fg?.content) {
          const match = fg.content.match(/(urgent|normal|background)-msg/);
          if (match) processOrder.push(match[0]);
        }
        return "NO_REPLY";
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Enqueue in reverse priority order
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "system", name: "System", relationship: "system" },
      content: "background-msg",
      priority: "background",
    }));
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "normal-msg",
      priority: "normal",
    }));
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "urgent-msg",
      priority: "urgent",
    }));

    await wait(1000);

    expect(processOrder[0]).toBe("urgent-msg");
    expect(processOrder[1]).toBe("normal-msg");
    expect(processOrder[2]).toBe("background-msg");
  });

  it("FIFO within same priority tier", async () => {
    const processOrder: string[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 20,
      callLLM: async (ctx) => {
        // Find the LAST (most recent) urgent-N in the foreground — that's the trigger
        const fg = ctx.layers.find((l) => l.name === "foreground");
        if (fg?.content) {
          const matches = [...fg.content.matchAll(/urgent-(\d)/g)];
          if (matches.length > 0) {
            processOrder.push(matches[matches.length - 1][0]);
          }
        }
        return "NO_REPLY";
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    for (let i = 0; i < 5; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: `urgent-${i}`,
        priority: "urgent",
      }));
    }

    await wait(1000);

    // Should be in order 0,1,2,3,4
    expect(processOrder).toEqual(["urgent-0", "urgent-1", "urgent-2", "urgent-3", "urgent-4"]);
  });

  it("strict serial processing: no parallel execution", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 10,
      callLLM: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await wait(50); // Simulate processing time
        concurrent--;
        return "NO_REPLY";
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    for (let i = 0; i < 5; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: `msg-${i}`,
      }));
    }

    await wait(1500);

    // Max concurrent should be 1 (strict serialization)
    expect(maxConcurrent).toBe(1);
    expect(instance.stats().processedCount).toBe(5);
  });
});
