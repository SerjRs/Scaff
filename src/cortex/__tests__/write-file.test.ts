/**
 * write_file sync tool — unit tests
 *
 * Tests: write new file, overwrite, append, relative path, absolute path,
 * path traversal blocked, parent dirs created, SYNC_TOOL_NAMES registration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeWriteFile, WRITE_FILE_TOOL, SYNC_TOOL_NAMES } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-file-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WRITE_FILE_TOOL definition", () => {
  it("is registered in SYNC_TOOL_NAMES", () => {
    expect(SYNC_TOOL_NAMES.has("write_file")).toBe(true);
  });

  it("has correct tool shape", () => {
    expect(WRITE_FILE_TOOL.name).toBe("write_file");
    expect(WRITE_FILE_TOOL.parameters.required).toEqual(["path", "content"]);
    expect(WRITE_FILE_TOOL.parameters.properties).toHaveProperty("path");
    expect(WRITE_FILE_TOOL.parameters.properties).toHaveProperty("content");
    expect(WRITE_FILE_TOOL.parameters.properties).toHaveProperty("append");
  });
});

describe("executeWriteFile", () => {
  it("writes a new file and returns confirmation", () => {
    const result = executeWriteFile({ path: "hello.txt", content: "Hello World" }, workspaceDir);

    expect(result).toBe("Wrote: hello.txt (11 chars)");
    expect(fs.readFileSync(path.join(workspaceDir, "hello.txt"), "utf-8")).toBe("Hello World");
  });

  it("overwrites existing file", () => {
    fs.writeFileSync(path.join(workspaceDir, "existing.txt"), "old content");

    const result = executeWriteFile({ path: "existing.txt", content: "new content" }, workspaceDir);

    expect(result).toContain("Wrote: existing.txt");
    expect(fs.readFileSync(path.join(workspaceDir, "existing.txt"), "utf-8")).toBe("new content");
  });

  it("appends to existing file in append mode", () => {
    fs.writeFileSync(path.join(workspaceDir, "log.txt"), "line1\n");

    const result = executeWriteFile({ path: "log.txt", content: "line2\n", append: true }, workspaceDir);

    expect(result).toContain("Appended to: log.txt");
    expect(fs.readFileSync(path.join(workspaceDir, "log.txt"), "utf-8")).toBe("line1\nline2\n");
  });

  it("resolves relative paths against workspaceDir", () => {
    executeWriteFile({ path: "sub/dir/file.txt", content: "nested" }, workspaceDir);

    expect(fs.readFileSync(path.join(workspaceDir, "sub", "dir", "file.txt"), "utf-8")).toBe("nested");
  });

  it("handles absolute paths inside project", () => {
    const absPath = path.join(workspaceDir, "abs.txt");
    const result = executeWriteFile({ path: absPath, content: "absolute" }, workspaceDir);

    expect(result).toContain("Wrote:");
    expect(fs.readFileSync(absPath, "utf-8")).toBe("absolute");
  });

  it("blocks path traversal outside project root", () => {
    const result = executeWriteFile({ path: "../../etc/evil.txt", content: "bad" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("outside the project directory");
  });

  it("creates parent directories automatically", () => {
    const result = executeWriteFile({ path: "deep/nested/dir/file.md", content: "# Deep" }, workspaceDir);

    expect(result).toContain("Wrote: deep/nested/dir/file.md");
    expect(fs.existsSync(path.join(workspaceDir, "deep", "nested", "dir", "file.md"))).toBe(true);
  });
});
