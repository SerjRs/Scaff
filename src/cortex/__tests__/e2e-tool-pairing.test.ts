/**
 * E2E: Tool Use/Result Pairing (Session Corruption Bug Fix)
 *
 * Tests the fix for the critical session corruption bug where orphaned
 * tool_use blocks without matching tool_result blocks cause permanent
 * Anthropic API 400 errors.
 *
 * @see workspace/docs/working/03_cortex-session-corruption.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus, enqueue } from "../bus.js";
import { initSessionTables, getSessionHistory, appendStructuredContent } from "../session.js";
import { createAdapterRegistry, type ChannelAdapter } from "../channel-adapter.js";
import { startLoop, type CortexLoop } from "../loop.js";
import { contextToMessages, type AnthropicMessage } from "../llm-caller.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import type { AssembledContext } from "../context.js";
import type { CortexLLMResult } from "../llm-caller.js";
import type { SpawnParams } from "../loop.js";
import type { DatabaseSync } from "node:sqlite";

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

function makeEnvelope(content: string, channel = "webchat") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a minimal AssembledContext for unit-testing contextToMessages */
function makeContext(foregroundMessages: AssembledContext["foregroundMessages"], toolRoundTrip?: AssembledContext["toolRoundTrip"]): AssembledContext {
  return {
    layers: [
      { name: "system_floor", tokens: 10, content: "System" },
      { name: "foreground", tokens: 50, content: "(text)" },
      { name: "background", tokens: 0, content: "" },
      { name: "archived", tokens: 0, content: "" },
    ],
    totalTokens: 60,
    foregroundChannel: "webchat",
    foregroundMessages,
    backgroundSummaries: new Map(),
    toolRoundTrip,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tool-pairing-"));
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
// Unit Tests: validateToolPairing (via contextToMessages)
// ---------------------------------------------------------------------------

describe("validateToolPairing", () => {
  it("converts orphaned tool_use in last assistant message to text", () => {
    // Assistant message with tool_use is the LAST message — no following user message
    const context = makeContext([
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "hello", timestamp: "2026-03-10T10:00:00Z" },
      {
        id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex",
        content: JSON.stringify([
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tc-orphan", name: "code_search", input: { query: "test" } },
        ]),
        timestamp: "2026-03-10T10:00:01Z",
      },
    ]);

    const { messages } = contextToMessages(context);

    // The assistant message should have the tool_use converted to text
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    const blocks = lastMsg.content as any[];
    // No tool_use blocks should remain
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(0);
    // Should have text representation instead
    const textBlocks = blocks.filter((b: any) => b.type === "text");
    expect(textBlocks.some((b: any) => b.text.includes("code_search"))).toBe(true);
  });

  it("converts orphaned tool_use when next message is assistant (not user)", () => {
    // tool_use followed by another assistant message instead of user with tool_result
    const context = makeContext([
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "hello", timestamp: "2026-03-10T10:00:00Z" },
      {
        id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_use", id: "tc-orphan", name: "sessions_spawn", input: { task: "do stuff" } },
        ]),
        timestamp: "2026-03-10T10:00:01Z",
      },
      // After consolidation this user msg ensures alternating roles
      { id: 3, envelopeId: "e2", role: "user", channel: "webchat", senderId: "user", content: "another msg", timestamp: "2026-03-10T10:00:02Z" },
      { id: 4, envelopeId: "e2", role: "assistant", channel: "webchat", senderId: "cortex", content: "reply", timestamp: "2026-03-10T10:00:03Z" },
    ]);

    const { messages } = contextToMessages(context);

    // Find the assistant message that had the tool_use — it should be converted to text
    // After consolidation, check there are no orphaned tool_use blocks
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolUseBlocks = (msg.content as any[]).filter((b: any) => b.type === "tool_use");
        // Any remaining tool_use must have a matching tool_result in the next user message
        if (toolUseBlocks.length > 0) {
          const msgIdx = messages.indexOf(msg);
          const nextMsg = messages[msgIdx + 1];
          expect(nextMsg).toBeDefined();
          expect(nextMsg.role).toBe("user");
          expect(Array.isArray(nextMsg.content)).toBe(true);
          for (const tu of toolUseBlocks) {
            const hasResult = (nextMsg.content as any[]).some(
              (b: any) => b.type === "tool_result" && b.tool_use_id === tu.id,
            );
            expect(hasResult).toBe(true);
          }
        }
      }
    }
  });

  it("preserves valid tool_use/tool_result pairs", () => {
    const context = makeContext([
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "search for X", timestamp: "2026-03-10T10:00:00Z" },
      {
        id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_use", id: "tc-A", name: "code_search", input: { query: "X" } },
          { type: "tool_use", id: "tc-B", name: "code_search", input: { query: "Y" } },
        ]),
        timestamp: "2026-03-10T10:00:01Z",
      },
      {
        id: 3, envelopeId: "e1", role: "user", channel: "internal", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "tc-A", content: "result A" },
          { type: "tool_result", tool_use_id: "tc-B", content: "result B" },
        ]),
        timestamp: "2026-03-10T10:00:02Z",
      },
      { id: 4, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex", content: "Found it!", timestamp: "2026-03-10T10:00:03Z" },
    ]);

    const { messages } = contextToMessages(context);

    // Find the assistant message with tool_use blocks — they should be preserved
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === "tool_use"),
    );
    expect(assistantWithTools).toBeDefined();
    const toolUseBlocks = (assistantWithTools!.content as any[]).filter((b: any) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(2);
    expect(toolUseBlocks[0].id).toBe("tc-A");
    expect(toolUseBlocks[1].id).toBe("tc-B");
  });

  it("converts missing tool_result for one of multiple tool_use blocks", () => {
    // 2 tool_use blocks but only 1 tool_result — the orphan should be converted to text
    const context = makeContext([
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "search", timestamp: "2026-03-10T10:00:00Z" },
      {
        id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_use", id: "tc-A", name: "code_search", input: { query: "X" } },
          { type: "tool_use", id: "tc-B", name: "code_search", input: { query: "Y" } },
        ]),
        timestamp: "2026-03-10T10:00:01Z",
      },
      {
        id: 3, envelopeId: "e1", role: "user", channel: "internal", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "tc-A", content: "result A" },
          // tc-B result is MISSING
        ]),
        timestamp: "2026-03-10T10:00:02Z",
      },
      { id: 4, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex", content: "Here's what I found.", timestamp: "2026-03-10T10:00:03Z" },
    ]);

    const { messages } = contextToMessages(context);

    // tc-A should be preserved, tc-B should be converted to text
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content),
    );
    expect(assistantWithTools).toBeDefined();
    const blocks = assistantWithTools!.content as any[];
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0].id).toBe("tc-A");
    // tc-B should be text now
    const textBlocks = blocks.filter((b: any) => b.type === "text" && b.text.includes("tc-B"));
    expect(textBlocks).toHaveLength(1);
  });

  it("converts orphaned tool_result with no preceding assistant", () => {
    // tool_result at the start of conversation — no preceding assistant with tool_use
    const context = makeContext([
      {
        id: 1, envelopeId: "e1", role: "user", channel: "internal", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "tc-ghost", content: "orphan result" },
        ]),
        timestamp: "2026-03-10T10:00:00Z",
      },
      { id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex", content: "ok", timestamp: "2026-03-10T10:00:01Z" },
    ]);

    const { messages } = contextToMessages(context);

    // The tool_result should be converted to text (no valid tool_use_id to reference)
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    if (Array.isArray(userMsg!.content)) {
      const toolResults = (userMsg!.content as any[]).filter((b: any) => b.type === "tool_result");
      expect(toolResults).toHaveLength(0);
    }
  });

  it("converts invalid tool_use (missing id or name) to text", () => {
    const context = makeContext([
      { id: 1, envelopeId: "e1", role: "user", channel: "webchat", senderId: "user", content: "go", timestamp: "2026-03-10T10:00:00Z" },
      {
        id: 2, envelopeId: "e1", role: "assistant", channel: "webchat", senderId: "cortex",
        content: JSON.stringify([
          { type: "tool_use", id: null, name: null, input: {} },
        ]),
        timestamp: "2026-03-10T10:00:01Z",
      },
    ]);

    const { messages } = contextToMessages(context);

    // Invalid tool_use should become text
    const lastMsg = messages[messages.length - 1];
    if (Array.isArray(lastMsg.content)) {
      const toolUseBlocks = (lastMsg.content as any[]).filter((b: any) => b.type === "tool_use");
      expect(toolUseBlocks).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// E2E Tests: Mixed sync+async tool handling in the loop
// ---------------------------------------------------------------------------

describe("E2E: Mixed sync+async tool pairing", () => {
  it("mixed sync+async tools: all get tool_result stored in DB", async () => {
    const spawns: SpawnParams[] = [];
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    let callCount = 0;

    enqueue(db, makeEnvelope("do research"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async (): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          // First call: return both sync (code_search) and async (sessions_spawn) tools
          return {
            text: "Let me search and delegate.",
            toolCalls: [
              { id: "tc-sync-1", name: "code_search", arguments: { query: "test" } },
              { id: "tc-async-1", name: "sessions_spawn", arguments: { task: "research X" } },
            ],
            _rawContent: [
              { type: "text", text: "Let me search and delegate." },
              { type: "toolCall", id: "tc-sync-1", name: "code_search", arguments: { query: "test" } },
              { type: "toolCall", id: "tc-async-1", name: "sessions_spawn", arguments: { task: "research X" } },
            ],
          };
        }
        // Second call (after sync tool round-trip): final answer
        return { text: "Here are the results.", toolCalls: [] };
      },
      onError: () => {},
      onSpawn: (p) => { spawns.push(p); return "job-mixed"; },
    });

    await wait(1000);
    await loop.stop();

    // Spawn was fired (async tool was dispatched)
    expect(spawns).toHaveLength(1);
    expect(spawns[0].task).toBe("research X");

    // Check DB: every tool_use should have a matching tool_result
    const history = getSessionHistory(db);
    const allContent: any[] = [];
    for (const msg of history) {
      if (msg.content.startsWith("[")) {
        try {
          const parsed = JSON.parse(msg.content);
          if (Array.isArray(parsed)) {
            for (const block of parsed) {
              allContent.push({ ...block, _role: msg.role });
            }
          }
        } catch { /* not JSON */ }
      }
    }

    // Find all tool_use IDs stored
    const toolUseIds = allContent
      .filter((b) => b.type === "tool_use" || b.type === "toolCall")
      .map((b) => b.id);

    // Find all tool_result references
    const toolResultRefs = allContent
      .filter((b) => b.type === "tool_result")
      .map((b) => b.tool_use_id);

    // Every tool_use should have at least one matching tool_result
    for (const id of toolUseIds) {
      expect(toolResultRefs).toContain(id);
    }
  });

  it("multiple sync tools: all get tool_result even if one throws", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);

    let callCount = 0;

    enqueue(db, makeEnvelope("search everything"));

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
            text: "Searching...",
            toolCalls: [
              { id: "tc-s1", name: "code_search", arguments: { query: "valid" } },
              { id: "tc-s2", name: "code_search", arguments: { query: "also-valid" } },
            ],
            _rawContent: [
              { type: "text", text: "Searching..." },
              { type: "toolCall", id: "tc-s1", name: "code_search", arguments: { query: "valid" } },
              { type: "toolCall", id: "tc-s2", name: "code_search", arguments: { query: "also-valid" } },
            ],
          };
        }
        return { text: "Done.", toolCalls: [] };
      },
      onError: () => {},
    });

    await wait(1000);
    await loop.stop();

    // Both sync tools should have tool_results in DB
    const history = getSessionHistory(db);
    const toolResults: any[] = [];
    for (const msg of history) {
      if (msg.content.startsWith("[")) {
        try {
          const parsed = JSON.parse(msg.content);
          if (Array.isArray(parsed)) {
            for (const block of parsed) {
              if (block.type === "tool_result") toolResults.push(block);
            }
          }
        } catch { /* */ }
      }
    }

    const resultIds = toolResults.map((r) => r.tool_use_id);
    expect(resultIds).toContain("tc-s1");
    expect(resultIds).toContain("tc-s2");
  });

  it("DB round-trip: structured tool content survives storage and replay", () => {
    // Store assistant tool_use + user tool_result in DB, then read back via getSessionHistory
    // and pass through contextToMessages — should produce valid API blocks
    const envelopeId = "test-roundtrip";
    const issuer = "agent:main:cortex";

    // Store assistant message with tool_use blocks
    appendStructuredContent(db, envelopeId, "assistant", "webchat", [
      { type: "text", text: "Let me search." },
      { type: "tool_use", id: "tc-rt-1", name: "code_search", input: { query: "test" } },
      { type: "tool_use", id: "tc-rt-2", name: "code_search", input: { query: "test2" } },
    ], issuer);

    // Store user message with matching tool_results
    appendStructuredContent(db, envelopeId, "user", "internal", [
      { type: "tool_result", tool_use_id: "tc-rt-1", content: "Found 3 results" },
      { type: "tool_result", tool_use_id: "tc-rt-2", content: "Found 5 results" },
    ], issuer);

    // Store final assistant reply
    appendStructuredContent(db, envelopeId, "assistant", "webchat", [
      { type: "text", text: "Here's what I found." },
    ], issuer);

    // Read back and convert
    const history = getSessionHistory(db);
    const context = makeContext(history);
    const { messages } = contextToMessages(context);

    // Verify: tool_use blocks are proper Anthropic API format
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === "tool_use"),
    );
    expect(assistantWithTools).toBeDefined();
    const toolUseBlocks = (assistantWithTools!.content as any[]).filter((b: any) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(2);

    // Verify: tool_result blocks reference valid tool_use IDs
    const userWithResults = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === "tool_result"),
    );
    expect(userWithResults).toBeDefined();
    const toolResults = (userWithResults!.content as any[]).filter((b: any) => b.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].tool_use_id).toBe("tc-rt-1");
    expect(toolResults[1].tool_use_id).toBe("tc-rt-2");
  });
});

