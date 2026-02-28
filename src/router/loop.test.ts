import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { RouterConfig, Tier, TierConfig } from "./types.js";
import type { AgentExecutor } from "./worker.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the evaluator — avoid real LLM calls
const mockEvaluate = vi.fn();
vi.mock("./evaluator.js", () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
}));

// Mock the dispatcher — avoid real worker execution
const mockDispatch = vi.fn();
vi.mock("./dispatcher.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test + real queue operations (after mocks)
// ---------------------------------------------------------------------------

import { startRouterLoop } from "./loop.js";
import { routerEvents } from "./worker.js";
import {
  initRouterDb,
  enqueue,
  dequeue,
  getJob,
  updateJob,
  getHungJobs,
} from "./queue.js";

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

const TEST_TIERS: Record<Tier, TierConfig> = {
  haiku: { range: [1, 3], model: "anthropic/claude-haiku-4-5" },
  sonnet: { range: [4, 7], model: "anthropic/claude-sonnet-4-6" },
  opus: { range: [8, 10], model: "anthropic/claude-opus-4-6" },
};

const TEST_CONFIG: RouterConfig = {
  enabled: true,
  evaluator: {
    model: "anthropic/claude-sonnet-4-6",
    tier: "sonnet",
    timeout: 10,
    fallback_weight: 5,
  },
  tiers: TEST_TIERS,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

function freshDb(): DatabaseSync {
  const dbPath = path.join(
    tmpDir,
    `loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  return initRouterDb(dbPath);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-loop-test-"));
  vi.clearAllMocks();
  vi.useFakeTimers();
  routerEvents.removeAllListeners();

  // Default: evaluator returns weight 5 (sonnet)
  mockEvaluate.mockResolvedValue({ weight: 5, reasoning: "moderate complexity" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startRouterLoop", () => {
  // -----------------------------------------------------------------------
  // 1. Loop picks up in_queue job and processes it
  // -----------------------------------------------------------------------

  it("picks up in_queue job: evaluate → update weight → dispatch", async () => {
    const db = freshDb();
    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "What is 2+2?", context: "math" }),
      "session:test",
    );

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Advance 1 second to trigger first processTick
    await vi.advanceTimersByTimeAsync(1_000);

    // Evaluator should have been called with the message
    expect(mockEvaluate).toHaveBeenCalledWith(
      TEST_CONFIG.evaluator,
      "What is 2+2?",
      "math",
    );

    // Job should have been updated to pending with weight
    const job = getJob(db, jobId);
    // After evaluate + dispatch, job is handed to dispatcher which would set in_execution.
    // But we mocked dispatch, so it stays at pending (the updateJob in loop sets pending, then dispatch is mocked).
    // Check that dispatch was called
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockDispatch.mock.calls[0];
    expect(dispatchArgs[0]).toBe(db); // db
    expect(dispatchArgs[1].id).toBe(jobId); // the updated job
    expect(dispatchArgs[2]).toBe(TEST_CONFIG); // config

    // The job in db should be pending with weight set (dispatch is mocked, doesn't change status)
    expect(job).not.toBeNull();
    expect(job!.status).toBe("pending");
    expect(job!.weight).toBe(5);

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 2. Loop does nothing when queue is empty
  // -----------------------------------------------------------------------

  it("does nothing when queue is empty", async () => {
    const db = freshDb();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Advance several seconds
    await vi.advanceTimersByTimeAsync(5_000);

    // Neither evaluator nor dispatcher should have been called
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 3. Loop handles evaluator returning fallback weight
  // -----------------------------------------------------------------------

  it("handles evaluator returning fallback weight", async () => {
    const db = freshDb();
    mockEvaluate.mockResolvedValue({
      weight: 5,
      reasoning: "evaluator failed, using fallback",
    });

    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "complex task" }),
      "session:test",
    );

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    const job = getJob(db, jobId);
    expect(job!.weight).toBe(5);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 4. Loop catches errors during processing and marks job failed
  // -----------------------------------------------------------------------

  it("catches dispatch errors and marks job as failed", async () => {
    const db = freshDb();
    mockDispatch.mockImplementation(() => {
      throw new Error("dispatch exploded");
    });

    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "hello" }),
      "session:test",
    );

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    const job = getJob(db, jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("dispatch exploded");

    handle.stop();
    db.close();
  });

  it("catches evaluator rejection and marks job as failed", async () => {
    const db = freshDb();
    // Make evaluate throw (it normally never does, but test the safety net)
    mockEvaluate.mockRejectedValue(new Error("evaluate threw unexpectedly"));

    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "hello" }),
      "session:test",
    );

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    const job = getJob(db, jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("evaluate threw unexpectedly");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 5. Watchdog detects hung job and resets to pending
  // -----------------------------------------------------------------------

  it("watchdog detects hung job (stale checkpoint) and resets to pending", async () => {
    const db = freshDb();

    // Insert a job directly in_execution with old checkpoint (200s ago)
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('hung-1', 'agent_run', 'in_execution', '{}', 'session:x',
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now'), 0)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Advance to trigger watchdog (30s)
    await vi.advanceTimersByTimeAsync(30_000);

    // Watchdog schedules a delayed reset (5s). Advance past that.
    await vi.advanceTimersByTimeAsync(6_000);

    const job = getJob(db, "hung-1");
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(1);

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 6. Watchdog marks job as permanently failed after 2 retries
  // -----------------------------------------------------------------------

  it("watchdog marks job as permanently failed after max retries", async () => {
    const db = freshDb();

    // Insert a hung job that has already retried twice
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('hung-2', 'agent_run', 'in_execution', '{}', 'session:x',
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now'), 2)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Advance to trigger watchdog
    await vi.advanceTimersByTimeAsync(30_000);

    const job = getJob(db, "hung-2");
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("hung: no checkpoint for 90s");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 7. Retry job gets re-dispatched (pending with tier → dispatch, skip evaluation)
  // -----------------------------------------------------------------------

  it("retry job gets dispatched directly, skipping evaluation", async () => {
    const db = freshDb();

    // Insert a job in 'pending' state with tier already set (retry scenario)
    // Set updated_at far in the past so the retry delay check passes
    db.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer, created_at, updated_at, retry_count)
       VALUES ('retry-1', 'agent_run', 'pending', 5, 'sonnet', '{"message":"retry me"}', 'session:x',
               datetime('now', '-60 seconds'),
               datetime('now', '-60 seconds'), 1)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Advance 1 second to trigger processTick
    await vi.advanceTimersByTimeAsync(1_000);

    // Evaluator should NOT have been called (retry skips evaluation)
    expect(mockEvaluate).not.toHaveBeenCalled();

    // Dispatcher should have been called with the retry job
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1].id).toBe("retry-1");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 8. stop() clears all intervals
  // -----------------------------------------------------------------------

  it("stop() prevents further processing", async () => {
    const db = freshDb();

    const handle = startRouterLoop(db, TEST_CONFIG);
    handle.stop();

    // Enqueue after stopping
    enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "too late" }),
      "session:test",
    );

    // Advance plenty of time
    await vi.advanceTimersByTimeAsync(60_000);

    // Nothing should have been processed
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    db.close();
  });

  it("stop() clears pending watchdog timeouts", async () => {
    const db = freshDb();

    // Insert a hung job
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at, retry_count)
       VALUES ('hung-stop', 'agent_run', 'in_execution', '{}', 'session:x',
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now', '-200 seconds'),
               datetime('now'), 0)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Trigger watchdog — it schedules a 5s delayed reset
    await vi.advanceTimersByTimeAsync(30_000);

    // Stop immediately (before the 5s delay fires)
    handle.stop();

    // Advance past the delay
    await vi.advanceTimersByTimeAsync(10_000);

    // Job should still be in_execution — the timeout was cleared
    const job = getJob(db, "hung-stop");
    expect(job!.status).toBe("in_execution");

    db.close();
  });

  // -----------------------------------------------------------------------
  // 9. Multiple jobs processed in FIFO order
  // -----------------------------------------------------------------------

  it("processes multiple jobs in FIFO order", async () => {
    const db = freshDb();

    // Insert 3 jobs with explicit created_at for ordering
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
       VALUES ('fifo-1', 'agent_run', 'in_queue', '{"message":"first"}', 'session:x',
               datetime('now', '-3 seconds'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
       VALUES ('fifo-2', 'agent_run', 'in_queue', '{"message":"second"}', 'session:x',
               datetime('now', '-2 seconds'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
       VALUES ('fifo-3', 'agent_run', 'in_queue', '{"message":"third"}', 'session:x',
               datetime('now', '-1 seconds'), datetime('now'))`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // Process all 3 jobs (one per tick)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    // Check dispatch order
    expect(mockDispatch).toHaveBeenCalledTimes(3);
    expect(mockDispatch.mock.calls[0][1].id).toBe("fifo-1");
    expect(mockDispatch.mock.calls[1][1].id).toBe("fifo-2");
    expect(mockDispatch.mock.calls[2][1].id).toBe("fifo-3");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 10. Retry job respects 5-second delay
  // -----------------------------------------------------------------------

  it("retry job is not dispatched until 5 seconds after updated_at", async () => {
    const db = freshDb();

    // Insert a pending retry with very recent updated_at (just now)
    db.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer, created_at, updated_at, retry_count)
       VALUES ('retry-fresh', 'agent_run', 'pending', 5, 'sonnet', '{"message":"wait"}', 'session:x',
               datetime('now', '-10 seconds'),
               datetime('now'), 1)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);

    // First tick — retry should NOT be picked up (updated_at too recent)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockDispatch).not.toHaveBeenCalled();

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 11. Payload with missing context handled gracefully
  // -----------------------------------------------------------------------

  it("handles payload with no context field", async () => {
    const db = freshDb();
    enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "just a message" }),
      "session:test",
    );

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockEvaluate).toHaveBeenCalledWith(
      TEST_CONFIG.evaluator,
      "just a message",
      undefined,
    );

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 12. Dispatch error on retry marks job failed
  // -----------------------------------------------------------------------

  it("catches dispatch error on retry and marks job failed", async () => {
    const db = freshDb();
    mockDispatch.mockImplementation(() => {
      throw new Error("retry dispatch failed");
    });

    // Insert a retry job
    db.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer, created_at, updated_at, retry_count)
       VALUES ('retry-fail', 'agent_run', 'pending', 5, 'sonnet', '{"message":"fail"}', 'session:x',
               datetime('now', '-60 seconds'),
               datetime('now', '-60 seconds'), 1)`,
    ).run();

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    const job = getJob(db, "retry-fail");
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("retry dispatch failed");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 13. job:failed event emitted on dispatch error
  // -----------------------------------------------------------------------

  it("emits job:failed event when dispatch throws", async () => {
    const db = freshDb();
    mockDispatch.mockImplementation(() => {
      throw new Error("dispatch exploded");
    });

    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "hello" }),
      "session:test",
    );

    const failedEvents: { jobId: string; error: string }[] = [];
    routerEvents.on("job:failed", (evt: { jobId: string; error: string }) => {
      failedEvents.push(evt);
    });

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].jobId).toBe(jobId);
    expect(failedEvents[0].error).toBe("dispatch exploded");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 14. job:failed event emitted on evaluator rejection
  // -----------------------------------------------------------------------

  it("emits job:failed event when evaluator throws", async () => {
    const db = freshDb();
    mockEvaluate.mockRejectedValue(new Error("evaluator crashed"));

    const jobId = enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "test" }),
      "session:test",
    );

    const failedEvents: { jobId: string; error: string }[] = [];
    routerEvents.on("job:failed", (evt: { jobId: string; error: string }) => {
      failedEvents.push(evt);
    });

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].jobId).toBe(jobId);
    expect(failedEvents[0].error).toBe("evaluator crashed");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 15. job:failed event emitted on retry dispatch error
  // -----------------------------------------------------------------------

  it("emits job:failed event when retry dispatch throws", async () => {
    const db = freshDb();
    mockDispatch.mockImplementation(() => {
      throw new Error("retry boom");
    });

    db.prepare(
      `INSERT INTO jobs (id, type, status, weight, tier, payload, issuer, created_at, updated_at, retry_count)
       VALUES ('retry-emit', 'agent_run', 'pending', 5, 'sonnet', '{"message":"fail"}', 'session:x',
               datetime('now', '-60 seconds'),
               datetime('now', '-60 seconds'), 1)`,
    ).run();

    const failedEvents: { jobId: string; error: string }[] = [];
    routerEvents.on("job:failed", (evt: { jobId: string; error: string }) => {
      failedEvents.push(evt);
    });

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].jobId).toBe("retry-emit");
    expect(failedEvents[0].error).toBe("retry boom");

    handle.stop();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 16. No job:failed event on successful dispatch
  // -----------------------------------------------------------------------

  it("does not emit job:failed on successful dispatch", async () => {
    const db = freshDb();

    // Explicitly reset mockDispatch to a no-op (clears any throwing impl from prior tests)
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});

    enqueue(
      db,
      "agent_run",
      JSON.stringify({ message: "success" }),
      "session:test",
    );

    const failedEvents: unknown[] = [];
    routerEvents.on("job:failed", (evt: unknown) => {
      failedEvents.push(evt);
    });

    const handle = startRouterLoop(db, TEST_CONFIG);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failedEvents).toHaveLength(0);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    handle.stop();
    db.close();
  });
});
