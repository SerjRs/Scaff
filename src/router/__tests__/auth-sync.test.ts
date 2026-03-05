import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncExecutorAuth } from "../auth-sync.js";

describe("auth-sync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-sync-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupMainAgent(files: Record<string, string>): void {
    const mainDir = path.join(tmpDir, "agents", "main", "agent");
    fs.mkdirSync(mainDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(mainDir, name), content);
    }
  }

  function readExecutorFile(name: string): string | null {
    const filePath = path.join(tmpDir, "agents", "router-executor", "agent", name);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  it("copies files correctly when both exist", () => {
    const profilesContent = JSON.stringify({ profiles: { "anthropic:default": {} } });
    const authContent = JSON.stringify({ token: "sk-ant-oat-test" });
    setupMainAgent({
      "auth-profiles.json": profilesContent,
      "auth.json": authContent,
    });

    syncExecutorAuth(tmpDir);

    expect(readExecutorFile("auth-profiles.json")).toBe(profilesContent);
    expect(readExecutorFile("auth.json")).toBe(authContent);
  });

  it("handles missing source gracefully (no throw)", () => {
    // No main agent dir at all — should not throw
    expect(() => syncExecutorAuth(tmpDir)).not.toThrow();
  });

  it("creates target directories", () => {
    setupMainAgent({ "auth-profiles.json": "{}" });

    const executorDir = path.join(tmpDir, "agents", "router-executor", "agent");
    expect(fs.existsSync(executorDir)).toBe(false);

    syncExecutorAuth(tmpDir);

    expect(fs.existsSync(executorDir)).toBe(true);
    expect(readExecutorFile("auth-profiles.json")).toBe("{}");
  });
});
