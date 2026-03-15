/**
 * 020e — E2E Webchat Async Delegation
 *
 * Category F — Async Delegation (sessions_spawn + ops_trigger)
 *
 * F1: sessions_spawn triggers onSpawn callback with correct SpawnParams
 * F2: Task result delivery via ops_trigger envelope (completed)
 * F3: Task failure delivery via ops_trigger envelope (failed)
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
import type { SpawnParams } from "../loop.js";
import { getSessionHistory } from "../session.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020e-cortex-e2e/TEST-RESULTS.md",
);
const reporter = new TestReporter();

afterAll(() => {
  // Ensure the directory exists before writing the report
  const dir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  reporter.writeReport(REPORT_PATH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-deleg-"));
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
// F — Async Delegation
// ---------------------------------------------------------------------------

describe("F — Async Delegation", () => {
  it("F1: sessions_spawn triggers onSpawn callback with correct SpawnParams", async () => {
    const t = { id: "F1", name: "sessions_spawn → onSpawn callback", category: "F — Async Delegation" };
    const spawnCalls: SpawnParams[] = [];
    const sent: OutputTarget[] = [];

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async () => ({
          text: "Delegating this task now.",
          toolCalls: [
            {
              id: "tc-spawn-1",
              name: "sessions_spawn",
              arguments: {
                task: "Research TypeScript best practices",
                priority: "normal",
              },
            },
          ],
          _rawContent: [
            { type: "text", text: "Delegating this task now." },
            {
              type: "tool_use",
              id: "tc-spawn-1",
              name: "sessions_spawn",
              input: { task: "Research TypeScript best practices", priority: "normal" },
            },
          ],
        }),
        onSpawn: (params) => {
          spawnCalls.push(params);
          return "job-abc-123";
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      instance.enqueue(makeWebchatEnvelope("please delegate this"));
      await wait(600);

      // onSpawn should have been called once
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].task).toBe("Research TypeScript best practices");
      expect(spawnCalls[0].resultPriority).toBe("normal");
      expect(spawnCalls[0].taskId).toBeDefined();
      expect(spawnCalls[0].envelopeId).toBeDefined();

      // A reply should have been sent (the text portion of LLM response)
      expect(sent.length).toBeGreaterThanOrEqual(1);

      reporter.record({
        ...t,
        passed: true,
        expected: "onSpawn called with task + priority",
        actual: `spawns=${spawnCalls.length}, task='${spawnCalls[0].task}', priority=${spawnCalls[0].resultPriority}`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "onSpawn called with task + priority", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("F2: ops_trigger delivers completed task result to webchat", async () => {
    const t = { id: "F2", name: "ops_trigger completed → webchat reply", category: "F — Async Delegation" };
    const sent: OutputTarget[] = [];
    const taskId = "task-result-001";

    try {
      let callCount = 0;
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async (ctx) => {
          callCount++;
          if (ctx.isOpsTrigger) {
            // LLM sees the task result and summarizes it
            return { text: "Here are the research findings: TypeScript rocks!", toolCalls: [] };
          }
          return { text: "NO_REPLY", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      // Simulate an ops_trigger envelope arriving (as gateway-bridge would create)
      const opsTrigger = createEnvelope({
        channel: "router",
        sender: { id: "router:task", name: "Router", relationship: "internal" },
        content: "", // ops triggers carry data via metadata
        priority: "urgent",
        metadata: {
          ops_trigger: true,
          taskId,
          taskDescription: "Research TypeScript best practices",
          taskStatus: "completed",
          taskResult: "TypeScript best practices include strict mode, generics, and branded types.",
          replyChannel: "webchat",
        },
      });

      instance.enqueue(opsTrigger);
      await wait(600);

      // The reply should go to webchat (resolved from replyChannel in metadata)
      expect(sent.length).toBeGreaterThanOrEqual(1);
      const webchatReplies = sent.filter((s) => s.channel === "webchat");
      expect(webchatReplies.length).toBeGreaterThanOrEqual(1);
      expect(webchatReplies[0].content).toContain("TypeScript");

      // Verify the task result was stored in session
      const history = getSessionHistory(instance.db);
      const taskMessages = history.filter((m) => m.content.includes(taskId));
      expect(taskMessages.length).toBeGreaterThanOrEqual(1);

      reporter.record({
        ...t,
        passed: true,
        expected: "webchat reply with task result",
        actual: `webchatReplies=${webchatReplies.length}, content='${webchatReplies[0].content.slice(0, 60)}'`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "webchat reply with task result", actual: String(err), error: String(err) });
      throw err;
    }
  });

  it("F3: ops_trigger delivers task failure to webchat", async () => {
    const t = { id: "F3", name: "ops_trigger failed → webchat error", category: "F — Async Delegation" };
    const sent: OutputTarget[] = [];
    const taskId = "task-fail-001";

    try {
      instance = await startCortex({
        agentId: "main",
        workspaceDir: path.join(tmpDir, "workspace"),
        dbPath: path.join(tmpDir, "bus.sqlite"),
        maxContextTokens: 10000,
        pollIntervalMs: 50,
        callLLM: async (ctx) => {
          if (ctx.isOpsTrigger) {
            return { text: "Sorry, the research task failed due to a timeout.", toolCalls: [] };
          }
          return { text: "NO_REPLY", toolCalls: [] };
        },
      });
      instance.registerAdapter({
        channelId: "webchat",
        toEnvelope: () => { throw new Error(""); },
        send: async (target) => { sent.push(target); },
        isAvailable: () => true,
      });

      // Simulate a failed ops_trigger
      const opsTrigger = createEnvelope({
        channel: "router",
        sender: { id: "router:task", name: "Router", relationship: "internal" },
        content: "",
        priority: "urgent",
        metadata: {
          ops_trigger: true,
          taskId,
          taskDescription: "Research TypeScript best practices",
          taskStatus: "failed",
          taskError: "Executor timed out after 120s",
          replyChannel: "webchat",
        },
      });

      instance.enqueue(opsTrigger);
      await wait(600);

      // The reply should inform the user of the failure
      expect(sent.length).toBeGreaterThanOrEqual(1);
      const webchatReplies = sent.filter((s) => s.channel === "webchat");
      expect(webchatReplies.length).toBeGreaterThanOrEqual(1);
      expect(webchatReplies[0].content).toContain("failed");

      // Verify failure was stored in session
      const history = getSessionHistory(instance.db);
      const failMessages = history.filter((m) =>
        m.content.includes(taskId) || m.content.includes("failed"),
      );
      expect(failMessages.length).toBeGreaterThanOrEqual(1);

      reporter.record({
        ...t,
        passed: true,
        expected: "webchat reply mentioning failure",
        actual: `webchatReplies=${webchatReplies.length}, content='${webchatReplies[0].content.slice(0, 60)}'`,
      });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "webchat reply mentioning failure", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
