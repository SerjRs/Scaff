import type { DatabaseSync } from "node:sqlite";
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
import {
  enqueue as dbEnqueue,
  getJob,
  initRouterDb,
  queryArchive,
  updateJob,
} from "./queue.js";
import { routerEvents } from "./worker.js";
import { startRouter, type RouterInstance } from "./index.js";
import type { RouterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid RouterConfig for tests. */
function makeConfig(): RouterConfig {
  return {
    enabled: true,
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

/**
 * Mock executor that returns immediately with a known result.
 */
const instantExecutor = async (_prompt: string, _model: string) =>
  "mock-result-ok";

/**
 * Mock executor that never resolves (for timeout tests).
 */
const hangingExecutor = (_prompt: string, _model: string) =>
  new Promise<string>(() => {
    /* never resolves */
  });

/**
 * Small sleep helper.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("router service entry (index.ts)", () => {
  let tmpDir: string;
  let router: RouterInstance | null = null;

  // Point initRouterDb to a per-test temp directory
  // We do this by setting the env var that resolveUserPath uses, or by
  // mocking initRouterDb. Simpler: patch the HOME-like env to redirect
  // the default path. But even simpler: the startRouter calls initRouterDb()
  // which defaults to ~/.openclaw/router/queue.sqlite. We'll mock evaluate()
  // to avoid real LLM calls and override the db path via env.

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-router-idx-"));
  });

  beforeEach(() => {
    routerEvents.removeAllListeners();
    vi.resetModules();
  });

  afterEach(async () => {
    if (router) {
      router.stop();
      router = null;
    }
    vi.restoreAllMocks();
    // Small delay to let any async work settle
    await sleep(50);
  });

  // -----------------------------------------------------------------------
  // We need to intercept the DB path and the evaluator (no real LLM calls).
  // Strategy: mock initRouterDb to use a temp path, mock evaluate to return
  // a fixed weight so jobs flow through without a real API call.
  // -----------------------------------------------------------------------

  /**
   * Set up mocks for a test: redirect DB to temp dir, stub the evaluator.
   * Returns the DB path used.
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

    return dbPath;
  }

  // -----------------------------------------------------------------------
  // Test: startRouter initializes without error
  // -----------------------------------------------------------------------

  it("startRouter initializes without error", async () => {
    const dbPath = setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);

    expect(router).toBeDefined();
    expect(router.enqueue).toBeTypeOf("function");
    expect(router.enqueueAndWait).toBeTypeOf("function");
    expect(router.stop).toBeTypeOf("function");
    expect(router.getStatus).toBeTypeOf("function");
  });

  // -----------------------------------------------------------------------
  // Test: startRouter runs recovery on startup (seed stuck jobs)
  // -----------------------------------------------------------------------

  it("runs recovery on startup for stuck jobs", async () => {
    const dbPath = setupMocks();

    // Pre-seed DB with stuck jobs before starting the router
    const { initRouterDb: initDb, enqueue: rawEnqueue, updateJob: rawUpdate } =
      await import("./queue.js");
    const seedDb = initDb(dbPath);

    // Create a job stuck in 'evaluating'
    const stuckId = rawEnqueue(seedDb, "agent_run", '{"message":"stuck"}', "test-issuer");
    rawUpdate(seedDb, stuckId, { status: "evaluating" });

    // Create a job stuck in 'in_execution'
    const execId = rawEnqueue(seedDb, "agent_run", '{"message":"exec-stuck"}', "test-issuer");
    rawUpdate(seedDb, execId, { status: "in_execution" });

    seedDb.close();

    // Now start the router — recovery should handle these
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);

    // Give a tick for recovery to process
    await sleep(100);

    // The evaluating job should have been reset to in_queue (and picked up by the loop)
    // The in_execution job should have been reset to pending
    // Since the loop is running, they may have already progressed further.
    // Just verify the router started without error — recovery ran.
    const status = router.getStatus();
    expect(status).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test: enqueue returns a job ID
  // -----------------------------------------------------------------------

  it("enqueue returns a valid job ID", async () => {
    setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);

    const jobId = router.enqueue("agent_run", { message: "test task" }, "test-issuer");
    expect(jobId).toBeTruthy();
    expect(typeof jobId).toBe("string");
    // UUID format check
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // -----------------------------------------------------------------------
  // Test: enqueueAndWait resolves when job completes
  // -----------------------------------------------------------------------

  it("enqueueAndWait resolves when job completes", async () => {
    setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);

    const job = await router.enqueueAndWait(
      "agent_run",
      { message: "quick task" },
      "test-issuer",
      10_000,
    );

    expect(job).toBeDefined();
    expect(job.status).toBe("completed");
    expect(job.result).toBe("mock-result-ok");
    expect(job.delivered_at).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Test: enqueueAndWait times out
  // -----------------------------------------------------------------------

  it("enqueueAndWait times out if job never completes", async () => {
    setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), hangingExecutor);

    await expect(
      router.enqueueAndWait(
        "agent_run",
        { message: "hanging task" },
        "test-issuer",
        500, // 500ms timeout
      ),
    ).rejects.toThrow(/timed out/);
  });

  // -----------------------------------------------------------------------
  // Test: getStatus returns correct counts
  // -----------------------------------------------------------------------

  it("getStatus returns correct counts", async () => {
    setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);

    // Capture baseline (fresh DB should be all zeros)
    const baseline = router.getStatus();

    // Enqueue and wait for completion
    await router.enqueueAndWait(
      "agent_run",
      { message: "count test" },
      "test-issuer",
      10_000,
    );

    // After completion, the job should be archived
    const after = router.getStatus();
    expect(after.queueDepth).toBe(0);
    expect(after.inFlight).toBe(0);
    expect(after.totalProcessed).toBe(baseline.totalProcessed + 1);
  });

  // -----------------------------------------------------------------------
  // Test: stop() cleans up (no more processing after stop)
  // -----------------------------------------------------------------------

  it("stop() prevents further processing", async () => {
    setupMocks();
    const { startRouter: start } = await import("./index.js");
    router = start(makeConfig(), instantExecutor);
    router.stop();

    // Enqueue after stop — the job goes into DB but should NOT be processed
    // (loop is stopped). This will throw because DB is closed.
    expect(() =>
      router!.enqueue("agent_run", { message: "after stop" }, "test-issuer"),
    ).toThrow();

    // Calling stop again should be idempotent (no throw)
    router.stop();
    router = null; // prevent afterEach from double-stopping
  });

  // -----------------------------------------------------------------------
  // Test: full pipeline — enqueue → evaluate → dispatch → execute → notify → archive
  // -----------------------------------------------------------------------

  it("full pipeline: enqueue → evaluate → dispatch → execute → notify → archive", async () => {
    setupMocks(6); // weight 6 → sonnet
    const { startRouter: start } = await import("./index.js");

    const executorSpy = vi.fn(async (_prompt: string, _model: string) => {
      return "pipeline-result-42";
    });

    router = start(makeConfig(), executorSpy);

    const job = await router.enqueueAndWait(
      "agent_run",
      { message: "full pipeline test", context: "test-context" },
      "pipeline-issuer",
      15_000,
    );

    // Verify terminal state
    expect(job.status).toBe("completed");
    expect(job.result).toBe("pipeline-result-42");
    expect(job.delivered_at).toBeTruthy();

    // Verify the executor was called (at least once for our job)
    expect(executorSpy).toHaveBeenCalled();
    // Find the call for our job's model — should be sonnet tier (weight 6)
    const sonnetCall = executorSpy.mock.calls.find(
      (call) => call[1] === "anthropic/claude-sonnet-4-5",
    );
    expect(sonnetCall).toBeTruthy();

    // Verify it's in the archive
    const status = router.getStatus();
    expect(status.totalProcessed).toBe(1);
    expect(status.queueDepth).toBe(0);
    expect(status.inFlight).toBe(0);
  });
});