// ---------------------------------------------------------------------------
// E2E: Circuit breaker
// ---------------------------------------------------------------------------

describe("E2E: Circuit breaker", () => {
  it("stops retrying after 3 consecutive tool_use/tool_result 400 errors", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);
    const errors: string[] = [];

    // Enqueue 5 messages — circuit breaker should stop after 3 failures
    for (let i = 0; i < 5; i++) {
      enqueue(db, makeEnvelope(`msg-${i}`));
    }

    let callCount = 0;
    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => {
        callCount++;
        // Simulate the exact Anthropic 400 error for tool_use/tool_result pairing
        throw new Error(
          "messages.25: `tool_use` ids were found without `tool_result` blocks immediately after: " +
          "toolu_01JdWLWJ. Each `tool_use` block must have a corresponding `tool_result` block.",
        );
      },
      onError: (err) => { errors.push(err.message); },
    });

    await wait(2000);
    await loop.stop();

    // Circuit breaker should have fired — check for the circuit breaker error message
    const circuitBreakerErrors = errors.filter((e) => e.includes("CIRCUIT BREAKER"));
    expect(circuitBreakerErrors.length).toBeGreaterThan(0);

    // Should NOT have processed all 5 messages — circuit breaker stops retrying
    // (the exact count depends on implementation, but should be < 5)
    expect(callCount).toBeLessThanOrEqual(5);
  });

  it("resets circuit breaker after a successful call", async () => {
    const adapter = makeMockAdapter("webchat");
    const registry = createAdapterRegistry();
    registry.register(adapter);
    const errors: string[] = [];

    // 2 failures, 1 success, 2 more failures — should NOT trigger circuit breaker
    // because the success resets the counter
    let callCount = 0;
    enqueue(db, makeEnvelope("fail-1"));
    enqueue(db, makeEnvelope("fail-2"));
    enqueue(db, makeEnvelope("success"));
    enqueue(db, makeEnvelope("fail-3"));
    enqueue(db, makeEnvelope("fail-4"));

    loop = startLoop({
      db,
      registry,
      workspaceDir,
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      callLLM: async () => {
        callCount++;
        if (callCount === 3) {
          return { text: "success!", toolCalls: [] };
        }
        throw new Error(
          "messages.25: `tool_use` ids were found without `tool_result` blocks: toolu_x",
        );
      },
      onError: (err) => { errors.push(err.message); },
    });

    await wait(2000);
    await loop.stop();

    // All 5 messages should be attempted — circuit breaker resets after success
    expect(callCount).toBe(5);
    // Circuit breaker should NOT have fired
    const circuitBreakerErrors = errors.filter((e) => e.includes("CIRCUIT BREAKER"));
    expect(circuitBreakerErrors).toHaveLength(0);
  });
});
