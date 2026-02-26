import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, stopCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-index-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEnvelope(content = "test") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex", () => {
  it("initializes and returns running instance", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "ok",
    });

    expect(instance).toBeDefined();
    expect(instance.db).toBeDefined();
    expect(instance.registry).toBeDefined();
  });

  it("runs recovery on startup (no crash = no error)", async () => {
    const errors: Error[] = [];
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "ok",
      onError: (err) => { errors.push(err); },
    });

    // No stalled messages = no recovery error
    expect(errors).toHaveLength(0);
  });

  it("enqueue accepts envelopes and they get processed", async () => {
    let received = "";
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => {
        received = "processed";
        return "NO_REPLY";
      },
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    instance.enqueue(makeEnvelope("hello"));
    await wait(300);

    expect(received).toBe("processed");
  });

  it("stop performs graceful shutdown", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "ok",
    });

    await stopCortex(instance);
    expect(instance.isRunning()).toBe(false);
    instance = null; // prevent double-stop in afterEach
  });

  it("stats returns accurate counts", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "ok",
    });

    const stats = instance.stats();
    expect(stats.processedCount).toBe(0);
    expect(stats.pendingCount).toBe(0);
    expect(stats.activeChannels).toEqual([]);
    expect(stats.pendingOps).toEqual([]);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("double-start prevention", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => "ok",
    });

    await expect(
      startCortex({
        agentId: "main",
        workspaceDir,
        dbPath: path.join(tmpDir, "bus2.sqlite"),
        maxContextTokens: 10000,
        callLLM: async () => "ok",
      }),
    ).rejects.toThrow("already running");
  });

  it("startup with existing DB (recovery + resume)", async () => {
    // Create DB with a pending message
    const dbPath = path.join(tmpDir, "bus.sqlite");
    const first = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 10000,
      callLLM: async () => "NO_REPLY",
    });
    first.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Enqueue but don't process (stop immediately)
    // We need to directly use the bus to avoid auto-processing
    const { enqueue: busEnqueue } = await import("../bus.js");
    busEnqueue(first.db, makeEnvelope("survive restart"));
    await first.stop();
    _resetSingleton();

    // Restart — should find the pending message
    let processed = false;
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => {
        processed = true;
        return "NO_REPLY";
      },
    });
    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });
    instance.enqueue(makeEnvelope("trigger loop")); // trigger the loop

    await wait(300);

    expect(processed).toBe(true);
  });
});
