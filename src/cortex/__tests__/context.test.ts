import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, appendToSession, updateChannelState, addPendingOp } from "../session.js";
import {
  estimateTokens,
  loadSystemFloor,
  buildForeground,
  buildBackground,
  assembleContext,
} from "../context.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ctx-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedWorkspace() {
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff. Direct, competent.");
  fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "Name: Scaff\nEmoji: 🔧");
  fs.writeFileSync(path.join(workspaceDir, "USER.md"), "Name: Serj\nTimezone: Europe/Bucharest");
  fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "Built Router system. Working on Cortex.");
}

function makeEnvelope(channel = "webchat", content = "test") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    // 100 chars → ~25 tokens
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 chars → ceil(3/4) = 1
  });
});

// ---------------------------------------------------------------------------
// loadSystemFloor
// ---------------------------------------------------------------------------

describe("loadSystemFloor", () => {
  it("loads SOUL.md, IDENTITY.md, USER.md, MEMORY.md", async () => {
    seedWorkspace();
    const layer = await loadSystemFloor(workspaceDir);

    expect(layer.name).toBe("system_floor");
    expect(layer.content).toContain("Scaff");
    expect(layer.content).toContain("SOUL.md");
    expect(layer.content).toContain("IDENTITY.md");
    expect(layer.content).toContain("USER.md");
    expect(layer.content).toContain("MEMORY.md");
    expect(layer.tokens).toBeGreaterThan(0);
  });

  it("includes pending operations state", async () => {
    seedWorkspace();
    const ops = [
      { id: "job-1", type: "router_job" as const, description: "Analyze code", dispatchedAt: "2026-02-26T15:00:00Z", expectedChannel: "router" },
    ];
    const layer = await loadSystemFloor(workspaceDir, ops);

    expect(layer.content).toContain("Active Operations");
    expect(layer.content).toContain("Analyze code");
  });

  it("handles missing workspace files gracefully", async () => {
    // Empty workspace — no files
    const layer = await loadSystemFloor(workspaceDir);
    expect(layer.name).toBe("system_floor");
    expect(layer.tokens).toBe(0);
  });

  it("returns valid ContextLayer with token estimate", async () => {
    seedWorkspace();
    const layer = await loadSystemFloor(workspaceDir);
    expect(layer.tokens).toBeGreaterThan(0);
    expect(layer.tokens).toBe(estimateTokens(layer.content));
  });
});

// ---------------------------------------------------------------------------
// buildForeground
// ---------------------------------------------------------------------------

