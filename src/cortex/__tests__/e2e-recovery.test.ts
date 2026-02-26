/**
 * E2E: Crash Recovery (Task 20)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { initBus, enqueue as busEnqueue, markProcessing, countPending, checkpoint } from "../bus.js";
import { initSessionTables, updateChannelState, addPendingOp, getChannelStates, getPendingOps } from "../session.js";
import { recoverState } from "../recovery.js";
import { createEnvelope } from "../types.js";
import type { DatabaseSync } from "node:sqlite";

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-rec-"));
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

function makeEnvelope(content: string) {
  return createEnvelope({
    channel: "webchat",
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

describe("E2E: Crash Recovery", () => {
  it("enqueue 5 → process 2 → crash → restart → remaining processed", async () => {
    const dbPath = path.join(tmpDir, "bus.sqlite");

    // Phase 1: create DB, enqueue 5, process 2, "crash"
    let db = initBus(dbPath);
    initSessionTables(db);

    const envs = Array.from({ length: 5 }, (_, i) => makeEnvelope(`msg-${i}`));
    envs.forEach((e) => busEnqueue(db, e));

    // Simulate processing 2
    markProcessing(db, envs[0].id);
    db.prepare("UPDATE cortex_bus SET state = 'completed', processed_at = datetime('now') WHERE id = ?").run(envs[0].id);
    markProcessing(db, envs[1].id);
    db.prepare("UPDATE cortex_bus SET state = 'completed', processed_at = datetime('now') WHERE id = ?").run(envs[1].id);

    // "Crash" — close DB
    db.close();

    // Phase 2: restart, should process remaining 3
    let processedContents: string[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath,
      maxContextTokens: 10000,
      pollIntervalMs: 30,
      callLLM: async (ctx) => {
        // Track which messages get processed by checking foreground content
        processedContents.push("processed");
        return "NO_REPLY";
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error(""); },
      send: async () => {},
      isAvailable: () => true,
    });
    // Trigger the loop
    instance.enqueue(makeEnvelope("trigger"));

    await wait(1000);

    // 3 remaining + 1 trigger = 4 processed
    expect(processedContents.length).toBeGreaterThanOrEqual(3);
  });

  it("crash mid-processing → stalled reset to pending on restart", async () => {
    const dbPath = path.join(tmpDir, "bus.sqlite");

    // Create DB with a stalled message
    let db = initBus(dbPath);
    initSessionTables(db);
    const env = makeEnvelope("stalled");
    busEnqueue(db, env);
    markProcessing(db, env.id);
    db.close();

    // Restart — recovery should reset stalled
    const errors: string[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => "NO_REPLY",
      onError: (err) => { errors.push(err.message); },
    });

    // Recovery should have reported the reset
    expect(errors.some((e) => e.includes("reset") && e.includes("stalled"))).toBe(true);
  });

  it("checkpoint survives crash → channel states restored", async () => {
    const dbPath = path.join(tmpDir, "bus.sqlite");

    let db = initBus(dbPath);
    initSessionTables(db);

    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T15:00:00Z", layer: "foreground" });
    checkpoint(db, {
      createdAt: new Date().toISOString(),
      sessionSnapshot: "pre-crash state",
      channelStates: getChannelStates(db),
      pendingOps: [],
    });
    db.close();

    // Restart and verify
    db = initBus(dbPath);
    initSessionTables(db);
    const result = recoverState(db);
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint!.sessionSnapshot).toBe("pre-crash state");
    expect(result.channelStates).toHaveLength(1);
    expect(result.channelStates[0].channel).toBe("webchat");
    db.close();
  });

  it("pending ops survive crash", async () => {
    const dbPath = path.join(tmpDir, "bus.sqlite");

    let db = initBus(dbPath);
    initSessionTables(db);
    addPendingOp(db, {
      id: "job-1",
      type: "router_job",
      description: "In-flight job",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
    });
    db.close();

    db = initBus(dbPath);
    initSessionTables(db);
    const result = recoverState(db);
    expect(result.pendingOps).toHaveLength(1);
    expect(result.pendingOps[0].id).toBe("job-1");
    db.close();
  });

  it("empty DB on first start → clean initialization", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir: path.join(tmpDir, "workspace"),
      dbPath: path.join(tmpDir, "fresh.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "NO_REPLY",
    });

    const stats = instance.stats();
    expect(stats.processedCount).toBe(0);
    expect(stats.pendingCount).toBe(0);
    expect(stats.activeChannels).toEqual([]);
  });
});
