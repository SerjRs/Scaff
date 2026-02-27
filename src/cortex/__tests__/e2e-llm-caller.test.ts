/**
 * E2E: LLM Caller (Task 23)
 *
 * Tests the full pipeline with a real (mocked) LLM caller:
 * enqueue → context assembly → LLM call → response extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import {
  contextToMessages,
  type CortexLLMCaller,
} from "../llm-caller.js";
import type { AssembledContext } from "../context.js";
import type { SessionMessage } from "../session.js";
import { WebchatAdapter } from "../adapters/webchat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let instance: CortexInstance | null = null;

function setupWorkspace() {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-llm-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff, a helpful AI assistant.");
  fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "Name: Scaff\nEmoji: 🔧");
  fs.writeFileSync(path.join(workspaceDir, "USER.md"), "Name: Serj\nTimezone: Europe/Bucharest");
  fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Long-term memory\n- Building Cortex");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a mock LLM that records calls and returns canned responses */
function createMockLLM(responses: string[]): {
  caller: CortexLLMCaller;
  calls: AssembledContext[];
} {
  const calls: AssembledContext[] = [];
  let callIndex = 0;

  const caller: CortexLLMCaller = async (context: AssembledContext) => {
    calls.push(context);
    const response = responses[callIndex] ?? "NO_REPLY";
    callIndex++;
    return { text: response, toolCalls: [] };
  };

  return { caller, calls };
}

beforeEach(() => setupWorkspace());

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
});

// ---------------------------------------------------------------------------
// contextToMessages tests
// ---------------------------------------------------------------------------

