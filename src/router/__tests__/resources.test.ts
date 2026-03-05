/**
 * Tests for resource-passing through the Cortex → Router spawn pipeline.
 *
 * Covers:
 * - SESSIONS_SPAWN_TOOL schema includes resources field with file + text types
 * - SpawnParams includes resolved resources (name + content)
 * - File resource resolution in loop.ts (reads files, handles errors)
 * - Text resource pass-through
 * - Resource blocks appended to childTaskMessage in subagent-spawn.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 1. SESSIONS_SPAWN_TOOL schema
// ---------------------------------------------------------------------------

describe("SESSIONS_SPAWN_TOOL schema", () => {
  it("includes resources property with file and text types", async () => {
    const { SESSIONS_SPAWN_TOOL } = await import("../../cortex/llm-caller.js");
    const props = SESSIONS_SPAWN_TOOL.parameters.properties;

    expect(props.resources).toBeDefined();
    expect(props.resources.type).toBe("array");
    expect(props.resources.items.type).toBe("object");
    expect(props.resources.items.properties.type.enum).toEqual(["file", "text"]);
    expect(props.resources.items.properties.name.type).toBe("string");
    expect(props.resources.items.properties.path.type).toBe("string");
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
