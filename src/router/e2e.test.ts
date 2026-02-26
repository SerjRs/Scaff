/**
 * End-to-end tests for the Router pipeline.
 *
 * Uses real SQLite (temp paths), mocked evaluator (to control weights
 * without LLM calls), and mock executors.
 *
 * 10 test scenarios covering: happy paths (sync/async), tier routing,
 * evaluator failure, retries, permanent failure, hang detection,
 * crash recovery, and archive queries.
 */

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

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing modules under test
// ---------------------------------------------------------------------------

const mockEvaluate = vi.fn();
vi.mock("./evaluator.js", () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
}));

// ---------------------------------------------------------------------------
// Static imports (after mocks are declared)
// ---------------------------------------------------------------------------

import { routerEvents } from "./worker.js";
import { recover } from "./recovery.js";
import { startNotifier, waitForJob } from "./notifier.js";
import { startRouterLoop } from "./loop.js";
import {
  initRouterDb,
  enqueue as dbEnqueue,
  getJob,
  updateJob,
  queryArchive,
} from "./queue.js";
import type { RouterConfig, RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

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

function freshDbPath(): string {
  return path.join(
    tmpDir,
    `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-router-e2e-"));
});

beforeEach(() => {
  vi.clearAllMocks();
  routerEvents.removeAllListeners();
  // Default evaluator: weight 5 → sonnet
  mockEvaluate.mockResolvedValue({ weight: 5, reasoning: "mock evaluation" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: assemble a router manually with custom DB path
// ---------------------------------------------------------------------------

interface TestRouter {
  enqueue: (
    type: "agent_run",
    payload: { message: string; context?: string },
    issuer: string,
  ) => string;
  enqueueAndWait: (
    type: "agent_run",
    payload: { message: string; context?: string },
    issuer: string,
    timeoutMs?: number,
  ) => Promise<RouterJob>;
  stop: () => void;
  getStatus: () => { queueDepth: number; inFlight: number; totalProcessed: number };
  db: import("node:sqlite").DatabaseSync;
  dbPath: string;
}

function startTestRouter(
  executor: (prompt: string, model: string) => Promise<string>,
  config?: RouterConfig,
): TestRouter {
  const dbPath = freshDbPath();
  const db = initRouterDb(dbPath);
  const cfg = config ?? makeConfig();

  recover(db);
  const stopNotifier = startNotifier(db);
  const loop = startRouterLoop(db, cfg, executor);

  let stopped = false;

  function enqueue(
    type: "agent_run",
    payload: { message: string; context?: string },
    issuer: string,
  ): string {
    return dbEnqueue(db, type, JSON.stringify(payload), issuer);
  }

  async function enqueueAndWait(
    type: "agent_run",
    payload: { message: string; context?: string },
    issuer: string,
    timeoutMs?: number,
  ): Promise<RouterJob> {
    const jobId = enqueue(type, payload, issuer);
    return waitForJob(db, jobId, timeoutMs);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    loop.stop();
    stopNotifier();
    try { db.close(); } catch {}
  }

  function getStatus() {
    const depthRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs WHERE status IN ('in_queue', 'evaluating', 'pending')`,
      )
      .get() as { count: number };
    const inFlightRow = db
      .prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'in_execution'`)
      .get() as { count: number };
    const archivedRow = db
      .prepare(`SELECT COUNT(*) as count FROM jobs_archive`)
      .get() as { count: number };
    return {
      queueDepth: depthRow.count,
      inFlight: inFlightRow.count,
      totalProcessed: archivedRow.count,
    };
  }

  return { enqueue, enqueueAndWait, stop, getStatus, db, dbPath };
}

// ---------------------------------------------------------------------------
// E2E Test Suite
// ---------------------------------------------------------------------------

describe("Router E2E pipeline", () => {
  let testRouter: TestRouter | null = null;

  afterEach(async () => {
    if (testRouter) {
      testRouter.stop();
      testRouter = null;
    }
    routerEvents.removeAllListeners();
    await sleep(50);
  });

  // -----------------------------------------------------------------------
  // 1. Happy path (sync): enqueueAndWait returns result inline
  // -----------------------------------------------------------------------

  it("1. Happy path (sync): enqueueAndWait returns result inline", async () => {
    const executor = vi.fn(async () => "result: success");
    testRouter = startTestRouter(executor);

    const job = await testRouter.enqueueAndWait(
      "agent_run",
      { message: "test task" },
      "test-issuer",
      10_000,
    );

    expect(job).toBeDefined();
    expect(job.status).toBe("completed");
    expect(job.result).toBe("result: success");
    expect(job.delivered_at).toBeTruthy();

    // Job should be in archive
    const status = testRouter.getStatus();
    expect(status.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(status.queueDepth).toBe(0);
    expect(status.inFlight).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2. Happy path (async): enqueue + listen for job:delivered event
  // -----------------------------------------------------------------------

  it("2. Happy path (async): enqueue fires job:delivered event", async () => {
    const executor = vi.fn(async () => "async-result-ok");
    testRouter = startTestRouter(executor);

    const delivered = new Promise<{ jobId: string; job: RouterJob }>(
      (resolve) => {
        routerEvents.on("job:delivered", (data) => resolve(data));
      },
    );

    const jobId = testRouter.enqueue(
      "agent_run",
      { message: "test task" },
      "test-issuer",
    );
    expect(jobId).toBeTruthy();

    const result = await delivered;
    expect(result.jobId).toBe(jobId);
    expect(result.job.status).toBe("completed");
    expect(result.job.result).toBe("async-result-ok");
    expect(result.job.delivered_at).toBeTruthy();

    const status = testRouter.getStatus();
    expect(status.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // 3. Trivial task → Haiku tier (weight 2)
  // -----------------------------------------------------------------------

  it("3. Trivial task → Haiku tier (weight 2)", async () => {
    mockEvaluate.mockResolvedValue({ weight: 2, reasoning: "trivial task" });

    const executorSpy = vi.fn(async (_prompt: string, model: string) => {
      expect(model).toBe("anthropic/claude-haiku-4-5");
      return "haiku-result";
    });
    testRouter = startTestRouter(executorSpy);

    const job = await testRouter.enqueueAndWait(
      "agent_run",
      { message: "what is 2+2" },
      "test-issuer",
      10_000,
    );

    expect(job.status).toBe("completed");
    expect(job.tier).toBe("haiku");
    expect(job.weight).toBe(2);
    expect(job.result).toBe("haiku-result");
    expect(executorSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 4. Complex task → Opus tier (weight 9)
  // -----------------------------------------------------------------------

  it("4. Complex task → Opus tier (weight 9)", async () => {
    mockEvaluate.mockResolvedValue({
      weight: 9,
      reasoning: "very complex task",
    });

    const executorSpy = vi.fn(async (_prompt: string, model: string) => {
      expect(model).toBe("anthropic/claude-opus-4-6");
      return "opus-result";
    });
    testRouter = startTestRouter(executorSpy);

    const job = await testRouter.enqueueAndWait(
      "agent_run",
      { message: "design a distributed system" },
      "test-issuer",
      10_000,
    );

    expect(job.status).toBe("completed");
    expect(job.tier).toBe("opus");
    expect(job.weight).toBe(9);
    expect(job.result).toBe("opus-result");
    expect(executorSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 5. Evaluator failure → fallback weight (5) → sonnet tier
  // -----------------------------------------------------------------------

  it("5. Evaluator failure → fallback weight 5 → sonnet tier", async () => {
    // The real evaluate() never throws — it catches internally and returns
    // fallback. Since we mock it, simulate what the real function does on failure:
    mockEvaluate.mockResolvedValue({
      weight: 5,
      reasoning: "evaluator failed, using fallback",
    });

    const executor = vi.fn(async (_prompt: string, model: string) => {
      expect(model).toBe("anthropic/claude-sonnet-4-5");
      return "fallback-result";
    });
    testRouter = startTestRouter(executor);

    const job = await testRouter.enqueueAndWait(
      "agent_run",
      { message: "test task" },
      "test-issuer",
      10_000,
    );

    expect(job.status).toBe("completed");
    expect(job.weight).toBe(5);
    expect(job.tier).toBe("sonnet");
    expect(job.result).toBe("fallback-result");
  });

  // -----------------------------------------------------------------------
  // 6. Worker failure + retry success (via pre-seeded retry job)
  // -----------------------------------------------------------------------

  it("6. Worker failure + retry: pre-seeded retry job succeeds", async () => {
    const dbPath = freshDbPath();
    const db = initRouterDb(dbPath);

    // Pre-seed a job that "already failed once" — pending with retry_count=1, tier set.
    // The loop's dequeueRetry will pick it up and dispatch directly (skip evaluation).
    db.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer,
                         created_at, updated_at, retry_count)
       VALUES ('retry-job', 'agent_run', 'pending', 5, 'sonnet',
               '{"message":"retry test"}', 'test-issuer',
               datetime('now', '-30 seconds'),
               datetime('now', '-30 seconds'), 1)`,
    ).run();

    const stopNotifier = startNotifier(db);
    const executor = vi.fn(async () => "retry-success");
    const loop = startRouterLoop(db, makeConfig(), executor);

    const delivered = new Promise<RouterJob>((resolve) => {
      routerEvents.on("job:delivered", (data: { jobId: string; job: RouterJob }) => {
        if (data.jobId === "retry-job") resolve(data.job);
      });
    });

    const job = await delivered;

    expect(job.status).toBe("completed");
    expect(job.result).toBe("retry-success");
    expect(job.retry_count).toBe(1);
    expect(executor).toHaveBeenCalled();

    loop.stop();
    stopNotifier();
    try { db.close(); } catch {}
  });

  // -----------------------------------------------------------------------
  // 7. Permanent failure: executor always fails
  // -----------------------------------------------------------------------

  it("7. Permanent failure: executor always fails, job ends up failed", async () => {
    const executor = vi.fn(async () => {
      throw new Error("permanent failure");
    });
    testRouter = startTestRouter(executor);

    const job = await testRouter.enqueueAndWait(
      "agent_run",
      { message: "doomed task" },
      "test-issuer",
      10_000,
    );

    expect(job.status).toBe("failed");
    expect(job.error).toBe("permanent failure");

    const status = testRouter.getStatus();
    expect(status.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // 7b. Permanent failure via recovery (2 retries exhausted, hung job)
  // -----------------------------------------------------------------------

  it("7b. Permanent failure via recovery: hung job exhausts retries", async () => {
    const dbPath = freshDbPath();
    const db1 = initRouterDb(dbPath);

    // Seed a hung job with retry_count=2 (exhausted)
    db1.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer,
                         started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('perm-fail', 'agent_run', 'in_execution', 5, 'sonnet',
               '{"message":"hung forever"}', 'test-issuer',
               datetime('now', '-300 seconds'),
               datetime('now', '-300 seconds'),
               datetime('now', '-300 seconds'),
               datetime('now'), 2)`,
    ).run();
    db1.close();

    // "Restart" — recovery should mark it failed and re-deliver
    const db2 = initRouterDb(dbPath);

    const delivered = new Promise<RouterJob>((resolve) => {
      routerEvents.on("job:delivered", (data: { jobId: string; job: RouterJob }) => {
        if (data.jobId === "perm-fail") resolve(data.job);
      });
    });

    const { recovered, failed } = recover(db2);
    expect(failed).toBe(1);

    // Recovery calls deliverResult for undelivered failed jobs
    const stopNotifier = startNotifier(db2);

    const job = await delivered;

    expect(job.status).toBe("failed");
    expect(job.error).toBe("gateway crash: max retries exceeded");
    expect(job.retry_count).toBe(2);

    stopNotifier();
    try { db2.close(); } catch {}
  });

  // -----------------------------------------------------------------------
  // 8. Hang detection: watchdog via recovery path
  // -----------------------------------------------------------------------

  it("8. Hang detection: recovery resets hung job for retry", async () => {
    // Note: the loop's dequeueRetry has a 5-second delay check on updated_at,
    // and recovery bumps updated_at. So the retry won't fire for ~6 seconds.
    const dbPath = freshDbPath();
    const db1 = initRouterDb(dbPath);

    // Seed a job in 'in_execution' with old checkpoint, retry_count=0
    db1.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer,
                         started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('hang-detect', 'agent_run', 'in_execution', 5, 'sonnet',
               '{"message":"hung task"}', 'test-issuer',
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now'), 0)`,
    ).run();
    db1.close();

    // Recovery should reset to pending with retry_count=1
    const db2 = initRouterDb(dbPath);
    const { recovered } = recover(db2);
    expect(recovered).toBe(1);

    // Verify job state after recovery
    const jobAfterRecovery = getJob(db2, "hang-detect");
    expect(jobAfterRecovery!.status).toBe("pending");
    expect(jobAfterRecovery!.retry_count).toBe(1);

    // Now start loop — it should dispatch the pending retry
    const stopNotifier = startNotifier(db2);
    const executor = vi.fn(async () => "recovered-result");

    const delivered = new Promise<RouterJob>((resolve) => {
      routerEvents.on("job:delivered", (data: { jobId: string; job: RouterJob }) => {
        if (data.jobId === "hang-detect") resolve(data.job);
      });
    });

    const loop = startRouterLoop(db2, makeConfig(), executor);

    const job = await delivered;

    expect(job.status).toBe("completed");
    expect(job.result).toBe("recovered-result");
    expect(job.retry_count).toBe(1);
    expect(executor).toHaveBeenCalled();

    loop.stop();
    stopNotifier();
    try { db2.close(); } catch {}
  }, 15_000);

  // -----------------------------------------------------------------------
  // 9. Gateway crash recovery
  // -----------------------------------------------------------------------

  it("9. Gateway crash recovery: stuck jobs are recovered correctly", async () => {
    const dbPath = freshDbPath();

    // Phase 1: seed DB with jobs in various crash states
    const db1 = initRouterDb(dbPath);

    // Job stuck in 'evaluating' → should reset to 'in_queue'
    db1.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
       VALUES ('crash-eval', 'agent_run', 'evaluating',
               '{"message":"eval-stuck"}', 'issuer-a',
               datetime('now', '-60 seconds'), datetime('now'))`,
    ).run();

    // Job stuck in 'in_execution' retry_count=0 → should reset to 'pending'
    db1.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer,
                         started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('crash-exec', 'agent_run', 'in_execution', 5, 'sonnet',
               '{"message":"exec-stuck"}', 'issuer-b',
               datetime('now', '-120 seconds'),
               datetime('now', '-120 seconds'),
               datetime('now', '-120 seconds'),
               datetime('now'), 0)`,
    ).run();

    // Job stuck in 'in_execution' retry_count=2 → should be marked 'failed'
    db1.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer,
                         started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('crash-maxed', 'agent_run', 'in_execution', 7, 'sonnet',
               '{"message":"maxed-out"}', 'issuer-c',
               datetime('now', '-120 seconds'),
               datetime('now', '-120 seconds'),
               datetime('now', '-120 seconds'),
               datetime('now'), 2)`,
    ).run();

    db1.close();

    // Phase 2: "restart" — run recovery
    const db2 = initRouterDb(dbPath);
    const { recovered, failed } = recover(db2);
    expect(recovered).toBe(2); // evaluating + in_execution(retry<2)
    expect(failed).toBe(1);    // in_execution retry>=2

    // Verify individual states
    const evalJob = getJob(db2, "crash-eval");
    expect(evalJob!.status).toBe("in_queue");

    const execJob = getJob(db2, "crash-exec");
    expect(execJob!.status).toBe("pending");
    expect(execJob!.retry_count).toBe(1);

    // crash-maxed: recovery marked failed, then re-delivered → archived
    const maxedJob = getJob(db2, "crash-maxed");
    if (maxedJob) {
      // Still in jobs (not yet archived — delivery not triggered yet)
      expect(maxedJob.status).toBe("failed");
    } else {
      // Already archived by recovery's re-delivery
      const archived = queryArchive(db2, { issuer: "issuer-c" });
      expect(archived.length).toBe(1);
      expect(archived[0].status).toBe("failed");
    }

    // Phase 3: start loop to process recovered jobs
    const stopNotifier = startNotifier(db2);
    const executor = vi.fn(async () => "recovered-result");

    const deliveredJobs = new Map<string, RouterJob>();
    routerEvents.on("job:delivered", (data: { jobId: string; job: RouterJob }) => {
      deliveredJobs.set(data.jobId, data.job);
    });

    const loop = startRouterLoop(db2, makeConfig(), executor);

    // Wait for recovered jobs to process
    await sleep(4_000);

    // Both recovered jobs should have been processed
    expect(executor).toHaveBeenCalled();

    // Verify archive has entries
    const allArchived = queryArchive(db2);
    expect(allArchived.length).toBeGreaterThanOrEqual(2);

    loop.stop();
    stopNotifier();
    try { db2.close(); } catch {}
  }, 15_000);

  // -----------------------------------------------------------------------
  // 10. Archive queries: run 5 jobs, query by issuer/status/date
  // -----------------------------------------------------------------------

  it("10. Archive queries: queryArchive by issuer, status, date", async () => {
    const dbPath = freshDbPath();
    const db = initRouterDb(dbPath);

    recover(db);
    const stopNotifier = startNotifier(db);

    let callNum = 0;
    const executor = vi.fn(async () => {
      callNum++;
      if (callNum === 2 || callNum === 4) {
        throw new Error(`failure-${callNum}`);
      }
      return `success-${callNum}`;
    });

    const loop = startRouterLoop(db, makeConfig(), executor);

    // Submit 5 jobs sequentially
    const results: RouterJob[] = [];
    for (let i = 1; i <= 5; i++) {
      const issuer = i <= 3 ? "issuer-alpha" : "issuer-beta";
      const jobId = dbEnqueue(
        db,
        "agent_run",
        JSON.stringify({ message: `archive-task-${i}` }),
        issuer,
      );
      const job = await waitForJob(db, jobId, 10_000);
      results.push(job);
    }

    // All 5 should have been processed
    expect(results.length).toBe(5);

    // Query archive by issuer
    const alphaArchive = queryArchive(db, { issuer: "issuer-alpha" });
    expect(alphaArchive.length).toBe(3);

    const betaArchive = queryArchive(db, { issuer: "issuer-beta" });
    expect(betaArchive.length).toBe(2);

    // Query archive by status
    const completedArchive = queryArchive(db, { status: "completed" });
    expect(completedArchive.length).toBe(3);

    const failedArchive = queryArchive(db, { status: "failed" });
    expect(failedArchive.length).toBe(2);

    // Query all
    const allArchive = queryArchive(db);
    expect(allArchive.length).toBe(5);

    // Query by date — all should be recent
    const recentArchive = queryArchive(db, {
      created_after: "2020-01-01 00:00:00",
    });
    expect(recentArchive.length).toBe(5);

    // Future date should return nothing
    const futureArchive = queryArchive(db, {
      created_after: "2099-01-01 00:00:00",
    });
    expect(futureArchive.length).toBe(0);

    loop.stop();
    stopNotifier();
    try { db.close(); } catch {}
  }, 30_000);
});