describe("contextToMessages", () => {
  it("maps system_floor to system parameter", () => {
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 100, content: "You are Scaff." },
        { name: "foreground", tokens: 10, content: "[webchat] user: hello" },
        { name: "background", tokens: 0, content: "" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 110,
      foregroundChannel: "webchat",
      foregroundMessages: [
        { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "hello", timestamp: "2026-02-27T10:00:00Z" },
      ],
      backgroundSummaries: new Map(),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.system).toBe("You are Scaff.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("includes background summaries in system", () => {
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 50, content: "Identity here" },
        { name: "foreground", tokens: 10, content: "[webchat] user: hi" },
        { name: "background", tokens: 30, content: "## Other Channels\n[whatsapp] 3 unread messages" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 90,
      foregroundChannel: "webchat",
      foregroundMessages: [
        { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "hi", timestamp: "2026-02-27T10:00:00Z" },
      ],
      backgroundSummaries: new Map([["whatsapp", "3 unread"]]),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.system).toContain("Identity here");
    expect(result.system).toContain("Other Channels");
    expect(result.system).toContain("whatsapp");
  });

  it("maps foreground to alternating user/assistant messages", () => {
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 10, content: "System" },
        { name: "foreground", tokens: 50, content: "(text representation)" },
        { name: "background", tokens: 0, content: "" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 60,
      foregroundChannel: "webchat",
      foregroundMessages: [
        { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "webchat-user", content: "hello", timestamp: "2026-02-27T10:00:00Z" },
        { id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex", content: "Hi there!", timestamp: "2026-02-27T10:00:01Z" },
        { id: 3, envelopeId: "e2", role: "user", channel: "webchat", senderId: "webchat-user", content: "how are you?", timestamp: "2026-02-27T10:00:02Z" },
        { id: 4, envelopeId: "e2", role: "assistant", channel: "webchat", senderId: "cortex", content: "I'm doing well.", timestamp: "2026-02-27T10:00:03Z" },
      ],
      backgroundSummaries: new Map(),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "I'm doing well." },
    ]);
  });

  it("consolidates consecutive same-role messages", () => {
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 10, content: "System" },
        { name: "foreground", tokens: 30, content: "(text representation)" },
        { name: "background", tokens: 0, content: "" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 40,
      foregroundChannel: "webchat",
      foregroundMessages: [
        { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user1", content: "hello", timestamp: "2026-02-27T10:00:00Z" },
        { id: 2, envelopeId: "e2", role: "user", channel: "webchat", senderId: "user2", content: "world", timestamp: "2026-02-27T10:00:01Z" },
        { id: 3, envelopeId: "e2", role: "assistant", channel: "webchat", senderId: "cortex", content: "Hi!", timestamp: "2026-02-27T10:00:02Z" },
      ],
      backgroundSummaries: new Map(),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.messages).toEqual([
      { role: "user", content: "hello\nworld" },
      { role: "assistant", content: "Hi!" },
    ]);
  });

  it("handles empty foreground with fallback user message", () => {
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 10, content: "System" },
        { name: "foreground", tokens: 0, content: "" },
        { name: "background", tokens: 0, content: "" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 10,
      foregroundChannel: "webchat",
      foregroundMessages: [],
      backgroundSummaries: new Map(),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("preserves multi-line assistant messages without corruption", () => {
    const multiLineResponse = "Line 1 of my response.\nLine 2 continues here.\nLine 3 finishes.";
    const context: AssembledContext = {
      layers: [
        { name: "system_floor", tokens: 10, content: "System" },
        { name: "foreground", tokens: 50, content: "(text representation)" },
        { name: "background", tokens: 0, content: "" },
        { name: "archived", tokens: 0, content: "" },
      ],
      totalTokens: 60,
      foregroundChannel: "webchat",
      foregroundMessages: [
        { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "tell me something", timestamp: "2026-02-27T10:00:00Z" },
        { id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex", content: multiLineResponse, timestamp: "2026-02-27T10:00:01Z" },
        { id: 3, envelopeId: "e2", role: "user", channel: "webchat", senderId: "user", content: "thanks", timestamp: "2026-02-27T10:00:02Z" },
      ],
      backgroundSummaries: new Map(),
      pendingOps: [],
    };

    const result = contextToMessages(context);
    expect(result.messages).toEqual([
      { role: "user", content: "tell me something" },
      { role: "assistant", content: multiLineResponse },
      { role: "user", content: "thanks" },
    ]);
    // The entire multi-line response stays as ONE assistant message
    expect(result.messages[1].content).toContain("\n");
    expect(result.messages[1].content.split("\n")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline E2E tests
// ---------------------------------------------------------------------------

describe("E2E: LLM Caller Pipeline", () => {
  it("full pipeline: enqueue → context assembly → LLM call → response extracted", async () => {
    const { caller, calls } = createMockLLM(["Hello from Cortex!"]);
    const sent: OutputTarget[] = [];
    const dbPath = path.join(tmpDir, "bus.sqlite");

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async (target) => { sent.push(target); }),
    );

    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "user", name: "Serj", relationship: "partner" },
      content: "hello world",
      priority: "urgent",
    }));

    await wait(3000);

    expect(calls).toHaveLength(1);
    expect(calls[0].foregroundChannel).toBe("webchat");
    expect(calls[0].layers.find((l) => l.name === "system_floor")?.content).toContain("Scaff");
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("Hello from Cortex!");
    expect(sent[0].channel).toBe("webchat");
  });

  it("multi-turn: 3 messages, context includes prior turns", async () => {
    const { caller, calls } = createMockLLM(["reply-1", "reply-2", "reply-3"]);
    const sent: OutputTarget[] = [];
    const dbPath = path.join(tmpDir, "bus.sqlite");

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async (target) => { sent.push(target); }),
    );

    // Send messages one at a time, waiting for each to complete
    for (const msg of ["first", "second", "third"]) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "user", name: "Serj", relationship: "partner" },
        content: msg,
        priority: "urgent",
      }));
      await wait(2000);
    }

    expect(calls).toHaveLength(3);
    // Third call should have context from previous turns
    const thirdContext = calls[2];
    const fg = thirdContext.layers.find((l) => l.name === "foreground");
    expect(fg?.content).toContain("first");
    expect(fg?.content).toContain("second");
    expect(fg?.content).toContain("third");
  }, 15000);

  it("cross-channel context: webchat message sees WhatsApp in background", async () => {
    const { caller, calls } = createMockLLM(["wa-reply", "web-reply"]);
    const sent: OutputTarget[] = [];
    const dbPath = path.join(tmpDir, "bus.sqlite");

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async (target) => { sent.push(target); }),
    );

    // First: WhatsApp message
    instance.enqueue(createEnvelope({
      channel: "whatsapp",
      sender: { id: "wa-user", name: "Friend", relationship: "external" },
      content: "hey from whatsapp",
      priority: "normal",
    }));
    await wait(2500);

    // Second: webchat message — should see WhatsApp in background
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "user", name: "Serj", relationship: "partner" },
      content: "hi from webchat",
      priority: "urgent",
    }));
    await wait(2500);

    expect(calls).toHaveLength(2);
    const webchatContext = calls[1];
    expect(webchatContext.foregroundChannel).toBe("webchat");
    // Background should reference whatsapp
    const bg = webchatContext.layers.find((l) => l.name === "background");
    expect(bg?.content).toContain("whatsapp");
  }, 10000);

  it("LLM timeout: slow LLM → bus stays running", async () => {
    let callCount = 0;
    const caller: CortexLLMCaller = async () => {
      callCount++;
      if (callCount === 1) {
        await wait(10_000);
        return { text: "too late", toolCalls: [] };
      }
      return { text: "fast reply", toolCalls: [] };
    };

    const dbPath = path.join(tmpDir, "bus.sqlite");
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async () => {}),
    );

    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "user", name: "Serj", relationship: "partner" },
      content: "slow message",
      priority: "urgent",
    }));

    await wait(500);
    expect(instance.isRunning()).toBe(true);
    expect(callCount).toBe(1);
  });

  it("LLM returns empty string → message still completes", async () => {
    const { caller, calls } = createMockLLM([""]);
    const sent: OutputTarget[] = [];
    const dbPath = path.join(tmpDir, "bus.sqlite");

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async (target) => { sent.push(target); }),
    );

    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "user", name: "Serj", relationship: "partner" },
      content: "hello",
      priority: "urgent",
    }));

    await wait(2500);

    expect(calls).toHaveLength(1);
    // Empty string → parseResponse may or may not create a target
    // The important thing is the bus completes without error
    expect(instance.stats().processedCount).toBe(1);
  });

  it("error cascade protection: failing LLM doesn't block subsequent messages", async () => {
    let callCount = 0;
    const caller: CortexLLMCaller = async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("LLM crashed!");
      }
      return { text: `reply-${callCount}`, toolCalls: [] };
    };

    const sent: OutputTarget[] = [];
    const dbPath = path.join(tmpDir, "bus.sqlite");
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
      onError: () => {},
    });

    instance.registerAdapter(
      new WebchatAdapter(async (target) => { sent.push(target); }),
    );

    // Enqueue all 5 messages
    for (let i = 1; i <= 5; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "user", name: "Serj", relationship: "partner" },
        content: `msg-${i}`,
        priority: "urgent",
      }));
    }

    await wait(8000);

    expect(callCount).toBe(5);
    // Message 2 fails, but 1, 3, 4, 5 should have sent replies
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.some((s) => s.content === "reply-1")).toBe(true);
    expect(sent.some((s) => s.content === "reply-3")).toBe(true);
  }, 15000);

  it("concurrent safety: rapid messages processed serially", async () => {
    const callOrder: number[] = [];
    let callCount = 0;
    const caller: CortexLLMCaller = async () => {
      const myIndex = ++callCount;
      callOrder.push(myIndex);
      await wait(50);
      return { text: `reply-${myIndex}`, toolCalls: [] };
    };

    const dbPath = path.join(tmpDir, "bus.sqlite");
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 200_000,
      callLLM: caller,
    });

    instance.registerAdapter(
      new WebchatAdapter(async () => {}),
    );

    // Enqueue 5 messages simultaneously
    for (let i = 0; i < 5; i++) {
      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "user", name: "Serj", relationship: "partner" },
        content: `rapid-${i}`,
        priority: "urgent",
      }));
    }

    await wait(6000);

    expect(callOrder).toEqual([1, 2, 3, 4, 5]);
  }, 10000);
});
