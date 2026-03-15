/**
 * 020a — E2E Webchat Flow, Routing & Silence
 *
 * Categories:
 *   A — Message Flow (webchat in → Cortex → webchat out)
 *   B — Silent Responses (NO_REPLY, HEARTBEAT_OK suppression)
 *   K — Webchat-Specific (adapter, priority, cross-channel)
 *
 * Uses programmatic Cortex API — no gateway, no WebSocket.
 * All LLMs are mocked. All tests are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { WebchatAdapter, type WebchatRawMessage } from "../adapters/webchat.js";
import { getSessionHistory } from "../session.js";
import type { AssembledContext } from "../context.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020a-cortex-e2e/TEST-RESULTS.md",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-wc-"));
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
// A — Message Flow
// ---------------------------------------------------------------------------

describe("A — Message Flow", () => {
  it("A1: single webchat message → Cortex reply on webchat", async () => {
    const t = { id: "A1", name: "single webchat → reply", category: "A — Message Flow" };
    const sent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "Hello back!", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("hello"));
      await wait(400);

      expect(sent).toHaveLength(1);
      expect(sent[0].channel).toBe("webchat");
      expect(sent[0].content).toBe("Hello back!");

      reporter.record({ ...t, passed: true, expected: "1 reply on webchat", actual: `sent=${sent.length}, channel=${sent[0].channel}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "1 reply on webchat", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("A2: multiple sequential messages processed in order", async () => {
    const t = { id: "A2", name: "sequential messages FIFO", category: "A — Message Flow" };
    const sent: OutputTarget[] = [];
    let callCount = 0;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => {
          callCount++;
          return { text: `reply-${callCount}`, toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      for (let i = 0; i < 3; i++) {
        instance.enqueue(makeWebchatEnvelope(`msg-${i}`));
      }
      await wait(800);

      expect(sent).toHaveLength(3);
      expect(sent[0].content).toBe("reply-1");
      expect(sent[1].content).toBe("reply-2");
      expect(sent[2].content).toBe("reply-3");

      reporter.record({ ...t, passed: true, expected: "3 replies in order", actual: `sent=${sent.length}, order=${sent.map((s) => s.content).join(",")}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "3 replies in order", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("A3: message stored in session history", async () => {
    const t = { id: "A3", name: "session history storage", category: "A — Message Flow" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "stored reply", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("store this"));
      await wait(400);

      const history = getSessionHistory(instance.db);
      const userMsgs = history.filter((m) => m.role === "user");
      const assistantMsgs = history.filter((m) => m.role === "assistant");

      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(userMsgs.some((m) => m.content === "store this")).toBe(true);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
      expect(assistantMsgs.some((m) => m.content === "stored reply")).toBe(true);

      reporter.record({ ...t, passed: true, expected: "user + assistant in session", actual: `users=${userMsgs.length}, assistants=${assistantMsgs.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "user + assistant in session", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("A4: processedCount increments after each message", async () => {
    const t = { id: "A4", name: "processedCount increments", category: "A — Message Flow" };

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => ({ text: "ok", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      expect(instance.stats().processedCount).toBe(0);

      instance.enqueue(makeWebchatEnvelope("one"));
      instance.enqueue(makeWebchatEnvelope("two"));
      await wait(600);

      expect(instance.stats().processedCount).toBe(2);
      expect(instance.stats().pendingCount).toBe(0);

      reporter.record({ ...t, passed: true, expected: "processedCount=2, pending=0", actual: `processed=${instance.stats().processedCount}, pending=${instance.stats().pendingCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "processedCount=2, pending=0", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("A5: LLM receives foreground context with message content", async () => {
    const t = { id: "A5", name: "LLM sees message in context", category: "A — Message Flow" };
    let receivedContext: AssembledContext | null = null;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async (ctx) => {
          receivedContext = ctx;
          return { text: "got it", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("context test message"));
      await wait(400);

      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.foregroundChannel).toBe("webchat");
      // The message should appear in foreground messages
      const hasMsg = receivedContext!.foregroundMessages.some(
        (m) => m.content === "context test message",
      );
      expect(hasMsg).toBe(true);

      reporter.record({ ...t, passed: true, expected: "context has webchat foreground + message", actual: `channel=${receivedContext!.foregroundChannel}, msgFound=${hasMsg}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "context has webchat foreground + message", actual: String(err), error: String(err) });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// B — Silent Responses
// ---------------------------------------------------------------------------

describe("B — Silent Responses", () => {
  it("B1: NO_REPLY → no output sent", async () => {
    const t = { id: "B1", name: "NO_REPLY suppresses output", category: "B — Silent Responses" };
    const sent: OutputTarget[] = [];

    try {
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
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("group banter"));
      await wait(400);

      expect(sent).toHaveLength(0);
      expect(instance.stats().processedCount).toBe(1);

      reporter.record({ ...t, passed: true, expected: "0 sent, 1 processed", actual: `sent=${sent.length}, processed=${instance.stats().processedCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "0 sent, 1 processed", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("B2: HEARTBEAT_OK → no output sent", async () => {
    const t = { id: "B2", name: "HEARTBEAT_OK suppresses output", category: "B — Silent Responses" };
    const sent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "HEARTBEAT_OK", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(createEnvelope({
        channel: "webchat",
        sender: { id: "heartbeat", name: "System", relationship: "system" },
        content: "heartbeat tick",
        priority: "background",
      }));
      await wait(400);

      expect(sent).toHaveLength(0);
      expect(instance.stats().processedCount).toBe(1);

      reporter.record({ ...t, passed: true, expected: "0 sent, 1 processed", actual: `sent=${sent.length}, processed=${instance.stats().processedCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "0 sent, 1 processed", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("B3: silence recorded as [silence] in session", async () => {
    const t = { id: "B3", name: "silence stored as [silence]", category: "B — Silent Responses" };

    try {
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

      instance.enqueue(makeWebchatEnvelope("test silence"));
      await wait(400);

      const history = getSessionHistory(instance.db);
      const silenceMsg = history.find((m) => m.content === "[silence]");
      expect(silenceMsg).toBeDefined();
      expect(silenceMsg!.role).toBe("assistant");

      reporter.record({ ...t, passed: true, expected: "[silence] in session as assistant", actual: `found=${!!silenceMsg}, role=${silenceMsg?.role}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "[silence] in session as assistant", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("B4: mix of silent and real responses — only real ones sent", async () => {
    const t = { id: "B4", name: "mixed silence + responses", category: "B — Silent Responses" };
    const sent: OutputTarget[] = [];
    let callCount = 0;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => {
          callCount++;
          return { text: callCount % 2 === 0 ? "real response" : "NO_REPLY", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      for (let i = 0; i < 4; i++) {
        instance.enqueue(makeWebchatEnvelope(`msg-${i}`));
      }
      await wait(1000);

      expect(sent).toHaveLength(2);
      expect(sent.every((s) => s.content === "real response")).toBe(true);
      expect(instance.stats().processedCount).toBe(4);

      reporter.record({ ...t, passed: true, expected: "2 real, 2 silent, 4 processed", actual: `sent=${sent.length}, processed=${instance.stats().processedCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "2 real, 2 silent, 4 processed", actual: String(err), error: String(err) });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// K — Webchat-Specific
// ---------------------------------------------------------------------------

describe("K — Webchat-Specific", () => {
  it("K1: WebchatAdapter.toEnvelope creates correct envelope", async () => {
    const t = { id: "K1", name: "WebchatAdapter.toEnvelope", category: "K — Webchat-Specific" };

    try {
      const adapter = new WebchatAdapter(async () => {});
      const resolver = {
        resolve: (_ch: string, id: string) => ({
          id,
          name: "Serj",
          relationship: "partner" as const,
        }),
      };

      const envelope = adapter.toEnvelope(
        { content: "hello from webchat", senderId: "serj" } satisfies WebchatRawMessage,
        resolver,
      );

      expect(envelope.channel).toBe("webchat");
      expect(envelope.sender.id).toBe("serj");
      expect(envelope.sender.relationship).toBe("partner");
      expect(envelope.content).toBe("hello from webchat");
      expect(envelope.priority).toBe("urgent");

      reporter.record({ ...t, passed: true, expected: "webchat envelope with urgent priority", actual: `channel=${envelope.channel}, priority=${envelope.priority}, sender=${envelope.sender.id}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "webchat envelope with urgent priority", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K2: WebchatAdapter captures sent messages", async () => {
    const t = { id: "K2", name: "WebchatAdapter captures output", category: "K — Webchat-Specific" };
    const sent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "captured!", toolCalls: [] }),
      });

      const adapter = new WebchatAdapter(async (target) => { sent.push(target); });
      instance.registerAdapter(adapter);

      instance.enqueue(makeWebchatEnvelope("capture test"));
      await wait(400);

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe("captured!");
      expect(sent[0].channel).toBe("webchat");

      reporter.record({ ...t, passed: true, expected: "adapter captured 1 message", actual: `sent=${sent.length}, content=${sent[0].content}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "adapter captured 1 message", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K3: webchat messages auto-get urgent priority", async () => {
    const t = { id: "K3", name: "webchat = urgent priority", category: "K — Webchat-Specific" };

    try {
      const adapter = new WebchatAdapter(async () => {});
      const resolver = {
        resolve: (_ch: string, id: string) => ({
          id,
          name: "Test",
          relationship: "partner" as const,
        }),
      };

      const envelope = adapter.toEnvelope(
        { content: "test", senderId: "user1" } satisfies WebchatRawMessage,
        resolver,
      );

      expect(envelope.priority).toBe("urgent");

      reporter.record({ ...t, passed: true, expected: "priority=urgent", actual: `priority=${envelope.priority}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "priority=urgent", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K4: cross-channel — webchat reply routes to webchat, not other channels", async () => {
    const t = { id: "K4", name: "reply routes to source channel", category: "K — Webchat-Specific" };
    const webchatSent: OutputTarget[] = [];
    const whatsappSent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "webchat only", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { webchatSent.push(target); },
        isAvailable: () => true,
      });
      instance.registerAdapter({
        channelId: "whatsapp",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { whatsappSent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("from webchat only"));
      await wait(400);

      expect(webchatSent).toHaveLength(1);
      expect(whatsappSent).toHaveLength(0);

      reporter.record({ ...t, passed: true, expected: "webchat=1, whatsapp=0", actual: `webchat=${webchatSent.length}, whatsapp=${whatsappSent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "webchat=1, whatsapp=0", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K5: webchat + whatsapp messages land in same session", async () => {
    const t = { id: "K5", name: "unified session across channels", category: "K — Webchat-Specific" };

    try {
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
      instance.registerAdapter({
        channelId: "whatsapp",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("from webchat"));
      instance.enqueue(createEnvelope({
        channel: "whatsapp",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: "from whatsapp",
      }));
      await wait(600);

      const history = getSessionHistory(instance.db);
      const userMsgs = history.filter((m) => m.role === "user");
      const channels = userMsgs.map((m) => m.channel);

      expect(channels).toContain("webchat");
      expect(channels).toContain("whatsapp");
      expect(userMsgs).toHaveLength(2);

      reporter.record({ ...t, passed: true, expected: "2 user msgs, both channels in session", actual: `users=${userMsgs.length}, channels=${[...new Set(channels)].join(",")}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "2 user msgs, both channels in session", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K6: [[send_to:whatsapp]] directive routes cross-channel", async () => {
    const t = { id: "K6", name: "cross-channel send_to directive", category: "K — Webchat-Specific" };
    const webchatSent: OutputTarget[] = [];
    const whatsappSent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "[[send_to:whatsapp]] cross-channel message", toolCalls: [] }),
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { webchatSent.push(target); },
        isAvailable: () => true,
      });
      instance.registerAdapter({
        channelId: "whatsapp",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { whatsappSent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("tell whatsapp"));
      await wait(400);

      // The send_to directive should route to whatsapp, not webchat
      expect(whatsappSent).toHaveLength(1);
      expect(whatsappSent[0].content).toBe("cross-channel message");
      expect(webchatSent).toHaveLength(0);

      reporter.record({ ...t, passed: true, expected: "whatsapp=1, webchat=0", actual: `whatsapp=${whatsappSent.length}, webchat=${webchatSent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "whatsapp=1, webchat=0", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K7: onMessageComplete callback fires for every message", async () => {
    const t = { id: "K7", name: "onMessageComplete fires", category: "K — Webchat-Specific" };
    const completions: Array<{ id: string; silent: boolean }> = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => ({ text: "reply", toolCalls: [] }),
        onMessageComplete: (envelopeId, _rc, silent) => {
          completions.push({ id: envelopeId, silent });
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("msg1"));
      instance.enqueue(makeWebchatEnvelope("msg2"));
      await wait(600);

      expect(completions).toHaveLength(2);
      expect(completions.every((c) => c.silent === false)).toBe(true);

      reporter.record({ ...t, passed: true, expected: "2 completions, none silent", actual: `completions=${completions.length}, allNotSilent=${completions.every((c) => !c.silent)}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "2 completions, none silent", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("K8: onMessageComplete marks silent for NO_REPLY", async () => {
    const t = { id: "K8", name: "onMessageComplete silent flag", category: "K — Webchat-Specific" };
    const completions: Array<{ id: string; silent: boolean }> = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
        onMessageComplete: (envelopeId, _rc, silent) => {
          completions.push({ id: envelopeId, silent });
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("silent msg"));
      await wait(400);

      expect(completions).toHaveLength(1);
      expect(completions[0].silent).toBe(true);

      reporter.record({ ...t, passed: true, expected: "1 completion, silent=true", actual: `completions=${completions.length}, silent=${completions[0]?.silent}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "1 completion, silent=true", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
