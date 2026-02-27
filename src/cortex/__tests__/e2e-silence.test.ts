/**
 * E2E: Silence & No-Output (Task 22)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { getSessionHistory } from "../session.js";

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-sil-"));
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

describe("E2E: Silence & No-Output", () => {
  it("HEARTBEAT_OK → no output sent to any channel", async () => {
    const sent: OutputTarget[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "HEARTBEAT_OK", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "cron",
      toEnvelope: () => { throw new Error(""); },
      send: async (t) => { sent.push(t); },
      isAvailable: () => true,
    });

    instance.enqueue(createEnvelope({
      channel: "cron",
      sender: { id: "heartbeat", name: "System", relationship: "system" },
      content: "heartbeat tick",
      priority: "background",
    }));
    await wait(400);

    // No messages sent
    expect(sent).toHaveLength(0);
    // But message was processed
    expect(instance.stats().processedCount).toBe(1);
  });

  it("NO_REPLY → no adapter.send called, message still completed", async () => {
    const sent: OutputTarget[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async (t) => { sent.push(t); },
      isAvailable: () => true,
    });

    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "group banter",
    }));
    await wait(400);

    expect(sent).toHaveLength(0);
    expect(instance.stats().processedCount).toBe(1);
    expect(instance.stats().pendingCount).toBe(0);
  });

  it("silence recorded as [silence] in session history", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });

    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "test silence",
    }));
    await wait(400);

    const history = getSessionHistory(instance.db);
    const silenceMsg = history.find((m) => m.content === "[silence]");
    expect(silenceMsg).toBeDefined();
    expect(silenceMsg!.role).toBe("assistant");
  });

  it("mix of silence and response: only real responses sent", async () => {
    const sent: OutputTarget[] = [];
    let callCount = 0;

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 30,
      callLLM: async () => {
        callCount++;
        // Alternate: silence, response, silence, response
        return { text: callCount % 2 === 0 ? "real response" : "NO_REPLY", toolCalls: [] };
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async (t) => { sent.push(t); },
      isAvailable: () => true,
    });

    for (let i = 0; i < 4; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: `msg-${i}`,
      }));
    }
    await wait(1000);

    // 2 silent, 2 responded
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.content === "real response")).toBe(true);
    expect(instance.stats().processedCount).toBe(4);
  });
});
