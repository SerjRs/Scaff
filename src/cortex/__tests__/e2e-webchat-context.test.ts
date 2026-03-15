/**
 * 020b — E2E Webchat Context Assembly
 *
 * Category C — Session & Context:
 *   C1: Session history persists across messages
 *   C2: System floor includes SOUL.md
 *   C3: Context token budget respected (maxContextTokens)
 *   C4: Background summaries from other channels
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
import { getSessionHistory } from "../session.js";
import type { AssembledContext } from "../context.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020b-cortex-e2e/TEST-RESULTS.md",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-ctx-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff, the cognitive core.");
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
// C — Session & Context
// ---------------------------------------------------------------------------

describe("C — Session & Context", () => {
  it("C1: session history persists across messages", async () => {
    const t = { id: "C1", name: "session history persists across messages", category: "C — Session & Context" };

    try {
      let callCount = 0;
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
        send: async () => {},
        isAvailable: () => true,
      });

      // Send 3 sequential messages
      instance.enqueue(makeWebchatEnvelope("first message"));
      await wait(400);
      instance.enqueue(makeWebchatEnvelope("second message"));
      await wait(400);
      instance.enqueue(makeWebchatEnvelope("third message"));
      await wait(400);

      const history = getSessionHistory(instance.db);
      const userMsgs = history.filter((m) => m.role === "user");
      const assistantMsgs = history.filter((m) => m.role === "assistant");

      // All 3 user messages persisted
      expect(userMsgs.length).toBe(3);
      expect(userMsgs[0].content).toBe("first message");
      expect(userMsgs[1].content).toBe("second message");
      expect(userMsgs[2].content).toBe("third message");

      // All 3 assistant responses persisted
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(3);
      expect(assistantMsgs.some((m) => m.content === "reply-1")).toBe(true);
      expect(assistantMsgs.some((m) => m.content === "reply-2")).toBe(true);
      expect(assistantMsgs.some((m) => m.content === "reply-3")).toBe(true);

      reporter.record({ ...t, passed: true, expected: "3 user + 3 assistant messages in session", actual: `users=${userMsgs.length}, assistants=${assistantMsgs.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "3 user + 3 assistant messages in session", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("C2: system floor includes SOUL.md", async () => {
    const t = { id: "C2", name: "system floor includes SOUL.md", category: "C — Session & Context" };
    let capturedContext: AssembledContext | null = null;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async (ctx) => {
          capturedContext = ctx;
          return { text: "ok", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("check context"));
      await wait(400);

      expect(capturedContext).not.toBeNull();

      // System floor layer should exist and contain SOUL.md content
      const systemFloor = capturedContext!.layers.find((l) => l.name === "system_floor");
      expect(systemFloor).toBeDefined();
      expect(systemFloor!.content).toContain("SOUL.md");
      expect(systemFloor!.content).toContain("You are Scaff, the cognitive core.");
      expect(systemFloor!.tokens).toBeGreaterThan(0);

      reporter.record({ ...t, passed: true, expected: "system floor has SOUL.md content", actual: `found SOUL.md in system_floor, tokens=${systemFloor!.tokens}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "system floor has SOUL.md content", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("C3: context token budget respected (maxContextTokens)", async () => {
    const t = { id: "C3", name: "context token budget respected", category: "C — Session & Context" };
    let capturedContext: AssembledContext | null = null;

    try {
      // Use a very small token budget
      const maxTokens = 200;

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: maxTokens,
        pollIntervalMs: 30,
        callLLM: async (ctx) => {
          capturedContext = ctx;
          return { text: "ok", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      // Send many messages to fill up the context beyond the budget
      const longMessage = "This is a fairly long message that should take up space in the context window. ".repeat(5);
      for (let i = 0; i < 10; i++) {
        instance.enqueue(makeWebchatEnvelope(`msg-${i}: ${longMessage}`));
      }
      await wait(2000);

      expect(capturedContext).not.toBeNull();

      // The foreground should be truncated — not all 10 messages fit
      // The system floor takes up tokens, leaving even less for foreground
      const foregroundLayer = capturedContext!.layers.find((l) => l.name === "foreground");
      expect(foregroundLayer).toBeDefined();

      // With a tiny budget, foreground must have fewer messages than all 10 sent
      // (system floor alone likely eats most of the 200-token budget)
      const foregroundMsgCount = capturedContext!.foregroundMessages.length;

      // The last captured context should show truncation: fewer messages in foreground
      // than total messages in the full session history
      const fullHistory = getSessionHistory(instance.db);
      const totalUserMsgs = fullHistory.filter((m) => m.role === "user").length;

      expect(foregroundMsgCount).toBeLessThan(totalUserMsgs + totalUserMsgs); // foreground < total user+assistant
      // Foreground tokens should stay within what remains after system floor
      const systemFloor = capturedContext!.layers.find((l) => l.name === "system_floor");
      const systemTokens = systemFloor?.tokens ?? 0;
      const remainingBudget = Math.max(0, maxTokens - systemTokens);
      expect(foregroundLayer!.tokens).toBeLessThanOrEqual(remainingBudget + 50); // small tolerance

      reporter.record({
        ...t, passed: true,
        expected: "foreground truncated within token budget",
        actual: `maxTokens=${maxTokens}, systemFloor=${systemTokens}, foreground=${foregroundLayer!.tokens}, foregroundMsgs=${foregroundMsgCount}, totalHistory=${fullHistory.length}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "foreground truncated within token budget", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("C4: background summaries from other channels", async () => {
    const t = { id: "C4", name: "background summaries from other channels", category: "C — Session & Context" };
    let capturedContext: AssembledContext | null = null;
    let callCount = 0;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async (ctx) => {
          callCount++;
          capturedContext = ctx;
          return { text: "NO_REPLY", toolCalls: [] };
        },
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

      // First: send a message on whatsapp to create channel state
      instance.enqueue(createEnvelope({
        channel: "whatsapp",
        sender: { id: "serj", name: "Serj", relationship: "partner" },
        content: "hello from whatsapp",
      }));
      await wait(400);

      // Then: send a message on webchat — the foreground channel
      // The LLM should see whatsapp as a background channel
      instance.enqueue(makeWebchatEnvelope("hello from webchat"));
      await wait(400);

      expect(capturedContext).not.toBeNull();

      // The foreground should be webchat
      expect(capturedContext!.foregroundChannel).toBe("webchat");

      // Background summaries should include whatsapp
      // Note: with issuer-based context (getCortexSessionKey), all channels are in foreground
      // and background is empty. But backgroundSummaries map may still be populated from
      // getChannelStates. Let's check the background layer content or the summaries map.
      const backgroundLayer = capturedContext!.layers.find((l) => l.name === "background");

      // With issuer-based context, background content may be empty (all channels in foreground).
      // Instead, verify via backgroundSummaries map or channel states.
      const channelStates = instance.stats().activeChannels;
      const whatsappState = channelStates.find((s) => s.channel === "whatsapp");

      // whatsapp should exist in channel states
      expect(whatsappState).toBeDefined();

      // backgroundSummaries map should have whatsapp entry
      // (assembled from getChannelStates in assembleContext)
      expect(capturedContext!.backgroundSummaries.has("whatsapp")).toBe(true);

      reporter.record({
        ...t, passed: true,
        expected: "whatsapp in background summaries when webchat is foreground",
        actual: `foreground=${capturedContext!.foregroundChannel}, bgSummaries=[${[...capturedContext!.backgroundSummaries.keys()].join(",")}], bgLayer=${backgroundLayer?.tokens ?? 0} tokens`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "whatsapp in background summaries when webchat is foreground", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
