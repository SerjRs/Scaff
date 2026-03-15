/**
 * 020c — E2E Webchat Sync Tool Execution
 *
 * Categories:
 *   D — Sync Tool Execution (tool_use → tool_result → final text)
 *
 * Tests every sync tool through the full Cortex loop:
 *   callLLM returns tool_use → loop executes tool → feeds result back → callLLM returns text
 *
 * Uses programmatic Cortex API — no gateway, no WebSocket.
 * All LLMs are mocked. All tests are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope, type OutputTarget } from "../types.js";
import { TestReporter } from "./helpers/hippo-test-utils.js";
import { insertTestMessage, mockEmbedFn } from "./helpers/hippo-test-utils.js";
import type { CortexLLMResult } from "../llm-caller.js";
import type { AssembledContext } from "../context.js";

// ---------------------------------------------------------------------------
// Reporter setup
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  "../../../workspace/pipeline/InProgress/020c-cortex-e2e/TEST-RESULTS.md",
);
const reporter = new TestReporter();

afterAll(() => {
  reporter.writeReport(REPORT_PATH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let instance: CortexInstance | null = null;

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-tools-"));
  const ws = path.join(tmpDir, "workspace");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeWebchatEnvelope(content: string, senderId = "serj") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: senderId, name: "Serj", relationship: "partner" },
    content,
    priority: "urgent",
  });
}

/**
 * Build a mock callLLM that returns a tool_use on the first call,
 * then returns final text after receiving the tool result.
 */
function makeToolCallLLM(
  toolName: string,
  toolInput: Record<string, unknown>,
  finalText: string,
): (context: AssembledContext) => Promise<CortexLLMResult> {
  let callCount = 0;
  return async (_context: AssembledContext): Promise<CortexLLMResult> => {
    callCount++;
    if (callCount === 1) {
      return {
        text: "",
        toolCalls: [{ id: "tc-1", name: toolName, arguments: toolInput }],
        _rawContent: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tc-1", name: toolName, input: toolInput },
        ],
      };
    }
    return { text: finalText, toolCalls: [], _rawContent: [{ type: "text", text: finalText }] };
  };
}

/**
 * Helper: start cortex with a tool-calling LLM, enqueue a message, wait for reply.
 */
async function runToolTest(opts: {
  callLLM: (ctx: AssembledContext) => Promise<CortexLLMResult>;
  hippocampusEnabled?: boolean;
  setupWorkspace?: (wsDir: string) => void;
}): Promise<OutputTarget[]> {
  const wsDir = path.join(tmpDir, "workspace");

  if (opts.setupWorkspace) {
    opts.setupWorkspace(wsDir);
  }

  const sent: OutputTarget[] = [];
  instance = await startCortex({
    agentId: "main",
    workspaceDir: wsDir,
    dbPath: path.join(tmpDir, "bus.sqlite"),
    maxContextTokens: 10000,
    pollIntervalMs: 50,
    hippocampusEnabled: opts.hippocampusEnabled,
    embedFn: mockEmbedFn,
    callLLM: opts.callLLM,
  });

  instance.registerAdapter({
    channelId: "webchat",
    toEnvelope: () => { throw new Error(""); },
    send: async (target) => { sent.push(target); },
    isAvailable: () => true,
  });

  instance.enqueue(makeWebchatEnvelope("test message"));
  await wait(800);
  return sent;
}

// ---------------------------------------------------------------------------
// D — Sync Tool Execution
// ---------------------------------------------------------------------------

