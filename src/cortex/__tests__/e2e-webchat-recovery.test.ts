/**
 * 020g — E2E Webchat Recovery & Error Handling
 *
 * Categories:
 *   H — Recovery & Error Handling
 *     H1: LLM call failure → message marked failed
 *     H2: Adapter send failure → error logged, loop continues
 *     H3: Queue ordering preserved on failure
 *     H4: Idempotent message processing (same envelope_id not processed twice)
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
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020g-cortex-e2e/TEST-RESULTS.md",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-recovery-"));
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

function makeWebchatEnvelope(content: string, id?: string) {
  return createEnvelope({
    ...(id ? { id } : {}),
    channel: "webchat",
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

/** Query bus state for a given envelope ID */
function getBusState(db: import("node:sqlite").DatabaseSync, envelopeId: string): string | null {
  const row = db.prepare("SELECT state FROM cortex_bus WHERE id = ?").get(envelopeId) as { state: string } | undefined;
  return row?.state ?? null;
}

// ---------------------------------------------------------------------------
// H — Recovery & Error Handling
// ---------------------------------------------------------------------------

describe("H — Recovery & Error Handling", () => {
  it("H1: LLM call failure → message marked failed in bus", async () => {
    const t = { id: "H1", name: "LLM failure marks message failed", category: "H — Recovery & Error Handling" };
    const errors: string[] = [];

    try {
      const envelope = makeWebchatEnvelope("trigger LLM failure");

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => {
          throw new Error("LLM service unavailable");
        },
        onError: (err) => { errors.push(err.message); },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      instance.enqueue(envelope);
      await wait(400);

      const state = getBusState(instance.db, envelope.id);
      expect(state).toBe("failed");
      expect(errors.some((e) => e.includes("LLM service unavailable"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "state=failed, error logged", actual: `state=${state}, errors=${errors.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "state=failed, error logged", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("H2: Adapter send failure → error logged, loop continues", async () => {
    const t = { id: "H2", name: "adapter send failure, loop continues", category: "H — Recovery & Error Handling" };
    const errors: string[] = [];
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
        onError: (err) => { errors.push(err.message); },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => {
          if (target.content === "reply-1") {
            throw new Error("Adapter connection lost");
          }
          sent.push(target);
        },
        isAvailable: () => true,
      });

      // First message: adapter will throw on send
      instance.enqueue(makeWebchatEnvelope("msg that causes adapter failure"));
      // Second message: should still process normally
      instance.enqueue(makeWebchatEnvelope("msg after adapter failure"));
      await wait(800);

      // The adapter error should be logged
      expect(errors.some((e) => e.includes("Adapter") && e.includes("send failed"))).toBe(true);
      // Second message should have been processed and sent successfully
      expect(sent.some((s) => s.content === "reply-2")).toBe(true);
      expect(instance.stats().processedCount).toBe(2);

      reporter.record({ ...t, passed: true, expected: "error logged, 2nd message processed", actual: `errors=${errors.length}, sent=${sent.length}, processed=${instance.stats().processedCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "error logged, 2nd message processed", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("H3: Queue ordering preserved on failure — messages 2+3 process after msg 1 fails", async () => {
    const t = { id: "H3", name: "queue ordering preserved on failure", category: "H — Recovery & Error Handling" };
    const sent: OutputTarget[] = [];
    let callCount = 0;

    try {
      const env1 = makeWebchatEnvelope("msg-1-will-fail");
      const env2 = makeWebchatEnvelope("msg-2-ok");
      const env3 = makeWebchatEnvelope("msg-3-ok");

      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("LLM transient failure");
          }
          return { text: `reply-${callCount}`, toolCalls: [] };
        },
        onError: () => {},
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(env1);
      instance.enqueue(env2);
      instance.enqueue(env3);
      await wait(800);

      // First message should be failed
      const state1 = getBusState(instance.db, env1.id);
      expect(state1).toBe("failed");

      // Messages 2 and 3 should be completed
      const state2 = getBusState(instance.db, env2.id);
      const state3 = getBusState(instance.db, env3.id);
      expect(state2).toBe("completed");
      expect(state3).toBe("completed");

      // Two replies sent (from msg 2 and 3)
      expect(sent).toHaveLength(2);
      expect(sent[0].content).toBe("reply-2");
      expect(sent[1].content).toBe("reply-3");

      reporter.record({ ...t, passed: true, expected: "msg1=failed, msg2+3=completed, 2 replies sent", actual: `states=${state1},${state2},${state3}, sent=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "msg1=failed, msg2+3=completed, 2 replies sent", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("H4: Idempotent message processing — same envelope_id not enqueued twice", async () => {
    const t = { id: "H4", name: "idempotent envelope_id", category: "H — Recovery & Error Handling" };
    let llmCallCount = 0;

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 30,
        callLLM: async () => {
          llmCallCount++;
          return { text: "reply", toolCalls: [] };
        },
        onError: () => {},
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async () => {},
        isAvailable: () => true,
      });

      const fixedId = "duplicate-envelope-id-test";
      const env1 = makeWebchatEnvelope("first enqueue", fixedId);

      // First enqueue succeeds
      instance.enqueue(env1);

      // Second enqueue with same ID should throw (PRIMARY KEY constraint)
      const env2 = makeWebchatEnvelope("second enqueue", fixedId);
      let duplicateRejected = false;
      try {
        instance.enqueue(env2);
      } catch {
        duplicateRejected = true;
      }

      await wait(400);

      expect(duplicateRejected).toBe(true);
      // Only 1 LLM call — the duplicate was rejected at enqueue time
      expect(llmCallCount).toBe(1);

      reporter.record({ ...t, passed: true, expected: "duplicate rejected, 1 LLM call", actual: `rejected=${duplicateRejected}, llmCalls=${llmCallCount}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "duplicate rejected, 1 LLM call", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
