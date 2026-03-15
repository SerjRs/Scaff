import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpAgent(profiles: Record<string, any>, lastGood?: Record<string, string>): string {
  const agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({ profiles, lastGood: lastGood ?? {} }),
  );
  return agentDir;
}

function mockFetchOk(text = "mocked response") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: "text", text }] }),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveAuth
// ---------------------------------------------------------------------------
describe("resolveAuth", () => {
  // Lazy import to avoid module-level side effects
  async function getResolveAuth() {
    const mod = await import("../resolve-auth.js");
    return mod.resolveAuth;
  }

  it("reads auth-profiles.json correctly for a token profile", async () => {
    const agentDir = makeTmpAgent({
      "anthropic:default": { type: "token", token: "sk-ant-api03-test123", provider: "anthropic" },
    });
    const resolveAuth = await getResolveAuth();

    const result = resolveAuth({ agentDir });

    expect(result.token).toBe("sk-ant-api03-test123");
    expect(result.provider).toBe("anthropic");
    expect(result.profileId).toBe("anthropic:default");
  });

  it("detects OAuth tokens (sk-ant-oat01-*)", async () => {
    const agentDir = makeTmpAgent({
      "anthropic:oauth": { type: "oauth", access: "sk-ant-oat01-oauth-token", provider: "anthropic" },
    });
    const resolveAuth = await getResolveAuth();

    const result = resolveAuth({ agentDir });

    expect(result.isOAuth).toBe(true);
    expect(result.token).toBe("sk-ant-oat01-oauth-token");
  });

  it("detects API keys as non-OAuth", async () => {
    const agentDir = makeTmpAgent({
      "anthropic:key": { type: "api_key", key: "sk-ant-api03-mykey", provider: "anthropic" },
    });
    const resolveAuth = await getResolveAuth();

    const result = resolveAuth({ agentDir });

    expect(result.isOAuth).toBe(false);
    expect(result.token).toBe("sk-ant-api03-mykey");
  });

  it("throws on missing profile", async () => {
    const agentDir = makeTmpAgent({});
    const resolveAuth = await getResolveAuth();

    expect(() => resolveAuth({ agentDir })).toThrow(/No auth profile found/);
  });

  it("uses lastGood profile first", async () => {
    const agentDir = makeTmpAgent(
      {
        "anthropic:first": { type: "token", token: "first-token", provider: "anthropic" },
        "anthropic:preferred": { type: "token", token: "preferred-token", provider: "anthropic" },
      },
      { anthropic: "anthropic:preferred" },
    );
    const resolveAuth = await getResolveAuth();

    const result = resolveAuth({ agentDir });

    expect(result.token).toBe("preferred-token");
    expect(result.profileId).toBe("anthropic:preferred");
  });
});

// ---------------------------------------------------------------------------
// complete — header behavior
// ---------------------------------------------------------------------------
describe("complete", () => {
  async function getComplete() {
    const mod = await import("../simple-complete.js");
    return mod.complete;
  }

  it("OAuth tokens use Bearer header", async () => {
    const agentDir = makeTmpAgent({
      "anthropic:oauth": { type: "oauth", access: "sk-ant-oat01-mytoken", provider: "anthropic" },
    });

    const mockFetch = mockFetchOk();
    vi.stubGlobal("fetch", mockFetch);

    const complete = await getComplete();
    const result = await complete("hello", { agentDir });

    expect(result).toBe("mocked response");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, reqInit] = mockFetch.mock.calls[0];
    const headers = reqInit.headers;
    expect(headers["authorization"]).toBe("Bearer sk-ant-oat01-mytoken");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("API keys use x-api-key header", async () => {
    const agentDir = makeTmpAgent({
      "anthropic:key": { type: "token", token: "sk-ant-api03-mykey", provider: "anthropic" },
    });

    const mockFetch = mockFetchOk();
    vi.stubGlobal("fetch", mockFetch);

    const complete = await getComplete();
    const result = await complete("hello", { agentDir });

    expect(result).toBe("mocked response");

    const [, reqInit] = mockFetch.mock.calls[0];
    const headers = reqInit.headers;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-mykey");
    expect(headers["authorization"]).toBeUndefined();
  });
});
