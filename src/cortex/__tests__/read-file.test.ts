/**
 * read_file sync tool — unit tests
 *
 * Tests: file read, relative path, path traversal blocked, file not found,
 * directory listing, offset/limit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeReadFile, READ_FILE_TOOL, SYNC_TOOL_NAMES } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  // Create a temp project structure: tmpDir/workspace/
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("READ_FILE_TOOL definition", () => {
  it("is registered in SYNC_TOOL_NAMES", () => {
    expect(SYNC_TOOL_NAMES.has("read_file")).toBe(true);
  });

  it("has correct tool shape", () => {
    expect(READ_FILE_TOOL.name).toBe("read_file");
    expect(READ_FILE_TOOL.parameters.required).toEqual(["path"]);
    expect(READ_FILE_TOOL.parameters.properties).toHaveProperty("path");
    expect(READ_FILE_TOOL.parameters.properties).toHaveProperty("offset");
    expect(READ_FILE_TOOL.parameters.properties).toHaveProperty("limit");
  });
});

describe("executeReadFile", () => {
  it("reads a known file and returns content with header", () => {
    const filePath = path.join(workspaceDir, "test.md");
    fs.writeFileSync(filePath, "line1\nline2\nline3\n");

    const result = executeReadFile({ path: "test.md" }, workspaceDir);

    expect(result).toContain("File: test.md");
    expect(result).toContain("4 lines"); // 3 lines + trailing empty
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  it("resolves relative paths against workspaceDir", () => {
    const subDir = path.join(workspaceDir, "docs");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "spec.md"), "# Spec\nContent here");

    const result = executeReadFile({ path: "docs/spec.md" }, workspaceDir);

    expect(result).toContain("File: docs/spec.md");
    expect(result).toContain("# Spec");
    expect(result).toContain("Content here");
  });

  it("handles absolute paths inside project", () => {
    const filePath = path.join(workspaceDir, "abs-test.txt");
    fs.writeFileSync(filePath, "absolute content");

    const result = executeReadFile({ path: filePath }, workspaceDir);

    expect(result).toContain("absolute content");
  });

  it("blocks path traversal outside project root", () => {
    const result = executeReadFile({ path: "../../etc/passwd" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("outside the project directory");
  });

  it("returns error for file not found", () => {
    const result = executeReadFile({ path: "nonexistent.txt" }, workspaceDir);

    expect(result).toContain("Error: file not found: nonexistent.txt");
  });

  it("returns directory listing when path is a directory", () => {
    const subDir = path.join(workspaceDir, "mydir");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "a.txt"), "a");
    fs.writeFileSync(path.join(subDir, "b.txt"), "b");

    const result = executeReadFile({ path: "mydir" }, workspaceDir);

    expect(result).toContain("Directory: mydir");
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
  });

  it("applies offset and limit correctly", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    fs.writeFileSync(path.join(workspaceDir, "big.txt"), lines.join("\n"));

    const result = executeReadFile({ path: "big.txt", offset: 5, limit: 3 }, workspaceDir);

    expect(result).toContain("Showing lines 5-7 of 20");
    expect(result).toContain("line-5");
    expect(result).toContain("line-6");
    expect(result).toContain("line-7");
    expect(result).not.toContain("line-4");
    expect(result).not.toContain("line-8");
  });

  it("caps limit at MAX_LINES (500)", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `L${i + 1}`);
    fs.writeFileSync(path.join(workspaceDir, "huge.txt"), lines.join("\n"));

    const result = executeReadFile({ path: "huge.txt", limit: 999 }, workspaceDir);

    // Should show lines 1-500 of 600
    expect(result).toContain("Showing lines 1-500 of 600");
    expect(result).toContain("L1");
    expect(result).toContain("L500");
    expect(result).not.toContain("L501");
  });

  it("returns error for oversized files (>500KB)", () => {
    const bigContent = "x".repeat(600_000);
    fs.writeFileSync(path.join(workspaceDir, "toobig.bin"), bigContent);

    const result = executeReadFile({ path: "toobig.bin" }, workspaceDir);

    expect(result).toContain("Error: file too large");
    expect(result).toContain("Use offset/limit");
  });

  it("defaults offset to 1 when not provided", () => {
    fs.writeFileSync(path.join(workspaceDir, "small.txt"), "first\nsecond\nthird");

    const result = executeReadFile({ path: "small.txt" }, workspaceDir);

    expect(result).toContain("first");
    expect(result).toContain("second");
    expect(result).toContain("third");
  });
});
