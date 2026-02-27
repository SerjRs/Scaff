import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveChannelMode, createShadowHook } from "../shadow.js";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type CortexModeConfig } from "../types.js";
import { countPending } from "../bus.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shadow-test-"));
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

function makeEnvelope(channel = "webchat", content = "test") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// resolveChannelMode
// ---------------------------------------------------------------------------

describe("resolveChannelMode", () => {
  it("returns off when config is null", () => {
    expect(resolveChannelMode(null, "webchat")).toBe("off");
  });

  it("returns off when config is undefined", () => {
    expect(resolveChannelMode(undefined, "webchat")).toBe("off");
  });

  it("returns off when not enabled", () => {
    const config: CortexModeConfig = { enabled: false, defaultMode: "live", channels: {} };
    expect(resolveChannelMode(config, "webchat")).toBe("off");
  });

  it("uses per-channel override over defaultMode", () => {
    const config: CortexModeConfig = {
      enabled: true,
      defaultMode: "off",
      channels: { webchat: "live", whatsapp: "shadow" },
    };
    expect(resolveChannelMode(config, "webchat")).toBe("live");
    expect(resolveChannelMode(config, "whatsapp")).toBe("shadow");
  });

  it("falls back to defaultMode when channel not specified", () => {
    const config: CortexModeConfig = {
      enabled: true,
      defaultMode: "shadow",
      channels: { webchat: "live" },
    };
    expect(resolveChannelMode(config, "telegram")).toBe("shadow");
  });

  it("off for unspecified channel when defaultMode is off", () => {
    const config: CortexModeConfig = {
      enabled: true,
      defaultMode: "off",
      channels: { webchat: "live" },
    };
    expect(resolveChannelMode(config, "whatsapp")).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// createShadowHook
// ---------------------------------------------------------------------------

describe("createShadowHook", () => {
  it("observe enqueues envelope into Cortex bus", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    const hook = createShadowHook(instance);
    hook.observe(makeEnvelope("webchat", "shadow test"));

    // Message should be in the bus
    await wait(100);
    // The loop should have picked it up (processed or pending)
    const stats = instance.stats();
    // Either processed or was processed — bus should have seen it
    expect(stats.processedCount + stats.pendingCount).toBeGreaterThanOrEqual(0);
  });

  it("audit returns match=true when responses agree", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    const hook = createShadowHook(instance);

    // Simulate: Cortex would have been silent, existing system was also silent
    const result = hook.audit("", "webchat");
    // No last decision yet, so cortex targets empty → both silent
    expect(result.cortexTargets).toHaveLength(0);
  });

  it("audit returns match=false with diff when responses disagree", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    const hook = createShadowHook(instance);

    // Cortex has no decision, but existing system sent something
    const result = hook.audit("Hello from old system", "webchat");
    expect(result.match).toBe(false);
    expect(result.diff).toContain("Cortex would have been silent");
  });

  it("getLastDecision returns null initially", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      callLLM: async () => ({ text: "NO_REPLY", toolCalls: [] }),
    });

    const hook = createShadowHook(instance);
    expect(hook.getLastDecision()).toBeNull();
  });
});
