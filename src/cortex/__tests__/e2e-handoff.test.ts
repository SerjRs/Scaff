/**
 * E2E: Channel Handoff (Task 18)
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-ho-"));
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

describe("E2E: Channel Handoff", () => {
  it("webchat → WhatsApp mid-conversation: full context retained", async () => {
    const sent: OutputTarget[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 30,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    ["webchat", "whatsapp"].forEach((ch) => {
      instance!.registerAdapter({
        channelId: ch,
        toEnvelope: () => { throw new Error(""); },
        send: async (t) => { sent.push(t); },
        isAvailable: () => true,
      });
    });

    // 3 messages on webchat
    for (let i = 0; i < 3; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: `webchat msg ${i}`,
      }));
    }
    await wait(500);

    // Switch to WhatsApp
    instance.enqueue(createEnvelope({
      channel: "whatsapp",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "continuing on whatsapp",
    }));
    await wait(300);

    // All messages in same session
    const history = getSessionHistory(instance.db);
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(4);
    expect(userMsgs[3].channel).toBe("whatsapp");
    expect(userMsgs[3].content).toBe("continuing on whatsapp");
  });

  it("rapid channel switching: no context loss", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 20,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    ["webchat", "whatsapp"].forEach((ch) => {
      instance!.registerAdapter({
        channelId: ch,
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });
    });

    // Rapid switching: web → wa → web → wa → web
    const channels = ["webchat", "whatsapp", "webchat", "whatsapp", "webchat"];
    channels.forEach((ch, i) => {
      instance!.enqueue(createEnvelope({
        channel: ch,
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: `msg ${i} on ${ch}`,
      }));
    });

    await wait(1000);

    const history = getSessionHistory(instance.db);
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(5);
    // All messages present, no drops
    for (let i = 0; i < 5; i++) {
      expect(userMsgs[i].content).toBe(`msg ${i} on ${channels[i]}`);
    }
  });

  it("reply goes to the channel the message came from", async () => {
    const sent: OutputTarget[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 30,
      callLLM: async () => ({ text: "reply here", toolCalls: [] }),
    });

    ["webchat", "whatsapp"].forEach((ch) => {
      instance!.registerAdapter({
        channelId: ch,
        toEnvelope: () => { throw new Error(""); },
        send: async (t) => { sent.push(t); },
        isAvailable: () => true,
      });
    });

    // First message on webchat
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "on webchat",
    }));
    await wait(300);

    // Second message on whatsapp
    instance.enqueue(createEnvelope({
      channel: "whatsapp",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "on whatsapp",
    }));
    await wait(300);

    expect(sent).toHaveLength(2);
    expect(sent[0].channel).toBe("webchat");
    expect(sent[1].channel).toBe("whatsapp");
  });
});
