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
  enqueue,
  getJob,
  initRouterDb,
  updateJob,
} from "./queue.js";
import { routerEvents } from "./worker.js";
import { recover } from "./recovery.js";
import type { RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Setup — real SQLite (file-per-test), real routerEvents
// ---------------------------------------------------------------------------

describe("recovery", () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-test-"));
  });

  beforeEach(() => {
    const dbPath = path.join(
      tmpDir,
      `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    db = initRouterDb(dbPath);
    routerEvents.removeAllListeners();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    vi.restoreAllMocks();
    routerEvents.removeAllListeners();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Create a job and set it to a specific status with optional fields. */
  function seedJob(
    status: string,
    fields?: Partial<Pick<RouterJob, "retry_count" | "result" | "error" | "finished_at" | "delivered_at" | "tier" | "weight">>,
  ): string {
    const id = enqueue(db, "agent_run", '{"task":"test"}', "session:issuer");
    updateJob(db, id, { status: status as RouterJob["status"], ...fields });
    return id;
  }

  // =======================================================================
  // Evaluating jobs → reset to in_queue
  // =======================================================================

  it("resets evaluating job to in_queue", () => {
    const id = seedJob("evaluating");

    const result = recover(db);

    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("in_queue");
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
  });

  // =======================================================================
  // in_execution jobs — retry logic
  // =======================================================================

  it("resets in_execution job with retry_count 0 to pending, retry_count becomes 1", () => {
    const id = seedJob("in_execution", { retry_count: 0 });

    const result = recover(db);

    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("resets in_execution job with retry_count 1 to pending, retry_count becomes 2", () => {
    const id = seedJob("in_execution", { retry_count: 1 });

    const result = recover(db);

    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("marks in_execution job with retry_count 2 as failed", () => {
    const id = seedJob("in_execution", { retry_count: 2 });

    const result = recover(db);

    // Job was marked failed, then re-delivered (undelivered terminal) → archived
    // Check the archive instead of jobs table
    const archived = db
      .prepare("SELECT * FROM jobs_archive WHERE id = ?")
      .get(id) as RouterJob | undefined;
    expect(archived).toBeDefined();
    expect(archived!.status).toBe("failed");
    expect(archived!.error).toBe("gateway crash: max retries exceeded");
    expect(archived!.finished_at).toBeTruthy();
    expect(archived!.delivered_at).toBeTruthy();
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
  });

  // =======================================================================
  // Undelivered terminal jobs → deliverResult called
  // =======================================================================

  it("re-delivers undelivered completed job", () => {
    const id = seedJob("completed", {
      result: '{"answer":42}',
      finished_at: "2026-02-26 00:00:00",
    });

    const delivered: string[] = [];
    routerEvents.on("job:delivered", (data: { jobId: string }) => {
      delivered.push(data.jobId);
    });

    recover(db);

    // deliverResult archives the job, so it should be gone from jobs
    expect(getJob(db, id)).toBeNull();
    // And present in archive
    const archived = db
      .prepare("SELECT * FROM jobs_archive WHERE id = ?")
      .get(id) as RouterJob | undefined;
    expect(archived).toBeDefined();
    expect(archived!.delivered_at).toBeTruthy();
    // Event emitted
    expect(delivered).toContain(id);
  });

  it("re-delivers undelivered failed job", () => {
    const id = seedJob("failed", {
      error: "something broke",
      finished_at: "2026-02-26 00:00:00",
    });

    const delivered: string[] = [];
    routerEvents.on("job:delivered", (data: { jobId: string }) => {
      delivered.push(data.jobId);
    });

    recover(db);

    expect(getJob(db, id)).toBeNull();
    const archived = db
      .prepare("SELECT * FROM jobs_archive WHERE id = ?")
      .get(id) as RouterJob | undefined;
    expect(archived).toBeDefined();
    expect(archived!.delivered_at).toBeTruthy();
    expect(delivered).toContain(id);
  });

  it("does NOT re-deliver already delivered completed job", () => {
    const id = seedJob("completed", {
      result: '{"answer":42}',
      finished_at: "2026-02-26 00:00:00",
      delivered_at: "2026-02-26 00:01:00",
    });

    const delivered: string[] = [];
    routerEvents.on("job:delivered", (data: { jobId: string }) => {
      delivered.push(data.jobId);
    });

    recover(db);

    // Job should still be in jobs table (not re-delivered/re-archived)
    const job = getJob(db, id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
    expect(delivered).not.toContain(id);
  });

  // =======================================================================
  // No stuck jobs
  // =======================================================================

  it("returns { recovered: 0, failed: 0 } when no stuck jobs", () => {
    const result = recover(db);

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
  });

  // =======================================================================
  // Mixed stuck jobs → correct counts
  // =======================================================================

  it("handles mixed stuck jobs with correct counts", () => {
    // 1 evaluating → recovered
    seedJob("evaluating");

    // 2 in_execution with retries left → recovered
    seedJob("in_execution", { retry_count: 0 });
    seedJob("in_execution", { retry_count: 1 });

    // 1 in_execution at max retries → failed
    seedJob("in_execution", { retry_count: 2 });

    // 1 undelivered completed → re-delivered (not counted in recovered/failed)
    seedJob("completed", {
      result: '"ok"',
      finished_at: "2026-02-26 00:00:00",
    });

    const result = recover(db);

    expect(result.recovered).toBe(3); // 1 evaluating + 2 in_execution retryable
    expect(result.failed).toBe(1);    // 1 in_execution max retries
  });

  // =======================================================================
  // Recovery doesn't touch in_queue or pending jobs
  // =======================================================================

  it("does not touch in_queue or pending jobs", () => {
    const inQueueId = seedJob("in_queue");
    const pendingId = seedJob("pending", { weight: 5, tier: "sonnet" });

    const result = recover(db);

    const inQueueJob = getJob(db, inQueueId);
    expect(inQueueJob).not.toBeNull();
    expect(inQueueJob!.status).toBe("in_queue");

    const pendingJob = getJob(db, pendingId);
    expect(pendingJob).not.toBeNull();
    expect(pendingJob!.status).toBe("pending");

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
  });
});