describe("buildForeground", () => {
  it("returns messages from trigger channel only", () => {
    appendToSession(db, makeEnvelope("webchat", "webchat msg"));
    appendToSession(db, makeEnvelope("whatsapp", "whatsapp msg"));
    appendToSession(db, makeEnvelope("webchat", "webchat msg 2"));

    const { layer, messages } = buildForeground(db, "webchat", 10000);
    expect(layer.content).toContain("webchat msg");
    expect(layer.content).toContain("webchat msg 2");
    expect(layer.content).not.toContain("whatsapp msg");
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.channel === "webchat")).toBe(true);
  });

  it("respects token budget (truncates oldest when over)", () => {
    // Add many messages
    for (let i = 0; i < 100; i++) {
      appendToSession(db, makeEnvelope("webchat", `message number ${i} with some extra padding text`));
    }

    const smallBudget = 50; // Very small — should only fit a few messages
    const { layer } = buildForeground(db, "webchat", smallBudget);
    expect(layer.tokens).toBeLessThanOrEqual(smallBudget);
    // Should contain the most recent messages, not the oldest
    expect(layer.content).toContain("message number 99");
  });

  it("returns empty for channel with no messages", () => {
    const { layer, messages } = buildForeground(db, "webchat", 10000);
    expect(layer.content).toBe("");
    expect(layer.tokens).toBe(0);
    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildBackground
// ---------------------------------------------------------------------------

describe("buildBackground", () => {
  it("compresses other channels to one-line summaries", () => {
    updateChannelState(db, "whatsapp", {
      lastMessageAt: "2026-02-26T14:00:00Z",
      unreadCount: 5,
      summary: "5 messages, Serj asked about dinner",
      layer: "background",
    });
    updateChannelState(db, "telegram", {
      lastMessageAt: "2026-02-26T13:00:00Z",
      unreadCount: 12,
      summary: "12 messages, group banter",
      layer: "background",
    });

    const layer = buildBackground(db, "webchat");
    expect(layer.content).toContain("[whatsapp]");
    expect(layer.content).toContain("5 messages, Serj asked about dinner");
    expect(layer.content).toContain("[telegram]");
    expect(layer.content).toContain("12 messages, group banter");
  });

  it("excludes the foreground channel", () => {
    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T15:00:00Z", layer: "foreground" });
    updateChannelState(db, "whatsapp", { lastMessageAt: "2026-02-26T14:00:00Z", layer: "background" });

    const layer = buildBackground(db, "webchat");
    expect(layer.content).not.toContain("[webchat]");
    expect(layer.content).toContain("[whatsapp]");
  });

  it("excludes archived channels", () => {
    updateChannelState(db, "telegram", { lastMessageAt: "2026-02-20T10:00:00Z", layer: "archived" });
    updateChannelState(db, "whatsapp", { lastMessageAt: "2026-02-26T14:00:00Z", layer: "background" });

    const layer = buildBackground(db, "webchat");
    expect(layer.content).not.toContain("[telegram]");
    expect(layer.content).toContain("[whatsapp]");
  });

  it("returns empty for no active background channels", () => {
    const layer = buildBackground(db, "webchat");
    expect(layer.content).toBe("");
    expect(layer.tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// assembleContext
// ---------------------------------------------------------------------------

describe("assembleContext", () => {
  it("produces all layers in correct order", async () => {
    seedWorkspace();
    const env = makeEnvelope("webchat", "hello");
    appendToSession(db, env);

    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 100000,
    });

    expect(ctx.layers).toHaveLength(4);
    expect(ctx.layers[0].name).toBe("system_floor");
    expect(ctx.layers[1].name).toBe("foreground");
    expect(ctx.layers[2].name).toBe("background");
    expect(ctx.layers[3].name).toBe("archived");
  });

  it("system floor always present regardless of budget", async () => {
    seedWorkspace();
    const env = makeEnvelope("webchat", "hello");

    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 1, // Absurdly small budget
    });

    // System floor is always loaded
    expect(ctx.layers[0].content).toContain("Scaff");
  });

  it("total tokens ≤ maxTokens (except system floor)", async () => {
    seedWorkspace();
    for (let i = 0; i < 50; i++) {
      appendToSession(db, makeEnvelope("webchat", `message ${i}`));
    }
    const env = makeEnvelope("webchat", "latest");

    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 200,
    });

    // Foreground + background should respect budget (system floor may exceed)
    const nonFloorTokens = ctx.layers[1].tokens + ctx.layers[2].tokens;
    expect(nonFloorTokens).toBeLessThanOrEqual(200);
  });

  it("includes pending ops in system floor", async () => {
    seedWorkspace();
    addPendingOp(db, {
      id: "job-1",
      type: "router_job",
      description: "Analyze complexity",
      dispatchedAt: "2026-02-26T15:00:00Z",
      expectedChannel: "router",
    });
    const env = makeEnvelope("webchat", "test");

    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 100000,
    });

    expect(ctx.layers[0].content).toContain("Analyze complexity");
    expect(ctx.pendingOps).toHaveLength(1);
  });

  it("empty session (first message): system floor + trigger only", async () => {
    seedWorkspace();
    const env = makeEnvelope("webchat", "first message ever");

    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 100000,
    });

    expect(ctx.foregroundChannel).toBe("webchat");
    expect(ctx.layers[0].content).toContain("Scaff");
    // Foreground is empty (message not yet appended to session at context assembly time)
    expect(ctx.layers[2].content).toBe(""); // No background channels
  });
});