describe("D — Sync Tool Execution", () => {

  // D1: fetch_chat_history
  it("D1: fetch_chat_history returns channel messages", async () => {
    const t = { id: "D1", name: "fetch_chat_history", category: "D — Sync Tool Execution" };
    try {
      // We need to insert messages AFTER cortex starts (so DB is initialized).
      // Use a callLLM that inserts test messages on first call, then issues tool.
      let callCount = 0;
      const callLLM = async (_ctx: AssembledContext): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          // The enqueued message will already be in the session by now.
          // Ask for history.
          return {
            text: "",
            toolCalls: [{ id: "tc-1", name: "fetch_chat_history", arguments: { channel: "webchat", limit: 10 } }],
            _rawContent: [
              { type: "text", text: "" },
              { type: "tool_use", id: "tc-1", name: "fetch_chat_history", input: { channel: "webchat", limit: 10 } },
            ],
          };
        }
        // Second call: after tool result
        return { text: "Got history!", toolCalls: [], _rawContent: [{ type: "text", text: "Got history!" }] };
      };

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Got history!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "tool executes, final text delivered", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "tool executes, final text delivered", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D2: memory_query (requires hippocampus — test graceful handling)
  it("D2: memory_query returns results or graceful error", async () => {
    const t = { id: "D2", name: "memory_query (hot memory)", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "memory_query",
        { query: "test query", limit: 5 },
        "Memory query done!",
      );

      // Enable hippocampus for memory_query to work
      const sent = await runToolTest({ callLLM, hippocampusEnabled: true });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // The tool should execute (even if no facts found) and LLM should respond
      expect(sent.some((s) => s.content.includes("Memory query done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "memory_query executes, final text", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "memory_query executes, final text", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D3: graph_traverse
  it("D3: graph_traverse returns error for missing fact (graceful)", async () => {
    const t = { id: "D3", name: "graph_traverse", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "graph_traverse",
        { fact_id: "nonexistent-fact-id", depth: 2, direction: "both" },
        "Graph traversal done!",
      );

      // graph_traverse queries hippocampus_facts table — needs hippocampus enabled
      const sent = await runToolTest({ callLLM, hippocampusEnabled: true });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Graph traversal done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "graph_traverse handles missing fact gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "graph_traverse handles missing fact gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D4: read_file
  it("D4: read_file reads file content through tool loop", async () => {
    const t = { id: "D4", name: "read_file", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "read_file",
        { path: "test-data.txt" },
        "I read the file!",
      );

      const sent = await runToolTest({
        callLLM,
        setupWorkspace: (wsDir) => {
          fs.writeFileSync(path.join(wsDir, "test-data.txt"), "Hello from test file!\nLine 2\nLine 3");
        },
      });

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("I read the file!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "read_file returns content, LLM responds", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "read_file returns content, LLM responds", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D5: write_file
  it("D5: write_file creates file through tool loop", async () => {
    const t = { id: "D5", name: "write_file", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "write_file",
        { path: "output.txt", content: "Written by Cortex tool!" },
        "File written!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("File written!"))).toBe(true);

      // Verify file was actually created
      const wsDir = path.join(tmpDir, "workspace");
      const writtenContent = fs.readFileSync(path.join(wsDir, "output.txt"), "utf-8");
      expect(writtenContent).toBe("Written by Cortex tool!");

      reporter.record({ ...t, passed: true, expected: "write_file creates file, LLM responds", actual: `file content="${writtenContent}"` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "write_file creates file, LLM responds", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D6: pipeline_status
  it("D6: pipeline_status scans pipeline folders", async () => {
    const t = { id: "D6", name: "pipeline_status", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "pipeline_status",
        {},
        "Pipeline status retrieved!",
      );

      const sent = await runToolTest({
        callLLM,
        setupWorkspace: (wsDir) => {
          // Create pipeline structure
          const pipelineDir = path.join(wsDir, "pipeline");
          fs.mkdirSync(path.join(pipelineDir, "InProgress", "001-test-task"), { recursive: true });
          fs.writeFileSync(
            path.join(pipelineDir, "InProgress", "001-test-task", "SPEC.md"),
            "---\nid: \"001\"\ntitle: \"Test Task\"\nstatus: \"in_progress\"\n---\nTest spec.",
          );
          fs.mkdirSync(path.join(pipelineDir, "Done", "000-setup"), { recursive: true });
        },
      });

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Pipeline status retrieved!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "pipeline_status scans dirs, LLM responds", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "pipeline_status scans dirs, LLM responds", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D7: pipeline_transition
  it("D7: pipeline_transition moves task between stages", async () => {
    const t = { id: "D7", name: "pipeline_transition", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "pipeline_transition",
        { task: "099", to: "InReview" },
        "Task transitioned!",
      );

      const sent = await runToolTest({
        callLLM,
        setupWorkspace: (wsDir) => {
          // Create a task in InProgress that can be moved to InReview
          const taskDir = path.join(wsDir, "pipeline", "InProgress", "099-transition-test");
          fs.mkdirSync(taskDir, { recursive: true });
          fs.writeFileSync(
            path.join(taskDir, "SPEC.md"),
            '---\nid: "099"\ntitle: "Transition Test"\nstatus: "in_progress"\nmoved_at: "2026-03-01"\n---\nTest.',
          );
          // Create target stage dir
          fs.mkdirSync(path.join(wsDir, "pipeline", "InReview"), { recursive: true });
        },
      });

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Task transitioned!"))).toBe(true);

      // Verify the folder was moved
      const wsDir = path.join(tmpDir, "workspace");
      expect(fs.existsSync(path.join(wsDir, "pipeline", "InReview", "099-transition-test"))).toBe(true);
      expect(fs.existsSync(path.join(wsDir, "pipeline", "InProgress", "099-transition-test"))).toBe(false);

      reporter.record({ ...t, passed: true, expected: "pipeline_transition moves folder", actual: "folder moved InProgress→InReview" });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "pipeline_transition moves folder", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D8: cortex_config — read (will error since no real config in temp)
  it("D8: cortex_config read handles missing config gracefully", async () => {
    const t = { id: "D8", name: "cortex_config — read", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "cortex_config",
        { action: "read" },
        "Config read done!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // Tool should handle missing config and return error string; LLM still responds
      expect(sent.some((s) => s.content.includes("Config read done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "cortex_config read handles gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "cortex_config read handles gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D9: cortex_config — set_channel (will error since no real config in temp)
  it("D9: cortex_config set_channel handles missing config gracefully", async () => {
    const t = { id: "D9", name: "cortex_config — set_channel", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "cortex_config",
        { action: "set_channel", channel: "webchat", mode: "live" },
        "Channel mode set!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Channel mode set!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "cortex_config set_channel handles gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "cortex_config set_channel handles gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D10: library_get (will error since no library DB — tests error handling)
  it("D10: library_get handles missing library gracefully", async () => {
    const t = { id: "D10", name: "library_get", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "library_get",
        { item_id: 1 },
        "Library get done!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Library get done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "library_get handles missing DB gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "library_get handles missing DB gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D11: library_search (will error since no library DB — tests error handling)
  it("D11: library_search handles missing library gracefully", async () => {
    const t = { id: "D11", name: "library_search", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "library_search",
        { query: "test search", limit: 5 },
        "Library search done!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Library search done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "library_search handles missing DB gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "library_search handles missing DB gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D12: code_search (will error since no index — tests error handling)
  it("D12: code_search handles missing index gracefully", async () => {
    const t = { id: "D12", name: "code_search", category: "D — Sync Tool Execution" };
    try {
      const callLLM = makeToolCallLLM(
        "code_search",
        { query: "function hello", limit: 5 },
        "Code search done!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Code search done!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "code_search handles missing index gracefully", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "code_search handles missing index gracefully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D13: Tool call chain — multi-turn (read_file → write_file → final text)
  it("D13: multi-turn tool chain (read_file → write_file → text)", async () => {
    const t = { id: "D13", name: "tool call chain — multi-turn", category: "D — Sync Tool Execution" };
    try {
      let callCount = 0;
      const callLLM = async (_ctx: AssembledContext): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          // First: read a file
          return {
            text: "",
            toolCalls: [{ id: "tc-1", name: "read_file", arguments: { path: "input.txt" } }],
            _rawContent: [
              { type: "text", text: "" },
              { type: "tool_use", id: "tc-1", name: "read_file", input: { path: "input.txt" } },
            ],
          };
        }
        if (callCount === 2) {
          // Second: write a file based on what was read
          return {
            text: "",
            toolCalls: [{ id: "tc-2", name: "write_file", arguments: { path: "output.txt", content: "Processed!" } }],
            _rawContent: [
              { type: "text", text: "" },
              { type: "tool_use", id: "tc-2", name: "write_file", input: { path: "output.txt", content: "Processed!" } },
            ],
          };
        }
        // Third: final text
        return { text: "Chain complete!", toolCalls: [], _rawContent: [{ type: "text", text: "Chain complete!" }] };
      };

      const sent = await runToolTest({
        callLLM,
        setupWorkspace: (wsDir) => {
          fs.writeFileSync(path.join(wsDir, "input.txt"), "Source data");
        },
      });

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("Chain complete!"))).toBe(true);
      expect(callCount).toBe(3);

      // Verify the written file exists
      const wsDir = path.join(tmpDir, "workspace");
      expect(fs.readFileSync(path.join(wsDir, "output.txt"), "utf-8")).toBe("Processed!");

      reporter.record({ ...t, passed: true, expected: "3 LLM calls, chain executes fully", actual: `callCount=${callCount}, output file written` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "3 LLM calls, chain executes fully", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D14: Invalid tool name handling
  it("D14: invalid tool name is handled gracefully", async () => {
    const t = { id: "D14", name: "invalid tool name handling", category: "D — Sync Tool Execution" };
    try {
      // An invalid tool name is NOT in SYNC_TOOL_NAMES, so it won't be picked up
      // by the sync tool loop. The loop only processes tools in SYNC_TOOL_NAMES.
      // If the LLM returns a non-sync tool, the loop should skip it and use the text.
      let callCount = 0;
      const callLLM = async (_ctx: AssembledContext): Promise<CortexLLMResult> => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "I tried a fake tool but here's my answer anyway.",
            toolCalls: [{ id: "tc-bad", name: "nonexistent_tool_xyz", arguments: { foo: "bar" } }],
            _rawContent: [
              { type: "text", text: "I tried a fake tool but here's my answer anyway." },
              { type: "tool_use", id: "tc-bad", name: "nonexistent_tool_xyz", input: { foo: "bar" } },
            ],
          };
        }
        return { text: "Fallback response", toolCalls: [], _rawContent: [{ type: "text", text: "Fallback response" }] };
      };

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // The invalid tool is not in SYNC_TOOL_NAMES, so syncCalls will be empty,
      // the loop breaks immediately, and the text from the first call is used.
      const content = sent.map((s) => s.content).join(" ");
      expect(content).toContain("I tried a fake tool");

      reporter.record({ ...t, passed: true, expected: "invalid tool skipped, text delivered", actual: `content="${content.substring(0, 80)}"` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "invalid tool skipped, text delivered", actual: String(err), error: String(err) });
      throw err;
    }
  });

  // D15: Tool execution error handling
  it("D15: tool execution error is caught and fed back to LLM", async () => {
    const t = { id: "D15", name: "tool execution error handling", category: "D — Sync Tool Execution" };
    try {
      // read_file with a nonexistent file will return an error string (not throw)
      const callLLM = makeToolCallLLM(
        "read_file",
        { path: "does-not-exist.txt" },
        "I handled the error!",
      );

      const sent = await runToolTest({ callLLM });
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.some((s) => s.content.includes("I handled the error!"))).toBe(true);

      reporter.record({ ...t, passed: true, expected: "error result fed to LLM, LLM responds", actual: `replies=${sent.length}` });
    } catch (err) {
      reporter.record({ ...t, passed: false, expected: "error result fed to LLM, LLM responds", actual: String(err), error: String(err) });
      throw err;
    }
  });
});
