/**
 * E2E: Multi-Channel Conversation (Task 17)
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-mc-"));
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

function makeEnvelope(channel: string, content: string) {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

describe("E2E: Multi-Channel Conversation", () => {
  it("webchat message → Cortex responds on webchat", async () => {
    const sent: OutputTarget[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "Hello from Cortex!", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async (t) => { sent.push(t); },
      isAvailable: () => true,
    });

    instance.enqueue(makeEnvelope("webchat", "hello"));
    await wait(400);

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("webchat");
    expect(sent[0].content).toBe("Hello from Cortex!");
  });

  it("WhatsApp message → Cortex responds on WhatsApp", async () => {
    const sent: OutputTarget[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "WA reply", toolCalls: [] }),
    });
    instance.registerAdapter({
      channelId: "whatsapp",
      toEnvelope: () => { throw new Error(""); },
      send: async (t) => { sent.push(t); },
      isAvailable: () => true,
    });

    instance.enqueue(makeEnvelope("whatsapp", "hey"));
    await wait(400);

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("whatsapp");
  });

  it("messages from webchat + WhatsApp land in same session", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    ["webchat", "whatsapp", "telegram"].forEach((ch) => {
      instance!.registerAdapter({
        channelId: ch,
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });
    });

    instance.enqueue(makeEnvelope("webchat", "from webchat"));
    instance.enqueue(makeEnvelope("whatsapp", "from whatsapp"));
    instance.enqueue(makeEnvelope("telegram", "from telegram"));
    await wait(800);

    const history = getSessionHistory(instance.db);
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(3);

    const channels = userMsgs.map((m) => m.channel);
    expect(channels).toContain("webchat");
    expect(channels).toContain("whatsapp");
    expect(channels).toContain("telegram");
  });

  it("three channels active → all in one session history", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 30,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });
    ["webchat", "whatsapp", "telegram"].forEach((ch) => {
      instance!.registerAdapter({
        channelId: ch,
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });
    });

    for (let i = 0; i < 5; i++) {
      instance.enqueue(makeEnvelope("webchat", `wc-${i}`));
      instance.enqueue(makeEnvelope("whatsapp", `wa-${i}`));
    }
    await wait(1500);

    const history = getSessionHistory(instance.db);
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(10);
  });
});
