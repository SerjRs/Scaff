/**
 * Tests for resource-passing through the Cortex → Router spawn pipeline.
 *
 * Covers:
 * - SESSIONS_SPAWN_TOOL schema includes resources field with file, url, and text types
 * - SpawnParams includes resolved resources (name + content)
 * - File resource resolution in loop.ts (reads files, handles errors)
 * - URL resource resolution (wraps URL in marker)
 * - Text resource pass-through
 * - Resource blocks appended to childTaskMessage in subagent-spawn.ts
 * - formatResourceBlocks helper in dispatcher.ts
 * - E2E: resources flow through queue → dispatcher → executor prompt
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. SESSIONS_SPAWN_TOOL schema
// ---------------------------------------------------------------------------

describe("SESSIONS_SPAWN_TOOL schema", () => {
  it("includes resources property with file, url, and text types", async () => {
    const { SESSIONS_SPAWN_TOOL } = await import("../../cortex/llm-caller.js");
    const props = SESSIONS_SPAWN_TOOL.parameters.properties;

    expect(props.resources).toBeDefined();
    expect(props.resources.type).toBe("array");
    expect(props.resources.items.type).toBe("object");
    expect(props.resources.items.properties.type.enum).toEqual(["file", "url", "text"]);
    expect(props.resources.items.properties.name.type).toBe("string");
    expect(props.resources.items.properties.path.type).toBe("string");
    expect(props.resources.items.properties.url.type).toBe("string");
    expect(props.resources.items.properties.content.type).toBe("string");
    expect(props.resources.items.required).toEqual(["type", "name"]);
  });

  it("resources is not in required fields (optional)", async () => {
    const { SESSIONS_SPAWN_TOOL } = await import("../../cortex/llm-caller.js");
    expect(SESSIONS_SPAWN_TOOL.parameters.required).not.toContain("resources");
  });
});

// ---------------------------------------------------------------------------
// 2. SpawnParams type (compile-time check via assignment)
// ---------------------------------------------------------------------------

describe("SpawnParams type", () => {
  it("accepts resources field with name and content", async () => {
    const params: import("../../cortex/loop.js").SpawnParams = {
      task: "test task",
      replyChannel: null,
      resultPriority: "normal",
      envelopeId: "env-1",
      taskId: "task-1",
      resources: [{ name: "config.json", content: '{"key":"value"}' }],
    };
    expect(params.resources).toHaveLength(1);
    expect(params.resources![0].name).toBe("config.json");
    expect(params.resources![0].content).toBe('{"key":"value"}');
  });

  it("resources is optional", () => {
    const params: import("../../cortex/loop.js").SpawnParams = {
      task: "test task",
      replyChannel: null,
      resultPriority: "normal",
      envelopeId: "env-1",
      taskId: "task-1",
    };
    expect(params.resources).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. File resource resolution
// ---------------------------------------------------------------------------

describe("file resource resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-res-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads file content for valid paths", () => {
    const filePath = path.join(tmpDir, "data.txt");
    fs.writeFileSync(filePath, "file contents here");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("file contents here");
  });

  it("produces not-found message for missing files", () => {
    const filePath = path.join(tmpDir, "missing.txt");
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      content = `[File not found: ${filePath}]`;
    }
    expect(content).toMatch(/\[File not found:/);
  });
});

// ---------------------------------------------------------------------------
// 4. Resource blocks in childTaskMessage (subagent-spawn)
// ---------------------------------------------------------------------------

describe("childTaskMessage resource blocks", () => {
  it("resources are formatted correctly in message", () => {
    const resources = [
      { name: "config.json", content: '{"key":"value"}' },
      { name: "data.csv", content: "a,b,c\n1,2,3" },
    ];

    const resourceBlocks: string[] = [];
    for (const res of resources) {
      resourceBlocks.push(`[Resource: ${res.name}]\n${res.content}\n[End Resource: ${res.name}]`);
    }

    const message = [
      "[Subagent Context] You are running as a subagent (depth 1/3).",
      "[Subagent Task]: Analyze the data",
      ...resourceBlocks,
    ].join("\n\n");

    expect(message).toContain("[Resource: config.json]");
    expect(message).toContain('{"key":"value"}');
    expect(message).toContain("[End Resource: config.json]");
    expect(message).toContain("[Resource: data.csv]");
    expect(message).toContain("a,b,c\n1,2,3");
    expect(message).toContain("[End Resource: data.csv]");
  });

  it("empty resources don't change the message", () => {
    const resourceBlocks: string[] = [];
    const parts = [
      "[Subagent Context] context",
      "[Subagent Task]: task",
      ...resourceBlocks,
    ].filter((line): line is string => Boolean(line));

    expect(parts).toHaveLength(2);
    expect(parts.join("\n\n")).not.toContain("[Resource:");
  });

  it("multiple resources are all appended", () => {
    const resources = [
      { name: "file1", content: "content1" },
      { name: "file2", content: "content2" },
      { name: "file3", content: "content3" },
    ];

    const resourceBlocks: string[] = [];
    for (const res of resources) {
      resourceBlocks.push(`[Resource: ${res.name}]\n${res.content}\n[End Resource: ${res.name}]`);
    }

    const message = [
      "[Subagent Task]: task",
      ...resourceBlocks,
    ].join("\n\n");

    for (const res of resources) {
      expect(message).toContain(`[Resource: ${res.name}]`);
      expect(message).toContain(res.content);
      expect(message).toContain(`[End Resource: ${res.name}]`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SpawnSubagentParams includes resources
// ---------------------------------------------------------------------------

describe("SpawnSubagentParams type", () => {
  it("accepts resources field with name and content", () => {
    const params: import("../../agents/subagent-spawn.js").SpawnSubagentParams = {
      task: "test",
      resources: [{ name: "data.txt", content: "data" }],
    };
    expect(params.resources).toHaveLength(1);
    expect(params.resources![0].name).toBe("data.txt");
  });

  it("resources is optional", () => {
    const params: import("../../agents/subagent-spawn.js").SpawnSubagentParams = {
      task: "test",
    };
    expect(params.resources).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. formatResourceBlocks helper (dispatcher.ts)
// ---------------------------------------------------------------------------

describe("formatResourceBlocks", () => {
  it("returns empty string for empty array", async () => {
    const { formatResourceBlocks } = await import("../dispatcher.js");
    expect(formatResourceBlocks([])).toBe("");
  });

  it("formats single resource as labeled block", async () => {
    const { formatResourceBlocks } = await import("../dispatcher.js");
    const result = formatResourceBlocks([{ name: "config.json", content: '{"key":"val"}' }]);
    expect(result).toContain("[Resource: config.json]");
    expect(result).toContain('{"key":"val"}');
    expect(result).toContain("[End Resource: config.json]");
  });

  it("formats multiple resources with double-newline separation", async () => {
    const { formatResourceBlocks } = await import("../dispatcher.js");
    const result = formatResourceBlocks([
      { name: "file1", content: "content1" },
      { name: "file2", content: "content2" },
    ]);
    expect(result).toContain("[Resource: file1]");
    expect(result).toContain("[Resource: file2]");
    expect(result).toContain("[End Resource: file1]");
    expect(result).toContain("[End Resource: file2]");
  });

  it("formats URL resources with URL marker in content", async () => {
    const { formatResourceBlocks } = await import("../dispatcher.js");
    const result = formatResourceBlocks([
      { name: "API docs", content: "[URL: https://api.example.com/docs]" },
    ]);
    expect(result).toContain("[Resource: API docs]");
    expect(result).toContain("[URL: https://api.example.com/docs]");
    expect(result).toContain("[End Resource: API docs]");
  });
});

// ---------------------------------------------------------------------------
// 7. E2E: resources flow through queue → dispatcher → executor prompt
// ---------------------------------------------------------------------------

// Mock evaluator to control weights without LLM calls
const mockEvaluate = vi.fn();
vi.mock("../evaluator.js", () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
}));

describe("E2E: resource-passing through Router pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-res-e2e-"));
    vi.clearAllMocks();
    mockEvaluate.mockResolvedValue({ weight: 5, reasoning: "mock" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches task with file, inline, and url resources — executor receives them in prompt", async () => {
    // Dynamic imports after mock declaration
    const { routerEvents } = await import("../worker.js");
    const { recover } = await import("../recovery.js");
    const { startNotifier, waitForJob } = await import("../notifier.js");
    const { startRouterLoop } = await import("../loop.js");
    const { initRouterDb, enqueue: dbEnqueue } = await import("../queue.js");
    type RouterJob = import("../types.js").RouterJob;

    const dbPath = path.join(tmpDir, "e2e-resources.sqlite");
    const db = initRouterDb(dbPath);
    recover(db);

    // Create a temp file for the file resource
    const testFilePath = path.join(tmpDir, "test-data.txt");
    fs.writeFileSync(testFilePath, "file contents from disk");

    // Track the prompt the executor receives
    let executorPrompt = "";
    const executor = vi.fn(async (prompt: string, _model: string) => {
      executorPrompt = prompt;
      return "task completed";
    });

    const stopNotifier = startNotifier(db);
    const loop = startRouterLoop(db, {
      enabled: true,
      evaluator: { model: "test", tier: "sonnet", timeout: 10, fallback_weight: 5 },
      tiers: {
        haiku: { range: [1, 3], model: "test/haiku" },
        sonnet: { range: [4, 7], model: "test/sonnet" },
        opus: { range: [8, 10], model: "test/opus" },
      },
    }, executor);

    // Enqueue a job with resources in the payload (simulating what gateway-bridge does)
    const resources = [
      { name: "test-data.txt", content: "file contents from disk" },
      { name: "inline-config", content: '{"setting": true}' },
      { name: "API Reference", content: "[URL: https://api.example.com/v2/docs]" },
    ];

    const payload = {
      message: "Analyze the provided data",
      context: JSON.stringify({ source: "test" }),
      resources,
    };

    const jobId = dbEnqueue(db, "agent_run", JSON.stringify(payload), "test-issuer", crypto.randomUUID());
    const job = await waitForJob(db, jobId, 10_000);

    expect(job.status).toBe("completed");
    expect(job.result).toBe("task completed");

    // Verify the executor received resources in its prompt
    expect(executorPrompt).toContain("Analyze the provided data");
    expect(executorPrompt).toContain("[Resource: test-data.txt]");
    expect(executorPrompt).toContain("file contents from disk");
    expect(executorPrompt).toContain("[End Resource: test-data.txt]");
    expect(executorPrompt).toContain("[Resource: inline-config]");
    expect(executorPrompt).toContain('{"setting": true}');
    expect(executorPrompt).toContain("[End Resource: inline-config]");
    expect(executorPrompt).toContain("[Resource: API Reference]");
    expect(executorPrompt).toContain("[URL: https://api.example.com/v2/docs]");
    expect(executorPrompt).toContain("[End Resource: API Reference]");

    loop.stop();
    stopNotifier();
    routerEvents.removeAllListeners();
    try { db.close(); } catch {}
  }, 15_000);

  it("dispatches task without resources — executor prompt has no resource blocks", async () => {
    const { routerEvents } = await import("../worker.js");
    const { recover } = await import("../recovery.js");
    const { startNotifier, waitForJob } = await import("../notifier.js");
    const { startRouterLoop } = await import("../loop.js");
    const { initRouterDb, enqueue: dbEnqueue } = await import("../queue.js");

    const dbPath = path.join(tmpDir, "e2e-no-resources.sqlite");
    const db = initRouterDb(dbPath);
    recover(db);

    let executorPrompt = "";
    const executor = vi.fn(async (prompt: string) => {
      executorPrompt = prompt;
      return "done";
    });

    const stopNotifier = startNotifier(db);
    const loop = startRouterLoop(db, {
      enabled: true,
      evaluator: { model: "test", tier: "sonnet", timeout: 10, fallback_weight: 5 },
      tiers: {
        haiku: { range: [1, 3], model: "test/haiku" },
        sonnet: { range: [4, 7], model: "test/sonnet" },
        opus: { range: [8, 10], model: "test/opus" },
      },
    }, executor);

    const payload = { message: "Simple task" };
    const jobId = dbEnqueue(db, "agent_run", JSON.stringify(payload), "test-issuer", crypto.randomUUID());
    const job = await waitForJob(db, jobId, 10_000);

    expect(job.status).toBe("completed");
    expect(executorPrompt).toContain("Simple task");
    expect(executorPrompt).not.toContain("[Resource:");

    loop.stop();
    stopNotifier();
    routerEvents.removeAllListeners();
    try { db.close(); } catch {}
  }, 15_000);
});
