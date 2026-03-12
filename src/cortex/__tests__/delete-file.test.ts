/**
 * delete_file sync tool — unit tests
 *
 * Tests: delete existing file, path traversal blocked, file not found,
 * directory refused, relative path resolved, SYNC_TOOL_NAMES registration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeDeleteFile, DELETE_FILE_TOOL, SYNC_TOOL_NAMES } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delete-file-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DELETE_FILE_TOOL definition", () => {
  it("is registered in SYNC_TOOL_NAMES", () => {
    expect(SYNC_TOOL_NAMES.has("delete_file")).toBe(true);
  });

  it("has correct tool shape", () => {
    expect(DELETE_FILE_TOOL.name).toBe("delete_file");
    expect(DELETE_FILE_TOOL.parameters.required).toEqual(["path"]);
    expect(DELETE_FILE_TOOL.parameters.properties).toHaveProperty("path");
  });
});

describe("executeDeleteFile", () => {
  it("deletes an existing file and returns confirmation", () => {
    fs.writeFileSync(path.join(workspaceDir, "doomed.txt"), "goodbye");

    const result = executeDeleteFile({ path: "doomed.txt" }, workspaceDir);

    expect(result).toBe("Deleted: doomed.txt");
    expect(fs.existsSync(path.join(workspaceDir, "doomed.txt"))).toBe(false);
  });

  it("blocks path traversal outside project root", () => {
    const result = executeDeleteFile({ path: "../../etc/passwd" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("outside the project directory");
  });

  it("returns error when file not found", () => {
    const result = executeDeleteFile({ path: "ghost.txt" }, workspaceDir);

    expect(result).toContain("Error: file not found: ghost.txt");
  });

  it("refuses to delete a directory", () => {
    fs.mkdirSync(path.join(workspaceDir, "mydir"), { recursive: true });

    const result = executeDeleteFile({ path: "mydir" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("is a directory");
    // Directory should still exist
    expect(fs.existsSync(path.join(workspaceDir, "mydir"))).toBe(true);
  });

  it("resolves relative paths against workspaceDir", () => {
    const subDir = path.join(workspaceDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "nested.txt"), "data");

    const result = executeDeleteFile({ path: "sub/nested.txt" }, workspaceDir);

    expect(result).toBe("Deleted: sub/nested.txt");
    expect(fs.existsSync(path.join(subDir, "nested.txt"))).toBe(false);
  });
});
