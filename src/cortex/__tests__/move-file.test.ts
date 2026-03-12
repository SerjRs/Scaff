/**
 * move_file sync tool — unit tests
 *
 * Tests: move between folders, relative paths, path traversal blocked,
 * source not found, source is directory, dest parent created, overwrite dest,
 * SYNC_TOOL_NAMES registration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeMoveFile, MOVE_FILE_TOOL, SYNC_TOOL_NAMES } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-file-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MOVE_FILE_TOOL definition", () => {
  it("is registered in SYNC_TOOL_NAMES", () => {
    expect(SYNC_TOOL_NAMES.has("move_file")).toBe(true);
  });

  it("has correct tool shape", () => {
    expect(MOVE_FILE_TOOL.name).toBe("move_file");
    expect(MOVE_FILE_TOOL.parameters.required).toEqual(["from", "to"]);
    expect(MOVE_FILE_TOOL.parameters.properties).toHaveProperty("from");
    expect(MOVE_FILE_TOOL.parameters.properties).toHaveProperty("to");
  });
});

describe("executeMoveFile", () => {
  it("moves file between folders", () => {
    fs.writeFileSync(path.join(workspaceDir, "source.txt"), "content");
    fs.mkdirSync(path.join(workspaceDir, "dest"), { recursive: true });

    const result = executeMoveFile({ from: "source.txt", to: "dest/moved.txt" }, workspaceDir);

    expect(result).toContain("Moved: source.txt");
    expect(fs.existsSync(path.join(workspaceDir, "source.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(workspaceDir, "dest", "moved.txt"), "utf-8")).toBe("content");
  });

  it("resolves relative paths correctly", () => {
    fs.writeFileSync(path.join(workspaceDir, "a.txt"), "data");

    const result = executeMoveFile({ from: "a.txt", to: "b.txt" }, workspaceDir);

    expect(result).toContain("Moved: a.txt");
    expect(fs.existsSync(path.join(workspaceDir, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, "b.txt"))).toBe(true);
  });

  it("blocks path traversal on source", () => {
    const result = executeMoveFile({ from: "../../etc/passwd", to: "stolen.txt" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("outside the project directory");
  });

  it("blocks path traversal on destination", () => {
    fs.writeFileSync(path.join(workspaceDir, "legit.txt"), "ok");

    const result = executeMoveFile({ from: "legit.txt", to: "../../etc/evil.txt" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("outside the project directory");
  });

  it("returns error when source not found", () => {
    const result = executeMoveFile({ from: "nonexistent.txt", to: "dest.txt" }, workspaceDir);

    expect(result).toContain("Error: source not found: nonexistent.txt");
  });

  it("returns error when source is a directory", () => {
    fs.mkdirSync(path.join(workspaceDir, "mydir"), { recursive: true });

    const result = executeMoveFile({ from: "mydir", to: "newdir" }, workspaceDir);

    expect(result).toContain("Error: source is a directory");
  });

  it("creates destination parent directory automatically", () => {
    fs.writeFileSync(path.join(workspaceDir, "file.txt"), "content");

    const result = executeMoveFile({ from: "file.txt", to: "new/deep/dir/file.txt" }, workspaceDir);

    expect(result).toContain("Moved:");
    expect(fs.readFileSync(path.join(workspaceDir, "new", "deep", "dir", "file.txt"), "utf-8")).toBe("content");
  });

  it("overwrites existing destination file", () => {
    fs.writeFileSync(path.join(workspaceDir, "src.txt"), "new content");
    fs.writeFileSync(path.join(workspaceDir, "dst.txt"), "old content");

    const result = executeMoveFile({ from: "src.txt", to: "dst.txt" }, workspaceDir);

    expect(result).toContain("Moved:");
    expect(fs.readFileSync(path.join(workspaceDir, "dst.txt"), "utf-8")).toBe("new content");
    expect(fs.existsSync(path.join(workspaceDir, "src.txt"))).toBe(false);
  });
});
