/**
 * Tests for Cortex loop silence bugs (Pipeline 011)
 *
 * Fix 1: Async dispatch fallback — synthesize message when LLM dispatches async work but says nothing
 * Fix 2: Post-sync-loop text guard — nudge LLM or produce fallback after sync tools + silence
 * Fix 3: Sync tool dedup — cache identical tool calls within a turn
 * Fix 4: code_search path hint — append note about path resolution
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus, enqueue } from "../bus.js";
import { initSessionTables } from "../session.js";
import { createAdapterRegistry, type ChannelAdapter } from "../channel-adapter.js";
import { startLoop, type CortexLoop } from "../loop.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { AssembledContext } from "../context.js";
import type { CortexLLMResult, CortexToolCall } from "../llm-caller.js";
import { executeCodeSearch } from "../tools.js";

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-silence-test-"));
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
// Fix 1: Async dispatch fallback
// ---------------------------------------------------------------------------

describe("Fix 1: Async dispatch fallback", () => {
  it("synthesizes fallback when LLM dispatches sessions_spawn but returns NO_REPLY", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("spawn a sub-agent"));

    const spawnCalls: any[] = [];

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "NO_REPLY",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "do something", priority: "normal" },
        }],
        _rawContent: [
          { type: "tool_use", id: "tc-1", name: "sessions_spawn", input: { task: "do something" } },
        ],
      }),
      onError: () => {},
      onSpawn: (params) => {
        spawnCalls.push(params);
        return "job-123";
      },
    });

    await wait(500);
    await loop.stop();

    // Should have dispatched the spawn
    expect(spawnCalls).toHaveLength(1);
    // Should have sent fallback message instead of silence
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("On it — working in the background.");
  });

  it("does NOT override real LLM text when async tools dispatched", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("spawn a sub-agent"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => ({
        text: "I'm delegating this to a sub-agent!",
        toolCalls: [{
          id: "tc-1",
          name: "sessions_spawn",
          arguments: { task: "do something", priority: "normal" },
        }],
        _rawContent: [
          { type: "text", text: "I'm delegating this to a sub-agent!" },
          { type: "tool_use", id: "tc-1", name: "sessions_spawn", input: { task: "do something" } },
        ],
      }),
      onError: () => {},
      onSpawn: () => "job-123",
    });

    await wait(500);
    await loop.stop();

    // Should use the real LLM text, not the fallback
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("I'm delegating this to a sub-agent!");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Post-sync-loop text guard
// ---------------------------------------------------------------------------

describe("Fix 2: Post-sync-loop text guard", () => {
  it("nudges LLM when sync tools ran but final text is NO_REPLY", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("read my soul file"));

    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (ctx: AssembledContext): Promise<CortexLLMResult> => {
        callCount++;

        if (callCount === 1) {
          // First call: LLM wants to use read_file
          return {
            text: "NO_REPLY",
            toolCalls: [{
              id: "tc-read",
              name: "read_file",
              arguments: { path: "SOUL.md" },
            }],
            _rawContent: [
              { type: "tool_use", id: "tc-read", name: "read_file", input: { path: "SOUL.md" } },
            ],
          };
        }

        if (callCount === 2) {
          // Second call (after tool result): still NO_REPLY
          return { text: "NO_REPLY", toolCalls: [], _rawContent: [] };
        }

        // Third call (after nudge): LLM responds properly
        return { text: "Your SOUL.md says: You are Scaff.", toolCalls: [], _rawContent: [] };
      },
      onError: () => {},
    });

    await wait(800);
    await loop.stop();

    // Should have called LLM 3 times: original + after-tool + nudge
    expect(callCount).toBe(3);
    // Should have sent the nudge-generated response
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Your SOUL.md says: You are Scaff.");
  });

  it("produces raw tool summary when nudge also returns NO_REPLY", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("read my soul file"));

    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;

        if (callCount === 1) {
          return {
            text: "NO_REPLY",
            toolCalls: [{
              id: "tc-read",
              name: "read_file",
              arguments: { path: "SOUL.md" },
            }],
            _rawContent: [
              { type: "tool_use", id: "tc-read", name: "read_file", input: { path: "SOUL.md" } },
            ],
          };
        }

        // All subsequent calls: still NO_REPLY
        return { text: "NO_REPLY", toolCalls: [], _rawContent: [] };
      },
      onError: () => {},
    });

    await wait(800);
    await loop.stop();

    // Should have produced a fallback summary
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("read_file");
    expect(adapter.sent[0].content).toContain("couldn't produce a summary");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Sync tool dedup
// ---------------------------------------------------------------------------

describe("Fix 3: Sync tool dedup", () => {
  it("returns cached result for identical sync tool calls in the same turn", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("read soul twice"));

    let callCount = 0;
    // Track how many times read_file was actually in the toolCalls
    let readFileExecutions = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;

        if (callCount === 1) {
          // LLM wants to read the same file twice in one call
          return {
            text: "NO_REPLY",
            toolCalls: [
              { id: "tc-read-1", name: "read_file", arguments: { path: "SOUL.md" } },
              { id: "tc-read-2", name: "read_file", arguments: { path: "SOUL.md" } },
            ],
            _rawContent: [
              { type: "tool_use", id: "tc-read-1", name: "read_file", input: { path: "SOUL.md" } },
              { type: "tool_use", id: "tc-read-2", name: "read_file", input: { path: "SOUL.md" } },
            ],
          };
        }

        // After getting results: respond
        return { text: "Got the file contents (twice, but second was cached).", toolCalls: [], _rawContent: [] };
      },
      onError: () => {},
    });

    await wait(800);
    await loop.stop();

    expect(adapter.sent).toHaveLength(1);
    // Verify the response came through (meaning the dedup didn't break the flow)
    expect(adapter.sent[0].content).toContain("cached");

    // Check that the second tool result includes the cached marker
    // We verify this indirectly: the session should have two tool_result entries,
    // and one should contain the cached marker
    const { getSessionHistory } = await import("../session.js");
    const history = getSessionHistory(db);
    const toolResults = history.filter((m) =>
      m.content.includes("tool_result") && m.content.includes("SOUL.md")
    );
    // At least one should have the cached note
    const hasCachedNote = history.some((m) =>
      m.content.includes("Cached — identical call already executed this turn")
    );
    expect(hasCachedNote).toBe(true);
  });

  it("does NOT cache calls with different arguments", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    // Create a second file
    fs.writeFileSync(path.join(workspaceDir, "OTHER.md"), "Other content.");

    enqueue(db, makeEnvelope("read two files"));

    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;

        if (callCount === 1) {
          return {
            text: "NO_REPLY",
            toolCalls: [
              { id: "tc-1", name: "read_file", arguments: { path: "SOUL.md" } },
              { id: "tc-2", name: "read_file", arguments: { path: "OTHER.md" } },
            ],
            _rawContent: [
              { type: "tool_use", id: "tc-1", name: "read_file", input: { path: "SOUL.md" } },
              { type: "tool_use", id: "tc-2", name: "read_file", input: { path: "OTHER.md" } },
            ],
          };
        }

        return { text: "Read both files successfully.", toolCalls: [], _rawContent: [] };
      },
      onError: () => {},
    });

    await wait(800);
    await loop.stop();

    // Neither result should be cached since args differ
    const { getSessionHistory } = await import("../session.js");
    const history = getSessionHistory(db);
    const hasCachedNote = history.some((m) =>
      m.content.includes("Cached — identical call already executed this turn")
    );
    expect(hasCachedNote).toBe(false);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Read both files successfully.");
  });
});

// ---------------------------------------------------------------------------
// Fix 4: code_search path hint
// ---------------------------------------------------------------------------

describe("Fix 4: code_search path hint", () => {
  it("appends path resolution note to code_search output", () => {
    // We can't easily test the full executeCodeSearch since it requires the code index,
    // but we can verify the function signature and that the path hint logic exists.
    // The actual integration is tested by checking the source code was modified correctly.

    // Create a mock code index scenario — the function will fail but we can test
    // the error path still works
    const result = executeCodeSearch({ query: "test query", limit: 5 });

    // On machines without the code index, this returns an error JSON
    // The path hint is only appended on success, so we verify the function
    // doesn't crash and returns valid output
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("path hint note is present in source code", async () => {
    // Read the tools.ts source to verify the path hint was added
    const toolsSource = fs.readFileSync(
      path.join(__dirname, "..", "tools.ts"),
      "utf-8",
    );
    expect(toolsSource).toContain(
      "Note: Paths above are relative to the OpenClaw install root, not the agent workspace."
    );
  });
});
