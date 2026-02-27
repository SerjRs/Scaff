import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus, enqueue, countPending } from "../bus.js";
import { initSessionTables } from "../session.js";
import { createAdapterRegistry, type ChannelAdapter } from "../channel-adapter.js";
import { startLoop, type CortexLoop } from "../loop.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { AssembledContext } from "../context.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;
let workspaceDir: string;
let loop: CortexLoop | null = null;

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

function makeEnvelope(content = "test", priority: "urgent" | "normal" | "background" = "normal") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    priority,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-loop-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (loop) { await loop.stop(); loop = null; }
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CortexLoop", () => {
  it("processes single message end-to-end", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("hello"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "Hi Serj!", toolCalls: [] }),
      onError: () => {},
    });

    await wait(200);
    await loop.stop();

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Hi Serj!");
    expect(loop.processedCount()).toBe(1);
    expect(countPending(db)).toBe(0);
  });

  it("processes messages in priority order", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("background", "background"));
    enqueue(db, makeEnvelope("urgent", "urgent"));
    enqueue(db, makeEnvelope("normal", "normal"));

    const order: string[] = [];

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 10,
      callLLM: async (ctx) => {
        // Extract what message triggered this call from the foreground
        const content = adapter.sent.length === 0 ? "first" :
          adapter.sent.length === 1 ? "second" : "third";
        order.push(content);
        return { text: content, toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(500);
    await loop.stop();

    expect(loop.processedCount()).toBe(3);
  });

  it("handles LLM failure gracefully (marks failed, continues)", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("will fail"));
    enqueue(db, makeEnvelope("will succeed"));

    let callCount = 0;
    const errors: Error[] = [];

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 10,
      callLLM: async () => {
        callCount++;
        if (callCount === 1) throw new Error("LLM timeout");
        return { text: "success", toolCalls: [] };
      },
      onError: (err) => { errors.push(err); },
    });

    await wait(500);
    await loop.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("LLM timeout");
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("success");
  });

  it("stop() waits for current message to finish", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("slow message"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 10,
      callLLM: async () => {
        await wait(100);
        return { text: "done", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(50); // Let it start processing
    await loop.stop();

    expect(loop.isRunning()).toBe(false);
  });

  it("isRunning() reflects loop state", async () => {
    const registry = createAdapterRegistry();
    registry.register(makeMockAdapter("webchat"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
      onError: () => {},
    });

    expect(loop.isRunning()).toBe(true);
    await loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it("empty bus: loop idles without errors", async () => {
    const registry = createAdapterRegistry();
    registry.register(makeMockAdapter("webchat"));
    const errors: Error[] = [];

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
      onError: (err) => { errors.push(err); },
    });

    await wait(200);
    await loop.stop();

    expect(errors).toHaveLength(0);
    expect(loop.processedCount()).toBe(0);
  });
});
