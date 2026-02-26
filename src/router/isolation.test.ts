import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { RouterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(enabled = true): RouterConfig {
  return {
    enabled,
    evaluator: {
      model: "anthropic/claude-sonnet-4-6",
      tier: "sonnet",
      timeout: 10,
      fallback_weight: 5,
    },
    tiers: {
      haiku: { range: [1, 3], model: "anthropic/claude-haiku-4-5" },
      sonnet: { range: [4, 7], model: "anthropic/claude-sonnet-4-5" },
      opus: { range: [8, 10], model: "anthropic/claude-opus-4-6" },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Test suite: Context Isolation
// ---------------------------------------------------------------------------

describe("context isolation", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-router-isolation-"));
  });

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sleep(50);
  });

  /**
   * Set up mocks with a captured callGateway spy for inspecting calls.
   */
  function setupMocks(evalWeight = 5) {
    const dbPath = path.join(
      tmpDir,
      `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const callLog: Array<{ method: string; params: Record<string, unknown> }> = [];

    vi.doMock("./queue.js", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("./queue.js");
      return {
        ...actual,
        initRouterDb: (p?: string) => actual.initRouterDb(p ?? dbPath),
      };
    });

    vi.doMock("./evaluator.js", () => ({
      evaluate: async () => ({
        weight: evalWeight,
        reasoning: "mock evaluation",
      }),
    }));

    const mockCallGateway = vi.fn(async (opts: { method: string; params?: unknown }) => {
      const params = (opts.params ?? {}) as Record<string, unknown>;
      callLog.push({ method: opts.method, params });
      if (opts.method === "agent") {
        return {
          runId: "mock-run-id",
          status: "ok",
          summary: "completed",
          result: { payloads: [{ text: "mock response" }] },
        };
      }
      return { status: "ok" };
    });

    vi.doMock("../gateway/call.js", () => ({
      callGateway: mockCallGateway,
    }));

    // Mock resolveStateDir for auth sync
    vi.doMock("../config/paths.js", () => ({
      resolveStateDir: () => tmpDir,
    }));

    // Create fake auth dirs so syncExecutorAuth doesn't error
    const mainAuthDir = path.join(tmpDir, "agents", "main", "agent");
    fs.mkdirSync(mainAuthDir, { recursive: true });
    fs.writeFileSync(path.join(mainAuthDir, "auth-profiles.json"), '{"test": true}');

    return { dbPath, callLog, mockCallGateway };
  }

  // -----------------------------------------------------------------------
  // Test 1: Executor creates sessions under router-executor agent
  // -----------------------------------------------------------------------

  it("executor creates sessions under router-executor agent", async () => {
    const { callLog } = setupMocks();
    const { createGatewayExecutor } = await import("./gateway-integration.js");

    const executor = createGatewayExecutor();
    await executor("test prompt", "anthropic/claude-haiku-4-5");

    // Find the agent call
    const agentCall = callLog.find((c) => c.method === "agent");
    expect(agentCall).toBeDefined();

    // Session key should start with agent:router-executor:task:
    const sessionKey = agentCall!.params.sessionKey as string;
    expect(sessionKey).toMatch(/^agent:router-executor:task:[0-9a-f-]+$/);
  });

  // -----------------------------------------------------------------------
  // Test 2: Executor does NOT use main agent sessions
  // -----------------------------------------------------------------------

  it("executor never creates sessions under main agent", async () => {
    const { callLog } = setupMocks();
    const { createGatewayExecutor } = await import("./gateway-integration.js");

    const executor = createGatewayExecutor();
    await executor("test prompt", "anthropic/claude-sonnet-4-5");

    // No call should have a session key starting with agent:main:
    const mainSessionCalls = callLog.filter((c) => {
      const key = c.params.sessionKey as string | undefined;
      return key?.startsWith("agent:main:");
    });
    expect(mainSessionCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 3: Executor session is cleaned up after execution
  // -----------------------------------------------------------------------

  it("executor cleans up session after execution", async () => {
    const { callLog } = setupMocks();
    const { createGatewayExecutor } = await import("./gateway-integration.js");

    const executor = createGatewayExecutor();
    await executor("test prompt", "anthropic/claude-haiku-4-5");

    // Should have a sessions.delete call for cleanup
    const deleteCall = callLog.find((c) => c.method === "sessions.delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.params.deleteTranscript).toBe(true);

    // The deleted session should be the same as the executed session
    const agentCall = callLog.find((c) => c.method === "agent");
    expect(deleteCall!.params.key).toBe(agentCall!.params.sessionKey);
  });

  // -----------------------------------------------------------------------
  // Test 4: routerCallGateway renders tier template as the message
  // -----------------------------------------------------------------------

  it("routerCallGateway renders tier template and replaces message", async () => {
    const { callLog } = setupMocks(2); // weight 2 → haiku
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    await routerCallGateway({
      method: "agent",
      params: {
        message: "what is 15*3?",
        sessionKey: "agent:router-executor:subagent:test-uuid",
      },
    });

    // The agent call should contain the template-rendered prompt, not the raw task
    const agentCall = callLog.find((c) => c.method === "agent");
    expect(agentCall).toBeDefined();
    const message = agentCall!.params.message as string;

    // Template should wrap the task — check for template markers
    expect(message).toContain("task executor");
    expect(message).toContain("what is 15*3?");
    // Should NOT be just the raw task
    expect(message).not.toBe("what is 15*3?");

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test 5: routerCallGateway patches model on session
  // -----------------------------------------------------------------------

  it("routerCallGateway patches session with evaluated model", async () => {
    const { callLog } = setupMocks(2); // weight 2 → haiku
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    await routerCallGateway({
      method: "agent",
      params: {
        message: "simple task",
        sessionKey: "agent:router-executor:subagent:test-uuid",
      },
    });

    // Should have a sessions.patch call with the haiku model
    const patchCall = callLog.find(
      (c) => c.method === "sessions.patch" && c.params.model,
    );
    expect(patchCall).toBeDefined();
    expect(patchCall!.params.model).toBe("anthropic/claude-haiku-4-5");

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test 6: Weight → tier → model mapping is correct
  // -----------------------------------------------------------------------

  describe("weight-to-tier mapping", () => {
    it("weight 1 → haiku", async () => {
      const { callLog } = setupMocks(1);
      const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
        await import("./gateway-integration.js");

      initGatewayRouter(makeConfig());
      await routerCallGateway({
        method: "agent",
        params: { message: "trivial", sessionKey: "test-session" },
      });

      const patchCall = callLog.find(
        (c) => c.method === "sessions.patch" && c.params.model,
      );
      expect(patchCall!.params.model).toBe("anthropic/claude-haiku-4-5");
      stopGatewayRouter();
    });

    it("weight 5 → sonnet", async () => {
      const { callLog } = setupMocks(5);
      const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
        await import("./gateway-integration.js");

      initGatewayRouter(makeConfig());
      await routerCallGateway({
        method: "agent",
        params: { message: "moderate", sessionKey: "test-session" },
      });

      const patchCall = callLog.find(
        (c) => c.method === "sessions.patch" && c.params.model,
      );
      expect(patchCall!.params.model).toBe("anthropic/claude-sonnet-4-5");
      stopGatewayRouter();
    });

    it("weight 9 → opus", async () => {
      const { callLog } = setupMocks(9);
      const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
        await import("./gateway-integration.js");

      initGatewayRouter(makeConfig());
      await routerCallGateway({
        method: "agent",
        params: { message: "complex", sessionKey: "test-session" },
      });

      const patchCall = callLog.find(
        (c) => c.method === "sessions.patch" && c.params.model,
      );
      expect(patchCall!.params.model).toBe("anthropic/claude-opus-4-6");
      stopGatewayRouter();
    });
  });

  // -----------------------------------------------------------------------
  // Test 7: Template content differs per tier
  // -----------------------------------------------------------------------

  it("different tiers produce different template content", async () => {
    // We can test this directly via the template engine
    const { getTemplate, renderTemplate, clearTemplateCache } =
      await import("./templates/index.js");

    clearTemplateCache();

    const task = "explain quantum computing";
    const haikuPrompt = renderTemplate(getTemplate("haiku", "agent_run"), { task });
    const sonnetPrompt = renderTemplate(getTemplate("sonnet", "agent_run"), { task });
    const opusPrompt = renderTemplate(getTemplate("opus", "agent_run"), { task });

    // All should contain the task
    expect(haikuPrompt).toContain(task);
    expect(sonnetPrompt).toContain(task);
    expect(opusPrompt).toContain(task);

    // All should mention "task executor" (self-contained instructions)
    expect(haikuPrompt).toContain("task executor");
    expect(sonnetPrompt).toContain("task executor");
    expect(opusPrompt).toContain("task executor");

    // All should mention isolation constraints
    expect(haikuPrompt).toContain("no tools");
    expect(sonnetPrompt).toContain("no tools");
    expect(opusPrompt).toContain("no tools");

    // Templates should be different from each other
    expect(haikuPrompt).not.toBe(sonnetPrompt);
    expect(sonnetPrompt).not.toBe(opusPrompt);
  });

  // -----------------------------------------------------------------------
  // Test 8: Templates contain no references to workspace files
  // -----------------------------------------------------------------------

  it("templates contain no references to workspace/personality files", async () => {
    const { getTemplate, clearTemplateCache } = await import("./templates/index.js");
    clearTemplateCache();

    const tiers = ["haiku", "sonnet", "opus"] as const;
    const forbidden = [
      "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md",
      "IDENTITY.md", "HEARTBEAT.md", "BOOTSTRAP.md",
      "workspace", "personality", "memory search",
    ];

    for (const tier of tiers) {
      const template = getTemplate(tier, "agent_run");
      for (const term of forbidden) {
        expect(template, `${tier} template should not reference "${term}"`).not.toContain(term);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 9: routerCallGateway logs decision to SQLite archive
  // -----------------------------------------------------------------------

  it("routerCallGateway logs decision to SQLite archive", async () => {
    const { dbPath } = setupMocks(3);
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");
    const { initRouterDb } = await import("./queue.js");

    initGatewayRouter(makeConfig());

    await routerCallGateway({
      method: "agent",
      params: { message: "test logging", sessionKey: "test-session" },
    });

    // Give the fire-and-forget logging a moment
    await sleep(100);

    // Check the archive table
    const db = initRouterDb(dbPath);
    const rows = db.prepare("SELECT * FROM jobs_archive").all() as Array<{
      type: string;
      status: string;
      weight: number;
      tier: string;
    }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const job = rows[rows.length - 1];
    expect(job.type).toBe("agent_run");
    expect(job.status).toBe("completed");
    expect(job.weight).toBe(3);
    expect(job.tier).toBe("haiku");

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test 10: routerCallGateway falls through on evaluation failure
  // -----------------------------------------------------------------------

  it("routerCallGateway falls through to callGateway on evaluation failure", async () => {
    const dbPath = path.join(
      tmpDir,
      `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const callLog: Array<{ method: string; params: Record<string, unknown> }> = [];

    vi.doMock("./queue.js", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("./queue.js");
      return {
        ...actual,
        initRouterDb: (p?: string) => actual.initRouterDb(p ?? dbPath),
      };
    });

    // Evaluator throws
    vi.doMock("./evaluator.js", () => ({
      evaluate: async () => {
        throw new Error("evaluator crashed");
      },
    }));

    vi.doMock("../gateway/call.js", () => ({
      callGateway: vi.fn(async (opts: { method: string; params?: unknown }) => {
        callLog.push({ method: opts.method, params: (opts.params ?? {}) as Record<string, unknown> });
        if (opts.method === "agent") {
          return { runId: "fallback-run", status: "ok", result: "fallback result" };
        }
        return { status: "ok" };
      }),
    }));

    vi.doMock("../config/paths.js", () => ({
      resolveStateDir: () => tmpDir,
    }));

    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    // Should not throw — falls through to callGateway with original message
    const result = await routerCallGateway<{ runId: string; status: string }>({
      method: "agent",
      params: { message: "original message", sessionKey: "test-session" },
    });

    expect(result.status).toBe("ok");
    expect(result.runId).toBe("fallback-run");

    // The agent call should have the ORIGINAL message (not template-rendered)
    const agentCall = callLog.find((c) => c.method === "agent");
    expect(agentCall!.params.message).toBe("original message");

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test 11: Auth sync creates executor agent directory
  // -----------------------------------------------------------------------

  it("auth sync copies auth files to executor agent", async () => {
    setupMocks();
    const { initGatewayRouter, stopGatewayRouter } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    // Check that auth was synced
    const executorAuthPath = path.join(
      tmpDir, "agents", "router-executor", "agent", "auth-profiles.json",
    );
    expect(fs.existsSync(executorAuthPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(executorAuthPath, "utf-8"));
    expect(content).toEqual({ test: true });

    stopGatewayRouter();
  });
});
