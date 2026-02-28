/**
 * Hippocampus Phase 2 — Context Manager & The 4 Layers
 *
 * Tests for hot memory injection (Layer 1), foreground soft caps (Layer 2),
 * background 24h idle exclusion (Layer 3), and full context assembly E2E.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import {
  initSessionTables,
  appendToSession,
  updateChannelState,
  addPendingOp,
} from "../session.js";
import { initHotMemoryTable, insertHotFact, touchHotFact } from "../hippocampus.js";
import {
  loadSystemFloor,
  buildForeground,
  buildBackground,
  assembleContext,
  FOREGROUND_SOFT_CAP_MESSAGES,
  FOREGROUND_SOFT_CAP_TOKENS,
  BACKGROUND_MAX_IDLE_HOURS,
} from "../context.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hippo-ctx-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
  initHotMemoryTable(db);
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedWorkspace() {
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff. Direct, competent.");
  fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "Name: Scaff");
  fs.writeFileSync(path.join(workspaceDir, "USER.md"), "Name: Serj");
}

function makeEnvelope(channel = "webchat", content = "test") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

// ---------------------------------------------------------------------------
// Layer 1: System Floor — Hot Memory Injection
// ---------------------------------------------------------------------------

describe("Layer 1: System Floor with hot facts", () => {
  it("includes hot facts in system floor", async () => {
    seedWorkspace();
    insertHotFact(db, { factText: "Serj prefers dark mode" });
    insertHotFact(db, { factText: "Serj's timezone is PST" });

    const { getTopHotFacts } = await import("../hippocampus.js");
    const hotFacts = getTopHotFacts(db, 50);

    const layer = await loadSystemFloor(workspaceDir, [], hotFacts);
    expect(layer.content).toContain("Known Facts");
    expect(layer.content).toContain("Serj prefers dark mode");
    expect(layer.content).toContain("Serj's timezone is PST");
  });

  it("limits hot facts to exactly 50 items", async () => {
    seedWorkspace();
    // Insert 60 facts
    for (let i = 0; i < 60; i++) {
      insertHotFact(db, { factText: `fact number ${i}` });
    }

    const { getTopHotFacts } = await import("../hippocampus.js");
    const hotFacts = getTopHotFacts(db, 50);

    expect(hotFacts).toHaveLength(50);

    const layer = await loadSystemFloor(workspaceDir, [], hotFacts);
    expect(layer.content).toContain("Known Facts");
    // Count bullet points
    const bulletCount = (layer.content.match(/^- /gm) || []).length;
    expect(bulletCount).toBe(50);
  });

  it("sorts hot facts by hit_count DESC then last_accessed_at DESC", async () => {
    seedWorkspace();
    const lowId = insertHotFact(db, { factText: "low priority fact" });
    const highId = insertHotFact(db, { factText: "high priority fact" });

    // Bump high priority to 5 hits
    for (let i = 0; i < 5; i++) touchHotFact(db, highId);

    const { getTopHotFacts } = await import("../hippocampus.js");
    const hotFacts = getTopHotFacts(db, 50);

    expect(hotFacts[0].factText).toBe("high priority fact");
    expect(hotFacts[1].factText).toBe("low priority fact");

    const layer = await loadSystemFloor(workspaceDir, [], hotFacts);
    // High priority should appear before low priority in the content
    const highIdx = layer.content.indexOf("high priority fact");
    const lowIdx = layer.content.indexOf("low priority fact");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("omits Known Facts section when no hot facts", async () => {
    seedWorkspace();
    const layer = await loadSystemFloor(workspaceDir, [], []);
    expect(layer.content).not.toContain("Known Facts");
  });

  it("omits Known Facts section when hotFacts param is undefined", async () => {
    seedWorkspace();
    const layer = await loadSystemFloor(workspaceDir, []);
    expect(layer.content).not.toContain("Known Facts");
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Foreground Soft Cap
// ---------------------------------------------------------------------------

describe("Layer 2: Foreground soft cap", () => {
  it("truncates to FOREGROUND_SOFT_CAP_MESSAGES when softCap enabled", () => {
    // Insert 50 messages
    for (let i = 0; i < 50; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const { messages } = buildForeground(db, "webchat", 100000, { softCap: true });
    expect(messages.length).toBeLessThanOrEqual(FOREGROUND_SOFT_CAP_MESSAGES);
  });

  it("does NOT apply message cap when softCap disabled", () => {
    // Insert 50 short messages that fit in a large budget
    for (let i = 0; i < 50; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const { messages } = buildForeground(db, "webchat", 100000);
    expect(messages.length).toBe(50);
  });

  it("respects token cap of FOREGROUND_SOFT_CAP_TOKENS", () => {
    // Insert messages with enough text to exceed 4000 tokens
    for (let i = 0; i < 10; i++) {
      appendToSession(db, makeEnvelope("webchat", "x".repeat(2000))); // ~500 tokens each
    }

    const { layer } = buildForeground(db, "webchat", 100000, { softCap: true });
    expect(layer.tokens).toBeLessThanOrEqual(FOREGROUND_SOFT_CAP_TOKENS);
  });

  it("keeps most recent messages when truncating", () => {
    for (let i = 0; i < 50; i++) {
      appendToSession(db, makeEnvelope("webchat", `message ${i}`));
    }

    const { messages } = buildForeground(db, "webchat", 100000, { softCap: true });
    // Should contain the most recent messages (highest indices)
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.content).toBe("message 49");
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Background 24h Idle Exclusion
// ---------------------------------------------------------------------------

describe("Layer 3: Background idle exclusion", () => {
  it("excludes channels idle >24h when idleCutoff enabled", () => {
    const now = new Date();
    const recentTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const oldTime = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

    updateChannelState(db, "whatsapp", {
      lastMessageAt: recentTime.toISOString(),
      summary: "recent chat",
      layer: "background",
    });
    updateChannelState(db, "telegram", {
      lastMessageAt: oldTime.toISOString(),
      summary: "old chat",
      layer: "background",
    });

    const layer = buildBackground(db, "webchat", { idleCutoff: true });
    expect(layer.content).toContain("[whatsapp]");
    expect(layer.content).toContain("recent chat");
    expect(layer.content).not.toContain("[telegram]");
    expect(layer.content).not.toContain("old chat");
  });

  it("includes all non-archived channels when idleCutoff disabled", () => {
    const now = new Date();
    const oldTime = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

    updateChannelState(db, "whatsapp", {
      lastMessageAt: now.toISOString(),
      summary: "recent chat",
      layer: "background",
    });
    updateChannelState(db, "telegram", {
      lastMessageAt: oldTime.toISOString(),
      summary: "old chat",
      layer: "background",
    });

    const layer = buildBackground(db, "webchat");
    expect(layer.content).toContain("[whatsapp]");
    expect(layer.content).toContain("[telegram]");
  });

  it("channels exactly at 24h boundary are included", () => {
    const now = new Date();
    // Just under 24h — should be included
    const borderline = new Date(now.getTime() - (BACKGROUND_MAX_IDLE_HOURS * 60 * 60 * 1000) + 60000);

    updateChannelState(db, "discord", {
      lastMessageAt: borderline.toISOString(),
      summary: "borderline chat",
      layer: "background",
    });

    const layer = buildBackground(db, "webchat", { idleCutoff: true });
    expect(layer.content).toContain("[discord]");
  });

  it("still excludes archived channels regardless of idleCutoff", () => {
    const now = new Date();

    updateChannelState(db, "signal", {
      lastMessageAt: now.toISOString(),
      summary: "archived but recent",
      layer: "archived",
    });

    const layer = buildBackground(db, "webchat", { idleCutoff: true });
    expect(layer.content).not.toContain("[signal]");
  });
});

// ---------------------------------------------------------------------------
// E2E: Full Context Assembly with Hippocampus
// ---------------------------------------------------------------------------

describe("Phase 2 E2E: context assembly with hippocampus", () => {
  it("assembles all layers correctly with hippocampus enabled", async () => {
    seedWorkspace();

    // Seed hot memories
    const factId = insertHotFact(db, { factText: "Serj likes TypeScript" });
    touchHotFact(db, factId); // bump hit count
    insertHotFact(db, { factText: "Serj uses Neovim" });

    // Seed a pending operation
    addPendingOp(db, {
      id: "job-42",
      type: "router_job",
      description: "Analyze codebase",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    // Seed a long foreground conversation (30 messages)
    for (let i = 0; i < 30; i++) {
      appendToSession(db, makeEnvelope("webchat", `conversation message ${i}`));
    }

    // Seed background channels — one recent, one old
    const now = new Date();
    updateChannelState(db, "whatsapp", {
      lastMessageAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
      summary: "Serj asked about dinner plans",
      layer: "background",
    });
    updateChannelState(db, "telegram", {
      lastMessageAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      summary: "Old group banter",
      layer: "background",
    });

    const env = makeEnvelope("webchat", "latest message");
    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 200000,
      hippocampusEnabled: true,
    });

    // Layer 1: System Floor — identity + pending ops + hot facts
    const floor = ctx.layers[0];
    expect(floor.name).toBe("system_floor");
    expect(floor.content).toContain("Scaff"); // SOUL.md
    expect(floor.content).toContain("Analyze codebase"); // pending op
    expect(floor.content).toContain("Serj likes TypeScript"); // hot fact
    expect(floor.content).toContain("Serj uses Neovim"); // hot fact
    expect(floor.content).toContain("Known Facts"); // section header

    // Layer 2: Foreground — soft-capped to ≤20 messages
    const fg = ctx.layers[1];
    expect(fg.name).toBe("foreground");
    expect(ctx.foregroundMessages.length).toBeLessThanOrEqual(FOREGROUND_SOFT_CAP_MESSAGES);
    // Should include the most recent messages
    expect(fg.content).toContain("conversation message 29");

    // Layer 3: Background — only recent channel (whatsapp), not old (telegram)
    const bg = ctx.layers[2];
    expect(bg.name).toBe("background");
    expect(bg.content).toContain("[whatsapp]");
    expect(bg.content).toContain("dinner plans");
    expect(bg.content).not.toContain("[telegram]");
    expect(bg.content).not.toContain("Old group banter");

    // Pending ops in context
    expect(ctx.pendingOps).toHaveLength(1);
    expect(ctx.pendingOps[0].id).toBe("job-42");
  });

  it("falls back to pre-hippocampus behavior when disabled", async () => {
    seedWorkspace();

    // Seed hot memories (should be ignored)
    insertHotFact(db, { factText: "This should NOT appear" });

    // Seed 30 foreground messages
    for (let i = 0; i < 30; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    // Seed old background channel
    updateChannelState(db, "telegram", {
      lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      summary: "Old chat (should appear when hippocampus disabled)",
      layer: "background",
    });

    const env = makeEnvelope("webchat", "latest");
    const ctx = await assembleContext({
      db,
      triggerEnvelope: env,
      workspaceDir,
      maxTokens: 200000,
      hippocampusEnabled: false,
    });

    // Layer 1: NO hot facts
    expect(ctx.layers[0].content).not.toContain("Known Facts");
    expect(ctx.layers[0].content).not.toContain("This should NOT appear");

    // Layer 2: NO soft cap — all 30 messages included
    expect(ctx.foregroundMessages).toHaveLength(30);

    // Layer 3: Old telegram channel IS included (no idle cutoff)
    expect(ctx.layers[2].content).toContain("[telegram]");
  });
});
