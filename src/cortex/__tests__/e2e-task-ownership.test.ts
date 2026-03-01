/**
 * E2E: Task Ownership (Phase 10)
 *
 * Tests issuer-owned task IDs and clean channel routing:
 * - Cortex generates UUID before spawn
 * - Pending op stores replyChannel/resultPriority locally
 * - Result envelopes use replyChannel (not hardcoded "router")
 * - Spawn failure marks pending op as failed
 * - Router enqueue without taskId still works (backwards compat)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { CortexLLMResult } from "../llm-caller.js";
import type { SpawnParams } from "../loop.js";
import type { ChannelAdapter } from "../channel-adapter.js";
import { initRouterDb, enqueue as routerEnqueue, getJob } from "../../router/queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

function makeMockAdapter(channelId: string): ChannelAdapter & { sent: OutputTarget[] } {
  const sent: OutputTarget[] = [];
  return {
    channelId,
    toEnvelope: () => { throw new Error("not used"); },
    async send(target) { sent.push(target); },
    isAvailable: () => true,
    sent,
  };
}

function makeEnvelope(content: string, channel = "webchat") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-taskown-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) { await instance.stop(); instance = null; }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Task Ownership (Phase 10)", () => {
  it("happy path: Cortex generates UUID → writes pending op with replyChannel → spawn fires with taskId → result uses webchat channel", async () => {
    const spawns: SpawnParams[] = [];
    const webchatAdapter = makeMockAdapter("webchat");
    let callCount = 0;

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "Working on it.",
            toolCalls: [{
              id: "tc-1",
              name: "sessions_spawn",
              arguments: { task: "Research TypeScript patterns", priority: "urgent" },
            }],
          };
        }
        return { text: "Here are the patterns.", toolCalls: [] };
      },
      onSpawn: (p) => { spawns.push(p); return p.taskId; },
    });
    instance.registerAdapter(webchatAdapter);

    // User asks on webchat
    instance.enqueue(makeEnvelope("Show me TypeScript patterns"));
    await wait(300);

    // Verify spawn received a Cortex-generated taskId
    expect(spawns).toHaveLength(1);
    const taskId = spawns[0].taskId;
    expect(taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // UUID format

    // Result arrives on webchat channel (not "router") — simulates what gateway-bridge does
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: `router:${taskId}`, name: "Router", relationship: "internal" },
      content: "TypeScript patterns: use discriminated unions, branded types...",
      priority: "urgent",
      replyContext: { channel: "webchat" },
    }));
    await wait(300);

    // LLM processed the result
    expect(callCount).toBe(2);
    // Response delivered to webchat (not router)
    expect(webchatAdapter.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("spawn failure: pending op written → spawn returns null → op marked failed", async () => {
    const webchatAdapter = makeMockAdapter("webchat");

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "Let me try.",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "Do something", priority: "normal" },
        }],
      }),
      // Spawn fails — returns null
      onSpawn: () => null,
    });
    instance.registerAdapter(webchatAdapter);

    instance.enqueue(makeEnvelope("Try something"));
    await wait(300);

    // Spawn failed — appendTaskResult writes failure directly to cortex_session
    const rows = instance.db.prepare(
      `SELECT * FROM cortex_session WHERE sender_id = 'cortex:ops'`,
    ).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("Router spawn failed");
    expect(rows[0].channel).toBe("webchat");
  });

  it("foreground correctness: result on webchat channel → buildForeground uses webchat history", async () => {
    const webchatAdapter = makeMockAdapter("webchat");
    let callCount = 0;
    let lastTriggerChannel = "";
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (context): Promise<CortexLLMResult> => {
        callCount++;
        // Capture the foreground channel — should be "webchat" when result arrives on webchat
        lastTriggerChannel = context.foregroundChannel ?? "";
        if (callCount === 1) {
          return {
            text: "Looking into it.",
            toolCalls: [{
              id: "tc-1",
              name: "sessions_spawn",
              arguments: { task: "Check server status" },
            }],
          };
        }
        return { text: "Server is up.", toolCalls: [] };
      },
      onSpawn: (p) => { spawns.push(p); return p.taskId; },
    });
    instance.registerAdapter(webchatAdapter);

    // User asks on webchat
    instance.enqueue(makeEnvelope("Is the server up?"));
    await wait(300);

    expect(spawns).toHaveLength(1);
    const taskId = spawns[0].taskId;

    // Result arrives on webchat channel
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: `router:${taskId}`, name: "Router", relationship: "internal" },
      content: "Server status: running, uptime 45d",
      priority: "normal",
      replyContext: { channel: "webchat" },
    }));
    await wait(300);

    // Second LLM call received webchat as trigger channel (not "router")
    expect(callCount).toBe(2);
    expect(lastTriggerChannel).toBe("webchat");
  });

  it("Router enqueue uses caller-provided taskId as job ID", () => {
    const dbPath = path.join(tmpDir, "router-compat.sqlite");
    const db = initRouterDb(dbPath);

    const taskId = crypto.randomUUID();
    const id = routerEnqueue(db, "agent_run", '{"message":"test"}', "session:x", taskId);
    expect(id).toBe(taskId);

    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(taskId);
    expect(job!.status).toBe("in_queue");

    db.close();
  });

  it("taskId passed to Router enqueue is stored as job ID", () => {
    const dbPath = path.join(tmpDir, "router-taskid.sqlite");
    const db = initRouterDb(dbPath);

    const taskId = "cortex-owned-id-abc123";
    const id = routerEnqueue(db, "agent_run", '{"message":"test"}', "session:x", taskId);
    expect(id).toBe(taskId);

    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(taskId);

    db.close();
  });

  it("replyChannel passed to onSpawn for webchat channel", async () => {
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "On it.",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "Research something", priority: "background" },
        }],
      }),
      onSpawn: (p) => { spawns.push(p); return p.taskId; },
    });
    instance.registerAdapter(makeMockAdapter("webchat"));

    instance.enqueue(makeEnvelope("Research this", "webchat"));
    await wait(300);

    // Verify replyChannel is passed to onSpawn
    expect(spawns).toHaveLength(1);
    expect(spawns[0].replyChannel).toBe("webchat");
    expect(spawns[0].resultPriority).toBe("background");
  });

  it("internal channel (router/cron) spawn sets replyChannel to null", async () => {
    const spawns: SpawnParams[] = [];

    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "Processing.",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "Internal task" },
        }],
      }),
      onSpawn: (p) => { spawns.push(p); return p.taskId; },
    });
    instance.registerAdapter(makeMockAdapter("router"));

    // Message arrives on router channel (internal)
    instance.enqueue(createEnvelope({
      channel: "router",
      sender: { id: "router:parent-job", name: "Router", relationship: "internal" },
      content: "Do some sub-work",
      priority: "normal",
    }));
    await wait(300);

    expect(spawns).toHaveLength(1);
    // Internal channels set replyChannel to null
    expect(spawns[0].replyChannel).toBeNull();
  });
});
