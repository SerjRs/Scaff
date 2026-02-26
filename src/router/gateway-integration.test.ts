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
// Test suite
// ---------------------------------------------------------------------------

describe("gateway-integration", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-router-gw-int-"),
    );
  });

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sleep(50);
  });

  /**
   * Set up mocks: redirect DB to temp dir, stub the evaluator, stub callGateway.
   */
  function setupMocks(evalWeight = 5) {
    const dbPath = path.join(
      tmpDir,
      `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );

    // Mock initRouterDb to use our temp path
    vi.doMock("./queue.js", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("./queue.js");
      return {
        ...actual,
        initRouterDb: (p?: string) => actual.initRouterDb(p ?? dbPath),
      };
    });

    // Mock evaluate to skip real LLM
    vi.doMock("./evaluator.js", () => ({
      evaluate: async () => ({
        weight: evalWeight,
        reasoning: "mock evaluation",
      }),
    }));

    // Mock callGateway to avoid real WebSocket connections
    vi.doMock("../gateway/call.js", () => ({
      callGateway: vi.fn(async (opts: { method: string; params?: unknown }) => {
        if (opts.method === "agent") {
          return {
            runId: "mock-run-id",
            status: "ok",
            summary: "completed",
            result: "mock-agent-response",
          };
        }
        return { status: "ok" };
      }),
    }));

    return dbPath;
  }

  // -----------------------------------------------------------------------
  // Test: initGatewayRouter creates a router instance
  // -----------------------------------------------------------------------

  it("initGatewayRouter creates a router instance", async () => {
    setupMocks();
    const {
      initGatewayRouter,
      getGatewayRouter,
      isGatewayRouterActive,
      stopGatewayRouter,
    } = await import("./gateway-integration.js");

    expect(getGatewayRouter()).toBeNull();
    expect(isGatewayRouterActive()).toBe(false);

    initGatewayRouter(makeConfig());

    expect(getGatewayRouter()).not.toBeNull();
    expect(isGatewayRouterActive()).toBe(true);

    // Cleanup
    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test: initGatewayRouter with disabled config is a no-op
  // -----------------------------------------------------------------------

  it("initGatewayRouter with disabled config is a no-op", async () => {
    setupMocks();
    const {
      initGatewayRouter,
      getGatewayRouter,
      isGatewayRouterActive,
    } = await import("./gateway-integration.js");

    initGatewayRouter(makeConfig(false));

    expect(getGatewayRouter()).toBeNull();
    expect(isGatewayRouterActive()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test: stopGatewayRouter cleans up
  // -----------------------------------------------------------------------

  it("stopGatewayRouter cleans up", async () => {
    setupMocks();
    const {
      initGatewayRouter,
      stopGatewayRouter,
      getGatewayRouter,
      isGatewayRouterActive,
    } = await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());
    expect(isGatewayRouterActive()).toBe(true);

    stopGatewayRouter();

    expect(getGatewayRouter()).toBeNull();
    expect(isGatewayRouterActive()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test: createGatewayExecutor returns a function
  // -----------------------------------------------------------------------

  it("createGatewayExecutor returns a function", async () => {
    setupMocks();
    const { createGatewayExecutor } = await import("./gateway-integration.js");

    const executor = createGatewayExecutor();
    expect(executor).toBeTypeOf("function");
  });

  // -----------------------------------------------------------------------
  // Test: createGatewayExecutor calls callGateway with correct params
  // -----------------------------------------------------------------------

  it("createGatewayExecutor calls callGateway with correct params", async () => {
    setupMocks();
    const { createGatewayExecutor } = await import("./gateway-integration.js");
    const { callGateway: mockCallGateway } = await import("../gateway/call.js");

    const executor = createGatewayExecutor();
    const result = await executor("test prompt", "anthropic/claude-sonnet-4-5");

    expect(result).toBe("mock-agent-response");
    // Executor now makes 3 calls: sessions.patch (model), agent, sessions.delete (cleanup)
    expect(mockCallGateway).toHaveBeenCalledTimes(3);

    // Find the agent call
    const agentCall = (mockCallGateway as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => (args[0] as { method: string }).method === "agent",
    );
    expect(agentCall).toBeDefined();
    const callArgs = agentCall![0];
    expect(callArgs.method).toBe("agent");
    expect(callArgs.params.message).toBe("test prompt");
    expect(callArgs.params.deliver).toBe(false);
    expect(callArgs.expectFinal).toBe(true);
    // Session key should be under router-executor
    expect(callArgs.params.sessionKey).toMatch(/^agent:router-executor:task:/);
  });

  // -----------------------------------------------------------------------
  // Test: double init doesn't crash (stops previous, starts new)
  // -----------------------------------------------------------------------

  it("double init doesn't crash (stops previous, starts new)", async () => {
    setupMocks();
    const {
      initGatewayRouter,
      stopGatewayRouter,
      getGatewayRouter,
      isGatewayRouterActive,
    } = await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());
    const firstInstance = getGatewayRouter();
    expect(firstInstance).not.toBeNull();

    // Second init should stop the first and create a new one
    initGatewayRouter(makeConfig());
    const secondInstance = getGatewayRouter();
    expect(secondInstance).not.toBeNull();

    // Should be a different instance (first was stopped)
    // We can't directly compare object identity after module mocking,
    // but the important thing is it didn't throw.
    expect(isGatewayRouterActive()).toBe(true);

    // Cleanup
    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test: stopGatewayRouter when not initialized is safe (no-op)
  // -----------------------------------------------------------------------

  it("stopGatewayRouter when not initialized is safe (no-op)", async () => {
    setupMocks();
    const { stopGatewayRouter, isGatewayRouterActive } =
      await import("./gateway-integration.js");

    // Should not throw
    expect(() => stopGatewayRouter()).not.toThrow();
    expect(isGatewayRouterActive()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test: stopGatewayRouter called twice is safe
  // -----------------------------------------------------------------------

  it("stopGatewayRouter called twice is safe", async () => {
    setupMocks();
    const { initGatewayRouter, stopGatewayRouter } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    // First stop
    expect(() => stopGatewayRouter()).not.toThrow();
    // Second stop — already null, should be no-op
    expect(() => stopGatewayRouter()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Test: routerCallGateway falls through for non-agent methods
  // -----------------------------------------------------------------------

  it("routerCallGateway falls through for non-agent methods", async () => {
    setupMocks();
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");
    const { callGateway: mockCallGateway } = await import("../gateway/call.js");

    initGatewayRouter(makeConfig());

    // sessions.patch should pass through to callGateway, not the Router
    const result = await routerCallGateway({
      method: "sessions.patch",
      params: { key: "test-key", model: "test-model" },
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "ok" });

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test: routerCallGateway falls through when router not initialized
  // -----------------------------------------------------------------------

  it("routerCallGateway falls through when router not initialized", async () => {
    setupMocks();
    const { routerCallGateway, isGatewayRouterActive } =
      await import("./gateway-integration.js");
    const { callGateway: mockCallGateway } = await import("../gateway/call.js");

    expect(isGatewayRouterActive()).toBe(false);

    // Even "agent" method should fall through when router is not active
    const result = await routerCallGateway({
      method: "agent",
      params: { message: "test" },
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      runId: "mock-run-id",
      status: "ok",
      summary: "completed",
      result: "mock-agent-response",
    });
  });

  // -----------------------------------------------------------------------
  // Test: routerCallGateway routes agent method through router (sync)
  // -----------------------------------------------------------------------

  it("routerCallGateway routes agent method through router (sync)", async () => {
    setupMocks();
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");

    // The executor inside the router will use the mocked callGateway,
    // so the full pipeline works: enqueue → evaluate → dispatch → worker → callGateway mock
    initGatewayRouter(makeConfig());

    const result = await routerCallGateway<{
      runId: string;
      status: string;
      result?: string;
    }>(
      {
        method: "agent",
        params: { message: "routed task", sessionKey: "test-issuer" },
        timeoutMs: 15_000,
      },
      "sync",
    );

    expect(result.status).toBe("ok");
    expect(result.result).toBeDefined();

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test: routerCallGateway routes agent method through router (async)
  // -----------------------------------------------------------------------

  it("routerCallGateway routes agent method through router (async mode)", async () => {
    setupMocks();
    const { initGatewayRouter, stopGatewayRouter, routerCallGateway } =
      await import("./gateway-integration.js");

    initGatewayRouter(makeConfig());

    // Both sync and async modes now evaluate + fall through to callGateway.
    // The _routerMode param is retained for API compat but doesn't change behavior.
    const result = await routerCallGateway<{
      runId: string;
      status: string;
    }>(
      {
        method: "agent",
        params: { message: "async task", sessionKey: "test-issuer" },
      },
      "async",
    );

    expect(result.status).toBe("ok");
    expect(result.runId).toBeTruthy();

    stopGatewayRouter();
  });

  // -----------------------------------------------------------------------
  // Test: createGatewayExecutor handles error responses
  // -----------------------------------------------------------------------

  it("createGatewayExecutor throws on error response", async () => {
    // Override the callGateway mock to return an error
    const dbPath = path.join(
      tmpDir,
      `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );

    vi.doMock("./queue.js", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("./queue.js");
      return {
        ...actual,
        initRouterDb: (p?: string) => actual.initRouterDb(p ?? dbPath),
      };
    });

    vi.doMock("./evaluator.js", () => ({
      evaluate: async () => ({
        weight: 5,
        reasoning: "mock evaluation",
      }),
    }));

    vi.doMock("../gateway/call.js", () => ({
      callGateway: vi.fn(async () => ({
        runId: "error-run-id",
        status: "error",
        summary: "model unavailable",
      })),
    }));

    const { createGatewayExecutor } = await import("./gateway-integration.js");
    const executor = createGatewayExecutor();

    await expect(
      executor("test prompt", "anthropic/claude-sonnet-4-5"),
    ).rejects.toThrow("model unavailable");
  });
});
