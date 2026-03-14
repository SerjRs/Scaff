/**
 * pipeline_status sync tool — unit tests
 *
 * Tests: full overview, filtered stage, YAML frontmatter parsing,
 * missing dirs, missing SPEC.md, non-directory entries, SYNC_TOOL_NAMES.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executePipelineStatus, PIPELINE_STATUS_TOOL, SYNC_TOOL_NAMES } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-status-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a task folder with a SPEC.md containing YAML frontmatter */
function createTask(
  stage: string,
  folderName: string,
  meta: Record<string, string>,
): void {
  const taskDir = path.join(workspaceDir, "pipeline", stage, folderName);
  fs.mkdirSync(taskDir, { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: "${value}"`);
  }
  lines.push("---", "", `# ${meta.title ?? folderName}`);
  fs.writeFileSync(path.join(taskDir, "SPEC.md"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PIPELINE_STATUS_TOOL definition", () => {
  it("is registered in SYNC_TOOL_NAMES", () => {
    expect(SYNC_TOOL_NAMES.has("pipeline_status")).toBe(true);
  });

  it("has correct tool shape", () => {
    expect(PIPELINE_STATUS_TOOL.name).toBe("pipeline_status");
    expect(PIPELINE_STATUS_TOOL.parameters.required).toEqual([]);
    expect(PIPELINE_STATUS_TOOL.parameters.properties).toHaveProperty("folder");
  });
});

describe("executePipelineStatus", () => {
  it("returns empty pipeline when no tasks exist", () => {
    // Create pipeline dir with empty stage folders
    for (const stage of ["Cooking", "InProgress", "Done", "Canceled"]) {
      fs.mkdirSync(path.join(workspaceDir, "pipeline", stage), { recursive: true });
    }

    const result = executePipelineStatus({}, workspaceDir);

    expect(result).toContain("Pipeline Status");
    expect(result).toContain("Cooking (0)");
    expect(result).toContain("InProgress (0)");
    expect(result).toContain("Done (0)");
    expect(result).toContain("Canceled (0)");
  });

  it("lists tasks across all stages with correct counts", () => {
    createTask("Cooking", "001-feature-a", {
      id: "001",
      title: "Feature A",
      priority: "high",
      author: "scaff",
      moved_at: "2026-03-12",
    });
    createTask("Cooking", "002-feature-b", {
      id: "002",
      title: "Feature B",
      priority: "medium",
      author: "scaff",
      moved_at: "2026-03-12",
    });
    createTask("InProgress", "003-feature-c", {
      id: "003",
      title: "Feature C",
      priority: "high",
      author: "dev1",
      moved_at: "2026-03-13",
    });
    // Create empty Done folder
    fs.mkdirSync(path.join(workspaceDir, "pipeline", "Done"), { recursive: true });

    const result = executePipelineStatus({}, workspaceDir);

    expect(result).toContain("Cooking (2):");
    expect(result).toContain("001 — Feature A [high]");
    expect(result).toContain("002 — Feature B [medium]");
    expect(result).toContain("InProgress (1):");
    expect(result).toContain("003 — Feature C [high]");
    expect(result).toContain("Done (0)");
  });

  it("parses YAML frontmatter from SPEC.md correctly", () => {
    createTask("InProgress", "005-complex", {
      id: "005",
      title: "Complex Task",
      priority: "high",
      author: "dev2",
      executor: "claude",
      branch: "feat/complex",
      pr: "#42",
      moved_at: "2026-03-14",
    });

    // Filtered view includes more detail
    const result = executePipelineStatus({ folder: "InProgress" }, workspaceDir);

    expect(result).toContain("005 — Complex Task [high]");
    expect(result).toContain("executor=claude");
    expect(result).toContain("branch=feat/complex");
    expect(result).toContain("PR=#42");
  });

  it("filters to a single stage when folder is specified", () => {
    createTask("Cooking", "001-task", { id: "001", title: "Cooking Task", priority: "low" });
    createTask("Done", "002-task", { id: "002", title: "Done Task", priority: "medium" });

    const result = executePipelineStatus({ folder: "Done" }, workspaceDir);

    expect(result).toContain("Done (1):");
    expect(result).toContain("002 — Done Task");
    // Other stages should show count only (not expanded)
    expect(result).toContain("Cooking (1)");
    expect(result).not.toContain("001 — Cooking Task");
  });

  it("handles missing pipeline directory gracefully", () => {
    // No pipeline dir created
    const result = executePipelineStatus({}, workspaceDir);

    expect(result).toContain("Pipeline Status");
    expect(result).toContain("Pipeline directory not found");
  });

  it("handles task folder without SPEC.md gracefully", () => {
    const taskDir = path.join(workspaceDir, "pipeline", "Cooking", "010-no-spec");
    fs.mkdirSync(taskDir, { recursive: true });
    // No SPEC.md — just empty folder

    const result = executePipelineStatus({}, workspaceDir);

    expect(result).toContain("Cooking (1):");
    // Should use folder name as fallback title
    expect(result).toContain("010-no-spec");
  });

  it("skips README.md and other non-directory entries", () => {
    const stageDir = path.join(workspaceDir, "pipeline", "Cooking");
    fs.mkdirSync(stageDir, { recursive: true });
    // Create a README.md file (should be skipped)
    fs.writeFileSync(path.join(stageDir, "README.md"), "# Cooking Stage");
    // Create a loose .md file (should be skipped — not a directory)
    fs.writeFileSync(path.join(stageDir, "notes.txt"), "some notes");
    // Create an actual task folder
    createTask("Cooking", "001-real-task", { id: "001", title: "Real Task" });

    const result = executePipelineStatus({}, workspaceDir);

    expect(result).toContain("Cooking (1):");
    expect(result).toContain("001 — Real Task");
    expect(result).not.toContain("README");
    expect(result).not.toContain("notes.txt");
  });

  it("returns error for unknown stage name", () => {
    fs.mkdirSync(path.join(workspaceDir, "pipeline"), { recursive: true });

    const result = executePipelineStatus({ folder: "Invalid" }, workspaceDir);

    expect(result).toContain("Error");
    expect(result).toContain("unknown stage");
    expect(result).toContain("Valid stages");
  });

  it("is case-insensitive for folder filter", () => {
    createTask("Cooking", "001-task", { id: "001", title: "My Task", priority: "high" });

    const result = executePipelineStatus({ folder: "cooking" }, workspaceDir);

    expect(result).toContain("Cooking (1):");
    expect(result).toContain("001 — My Task");
  });
});
