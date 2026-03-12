/**
 * Tests for the compressed reference loop fix.
 *
 * Verifies that sync tool round-trips are accumulated across all rounds
 * so the LLM sees full results from every prior round, preventing
 * re-fetch loops when library_get stores compressed refs in the DB.
 *
 * @see workspace/docs/working/06_compressed-reference-loop.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus, enqueue, countPending } from "../bus.js";
import { initSessionTables } from "../session.js";
import { createAdapterRegistry, type ChannelAdapter } from "../channel-adapter.js";
import { startLoop, type CortexLoop } from "../loop.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { contextToMessages } from "../llm-caller.js";
import type { AssembledContext, ToolResultEntry } from "../context.js";

// ---------------------------------------------------------------------------
// Helpers
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

function makeBaseContext(overrides?: Partial<AssembledContext>): AssembledContext {
  return {
    layers: [
      { name: "system_floor", tokens: 10, content: "You are Scaff." },
      { name: "foreground", tokens: 10, content: "" },
      { name: "background", tokens: 0, content: "" },
      { name: "archived", tokens: 0, content: "" },
    ],
    totalTokens: 20,
    foregroundChannel: "webchat",
    foregroundMessages: [
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "serj", senderName: "Serj", content: "tell me about memory design", timestamp: "2026-03-11T17:24:00Z" },
    ],
    backgroundSummaries: new Map(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-refloop-test-"));
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
// 1. Unit: contextToMessages — toolRoundTrips (plural) appends ALL rounds
// ---------------------------------------------------------------------------

describe("contextToMessages: toolRoundTrips accumulation", () => {
  it("appends all rounds in order when toolRoundTrips is set", () => {
    const round0Content = [
      { type: "text", text: "Let me look that up." },
      { type: "tool_use", id: "tu_r0", name: "library_get", input: { id: 2 } },
    ];
    const round1Content = [
      { type: "text", text: "Let me also search code." },
      { type: "tool_use", id: "tu_r1", name: "code_search", input: { query: "memory" } },
    ];

    const context = makeBaseContext({
      toolRoundTrips: [
        {
          previousContent: round0Content,
          toolResults: [{ toolCallId: "tu_r0", toolName: "library_get", content: "Full library content for item 2: Always-On Memory Agent..." }],
        },
        {
          previousContent: round1Content,
          toolResults: [{ toolCallId: "tu_r1", toolName: "code_search", content: "Found 3 matches in src/cortex/..." }],
        },
      ],
    });

    const { messages } = contextToMessages(context);

    // Base message (user) + round 0 (assistant + user) + round 1 (assistant + user) = 5
    expect(messages.length).toBe(5);

    // Round 0 assistant (tool_use for library_get)
    const r0Asst = messages[1];
    expect(r0Asst.role).toBe("assistant");
    const r0AsstBlocks = r0Asst.content as any[];
    expect(r0AsstBlocks.some((b: any) => b.type === "tool_use" && b.name === "library_get")).toBe(true);

    // Round 0 user (tool_result with FULL content)
    const r0User = messages[2];
    expect(r0User.role).toBe("user");
    const r0UserBlocks = r0User.content as any[];
    expect(r0UserBlocks.some((b: any) =>
      b.type === "tool_result" && b.tool_use_id === "tu_r0" && b.content.includes("Always-On Memory Agent"),
    )).toBe(true);

    // Round 1 assistant (tool_use for code_search)
    const r1Asst = messages[3];
    expect(r1Asst.role).toBe("assistant");
    const r1AsstBlocks = r1Asst.content as any[];
    expect(r1AsstBlocks.some((b: any) => b.type === "tool_use" && b.name === "code_search")).toBe(true);

    // Round 1 user (tool_result with full content)
    const r1User = messages[4];
    expect(r1User.role).toBe("user");
    const r1UserBlocks = r1User.content as any[];
    expect(r1UserBlocks.some((b: any) =>
      b.type === "tool_result" && b.tool_use_id === "tu_r1" && b.content.includes("Found 3 matches"),
    )).toBe(true);
  });

  it("round 0 results are still visible in round 2+ context", () => {
    // Simulate 3 rounds of tool calls — the key scenario from the bug report
    const rounds = [
      {
        previousContent: [{ type: "tool_use", id: "tu_lib2", name: "library_get", input: { id: 2 } }],
        toolResults: [{ toolCallId: "tu_lib2", toolName: "library_get", content: "FULL CONTENT OF LIBRARY ITEM 2" }],
      },
      {
        previousContent: [{ type: "tool_use", id: "tu_cs", name: "code_search", input: { query: "x" } }],
        toolResults: [{ toolCallId: "tu_cs", toolName: "code_search", content: "code search results here" }],
      },
      {
        previousContent: [{ type: "tool_use", id: "tu_mq", name: "memory_query", input: { query: "design" } }],
        toolResults: [{ toolCallId: "tu_mq", toolName: "memory_query", content: "memory query results" }],
      },
    ];

    const context = makeBaseContext({ toolRoundTrips: rounds });
    const { messages } = contextToMessages(context);

    // All messages as a flat string for easy assertion
    const allContent = JSON.stringify(messages);

    // Round 0 library_get full content MUST be present (this was the bug)
    expect(allContent).toContain("FULL CONTENT OF LIBRARY ITEM 2");
    // Round 1 code_search results present
    expect(allContent).toContain("code search results here");
    // Round 2 memory_query results present
    expect(allContent).toContain("memory query results");
  });

  it("falls back to singular toolRoundTrip for backward compat", () => {
    const context = makeBaseContext({
      toolRoundTrip: {
        previousContent: [{ type: "tool_use", id: "tu_legacy", name: "fetch_chat_history", input: {} }],
        toolResults: [{ toolCallId: "tu_legacy", toolName: "fetch_chat_history", content: "legacy result" }],
      },
    });

    const { messages } = contextToMessages(context);
    const allContent = JSON.stringify(messages);
    expect(allContent).toContain("legacy result");
  });

  it("prefers toolRoundTrips (plural) over toolRoundTrip (singular)", () => {
    const context = makeBaseContext({
      // Both set — plural should win
      toolRoundTrip: {
        previousContent: [{ type: "tool_use", id: "tu_old", name: "library_get", input: {} }],
        toolResults: [{ toolCallId: "tu_old", toolName: "library_get", content: "SHOULD NOT APPEAR" }],
      },
      toolRoundTrips: [
        {
          previousContent: [{ type: "tool_use", id: "tu_new", name: "library_get", input: {} }],
          toolResults: [{ toolCallId: "tu_new", toolName: "library_get", content: "PLURAL WINS" }],
        },
      ],
    });

    const { messages } = contextToMessages(context);
    const allContent = JSON.stringify(messages);
    expect(allContent).toContain("PLURAL WINS");
    expect(allContent).not.toContain("SHOULD NOT APPEAR");
  });
});

// ---------------------------------------------------------------------------
// 2. Unit: loop.ts — allRoundTrips accumulates across rounds
// ---------------------------------------------------------------------------

describe("Loop: tool round-trip accumulation", () => {
  it("accumulates tool results across 3 sync rounds without re-fetching", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("tell me about memory design"));

    // Track what contexts the LLM receives
    const contexts: AssembledContext[] = [];
    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (ctx) => {
        contexts.push(ctx);
        callCount++;

        if (callCount === 1) {
          // Call 0: LLM wants to call fetch_chat_history (a sync tool)
          return {
            text: "",
            toolCalls: [{
              id: "tu_fch",
              name: "fetch_chat_history",
              arguments: { channel: "webchat", limit: 10 },
            }],
            _rawContent: [
              { type: "text", text: "Let me check history." },
              { type: "toolCall", id: "tu_fch", name: "fetch_chat_history", arguments: { channel: "webchat", limit: 10 } },
            ],
          };
        }
        if (callCount === 2) {
          // Call 1 (round 0): LLM sees fetch_chat_history result, now wants memory_query
          // Verify it received round 0's data
          expect(ctx.toolRoundTrips).toHaveLength(1);
          expect(ctx.toolRoundTrips![0].toolResults[0].toolName).toBe("fetch_chat_history");

          return {
            text: "",
            toolCalls: [{
              id: "tu_mq",
              name: "memory_query",
              arguments: { query: "memory design" },
            }],
            _rawContent: [
              { type: "text", text: "Let me check memory." },
              { type: "toolCall", id: "tu_mq", name: "memory_query", arguments: { query: "memory design" } },
            ],
          };
        }
        if (callCount === 3) {
          // Call 2 (round 1): LLM should see BOTH rounds' data
          expect(ctx.toolRoundTrips).toHaveLength(2);
          expect(ctx.toolRoundTrips![0].toolResults[0].toolName).toBe("fetch_chat_history");
          expect(ctx.toolRoundTrips![1].toolResults[0].toolName).toBe("memory_query");

          // Now return final answer — no more tool calls
          return { text: "Here is what I found about memory design.", toolCalls: [] };
        }

        return { text: "unexpected call", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(3000);
    await loop.stop();

    // 3 LLM calls: initial + round 0 + round 1 (final answer)
    expect(callCount).toBe(3);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Here is what I found about memory design.");

    // The final context (call 2) had both rounds accumulated
    const finalCtx = contexts[2];
    expect(finalCtx.toolRoundTrips).toHaveLength(2);
  }, 10000);

  it("single sync round works correctly (no regression)", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("what tasks are running?"));

    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (ctx) => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [{
              id: "tu_gts",
              name: "get_task_status",
              arguments: { taskId: "abc-123" },
            }],
            _rawContent: [
              { type: "toolCall", id: "tu_gts", name: "get_task_status", arguments: { taskId: "abc-123" } },
            ],
          };
        }
        // Call 2: LLM gets the result and answers
        expect(ctx.toolRoundTrips).toHaveLength(1);
        return { text: "Task abc-123 is complete.", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(2000);
    await loop.stop();

    expect(callCount).toBe(2);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Task abc-123 is complete.");
  }, 10000);

  it("no sync tools — zero rounds, no toolRoundTrips set", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("hello"));

    const contexts: AssembledContext[] = [];

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (ctx) => {
        contexts.push(ctx);
        return { text: "Hi!", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(500);
    await loop.stop();

    expect(contexts).toHaveLength(1);
    // No sync tools → toolRoundTrips should not be set
    expect(contexts[0].toolRoundTrips).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Integration: the exact freeze scenario from the bug report
// ---------------------------------------------------------------------------

describe("Integration: compressed reference loop prevention", () => {
  it("library_get in round 0 + another tool in round 1 → no re-fetch in round 2", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    enqueue(db, makeEnvelope("what do you have on memory design?"));

    const toolCallsByRound: string[][] = [];
    let callCount = 0;

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (ctx) => {
        callCount++;
        const roundTools: string[] = [];

        if (callCount === 1) {
          // Call 0: LLM calls library_get (simulating the original bug scenario)
          roundTools.push("library_get");
          toolCallsByRound.push(roundTools);
          return {
            text: "",
            toolCalls: [{
              id: "tu_lib",
              name: "library_get",
              arguments: { id: 2 },
            }],
            _rawContent: [
              { type: "toolCall", id: "tu_lib", name: "library_get", arguments: { id: 2 } },
            ],
          };
        }

        if (callCount === 2) {
          // Call 1 (round 0): LLM sees library_get result, also wants fetch_chat_history
          roundTools.push("fetch_chat_history");
          toolCallsByRound.push(roundTools);
          return {
            text: "",
            toolCalls: [{
              id: "tu_fch2",
              name: "fetch_chat_history",
              arguments: { channel: "webchat", limit: 5 },
            }],
            _rawContent: [
              { type: "toolCall", id: "tu_fch2", name: "fetch_chat_history", arguments: { channel: "webchat", limit: 5 } },
            ],
          };
        }

        if (callCount === 3) {
          // Call 2 (round 1): THE CRITICAL CHECK
          // With the fix, the LLM sees library_get results from round 0 in toolRoundTrips[0]
          // So it should NOT call library_get again
          const allContent = JSON.stringify(ctx.toolRoundTrips);
          expect(allContent).toContain("tu_lib"); // Round 0 library_get is present

          // LLM is satisfied — produces final answer
          toolCallsByRound.push(roundTools);
          return { text: "Based on the library item and chat history, here is what I know about memory design.", toolCalls: [] };
        }

        toolCallsByRound.push(roundTools);
        return { text: "unexpected", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(3000);
    await loop.stop();

    expect(callCount).toBe(3);
    // Verify library_get was only called ONCE (round 0), not re-fetched
    const allToolCalls = toolCallsByRound.flat();
    expect(allToolCalls.filter((t) => t === "library_get")).toHaveLength(1);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("memory design");
  }, 10000);
});
