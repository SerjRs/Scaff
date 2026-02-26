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
  archiveJob,
  enqueue,
  getJob,
  initRouterDb,
  updateJob,
} from "./queue.js";
import { routerEvents } from "./worker.js";
import { deliverResult, startNotifier, waitForJob } from "./notifier.js";
import type { RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Setup — real SQLite (file-per-test), real routerEvents
// ---------------------------------------------------------------------------

describe("notifier", () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-notifier-test-"));
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
    vi.useRealTimers();
    routerEvents.removeAllListeners();
  });

  // -----------------------------------------------------------------------
  // Helper: create a completed job in the DB
  // -----------------------------------------------------------------------

  function createCompletedJob(): string {
    const id = enqueue(db, "agent_run", '{"task":"test"}', "session:issuer");
    updateJob(db, id, {
      status: "completed",
      result: '{"answer":42}',
      finished_at: "2026-02-26 00:00:00",
    });
    return id;
  }

  function createFailedJob(): string {
    const id = enqueue(db, "agent_run", '{"task":"test"}', "session:issuer");
    updateJob(db, id, {
      status: "failed",
      error: "something broke",
      finished_at: "2026-02-26 00:00:00",
    });
    return id;
  }

  // =======================================================================
  // startNotifier
  // =======================================================================

  describe("startNotifier", () => {
    it("registers listeners on routerEvents", () => {
      const before = routerEvents.listenerCount("job:completed");
      const cleanup = startNotifier(db);

      expect(routerEvents.listenerCount("job:completed")).toBe(before + 1);
      expect(routerEvents.listenerCount("job:failed")).toBe(before + 1);

      cleanup();
    });

    it("cleanup function removes listeners", () => {
      const cleanup = startNotifier(db);
      const countBefore = routerEvents.listenerCount("job:completed");

      cleanup();

      expect(routerEvents.listenerCount("job:completed")).toBe(countBefore - 1);
      expect(routerEvents.listenerCount("job:failed")).toBe(countBefore - 1);
    });
  });

  // =======================================================================
  // deliverResult via job:completed
  // =======================================================================

  describe("on job:completed event", () => {
    it("stamps delivered_at on the job", () => {
      const cleanup = startNotifier(db);
      const jobId = createCompletedJob();

      routerEvents.emit("job:completed", { jobId });

      // Job is now archived, but we can check via archive
      const archived = db
        .prepare("SELECT * FROM jobs_archive WHERE id = ?")
        .get(jobId) as RouterJob | undefined;
      expect(archived).toBeDefined();
      expect(archived!.delivered_at).toBeTruthy();

      cleanup();
    });

    it("archives the job (removes from jobs table)", () => {
      const cleanup = startNotifier(db);
      const jobId = createCompletedJob();

      routerEvents.emit("job:completed", { jobId });

      // Gone from jobs
      expect(getJob(db, jobId)).toBeNull();
      // Present in archive
      const archived = db
        .prepare("SELECT * FROM jobs_archive WHERE id = ?")
        .get(jobId) as RouterJob | undefined;
      expect(archived).toBeDefined();

      cleanup();
    });
  });

  // =======================================================================
  // deliverResult via job:failed
  // =======================================================================

  describe("on job:failed event", () => {
    it("stamps delivered_at and archives job", () => {
      const cleanup = startNotifier(db);
      const jobId = createFailedJob();

      routerEvents.emit("job:failed", { jobId, error: "something broke" });

      // Gone from jobs
      expect(getJob(db, jobId)).toBeNull();

      // Present in archive with delivered_at
      const archived = db
        .prepare("SELECT * FROM jobs_archive WHERE id = ?")
        .get(jobId) as RouterJob | undefined;
      expect(archived).toBeDefined();
      expect(archived!.delivered_at).toBeTruthy();
      expect(archived!.status).toBe("failed");

      cleanup();
    });
  });

  // =======================================================================
  // job:delivered event emission
  // =======================================================================

  describe("job:delivered event", () => {
    it("is emitted with job data when deliverResult runs", () => {
      const events: Array<{ jobId: string; job: RouterJob }> = [];
      routerEvents.on("job:delivered", (data) => events.push(data));

      const jobId = createCompletedJob();
      deliverResult(db, jobId);

      expect(events).toHaveLength(1);
      expect(events[0].jobId).toBe(jobId);
      expect(events[0].job).toBeDefined();
      expect(events[0].job.id).toBe(jobId);
      expect(events[0].job.status).toBe("completed");
      expect(events[0].job.delivered_at).toBeTruthy();
    });
  });

  // =======================================================================
  // deliverResult edge cases
  // =======================================================================

  describe("deliverResult", () => {
    it("ignores unknown job IDs (no crash)", () => {
      expect(() => deliverResult(db, "nonexistent-id")).not.toThrow();
    });

    it("ignores non-terminal status jobs", () => {
      const id = enqueue(db, "agent_run", '{}', "session:x");
      updateJob(db, id, { status: "in_execution" });

      const events: unknown[] = [];
      routerEvents.on("job:delivered", (data) => events.push(data));

      deliverResult(db, id);

      // Job should still be in jobs (not archived), no event emitted
      expect(getJob(db, id)).not.toBeNull();
      expect(events).toHaveLength(0);
    });
  });

  // =======================================================================
  // waitForJob
  // =======================================================================

  describe("waitForJob", () => {
    it("resolves when job:delivered fires for matching jobId", async () => {
      const jobId = createCompletedJob();
      const job = getJob(db, jobId)!;

      const promise = waitForJob(db, jobId, 5000);

      // Simulate delivery event
      routerEvents.emit("job:delivered", { jobId, job });

      const result = await promise;
      expect(result.id).toBe(jobId);
      expect(result.status).toBe("completed");
    });

    it("ignores job:delivered for different jobId", async () => {
      vi.useFakeTimers();

      const jobId = createCompletedJob();
      const otherJobId = "other-job-999";

      const promise = waitForJob(db, jobId, 1000);

      // Attach rejection handler before advancing timers
      const rejectAssertion = expect(promise).rejects.toThrow("timed out");

      // Emit for a different job — should not resolve
      routerEvents.emit("job:delivered", {
        jobId: otherJobId,
        job: { id: otherJobId } as RouterJob,
      });

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(1500);

      await rejectAssertion;
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();

      const jobId = "job-that-never-finishes";
      const promise = waitForJob(db, jobId, 2000);

      // Attach rejection handler before advancing timers
      const rejectAssertion = expect(promise).rejects.toThrow(
        /waitForJob timed out after 2000ms/,
      );

      await vi.advanceTimersByTimeAsync(2500);

      await rejectAssertion;
    });

    it("cleans up listener after resolution", async () => {
      const jobId = createCompletedJob();
      const job = getJob(db, jobId)!;

      const listenersBefore = routerEvents.listenerCount("job:delivered");
      const promise = waitForJob(db, jobId, 5000);

      // One listener added
      expect(routerEvents.listenerCount("job:delivered")).toBe(
        listenersBefore + 1,
      );

      routerEvents.emit("job:delivered", { jobId, job });
      await promise;

      // Listener removed
      expect(routerEvents.listenerCount("job:delivered")).toBe(listenersBefore);
    });

    it("cleans up listener after timeout", async () => {
      vi.useFakeTimers();

      const jobId = "timeout-job";
      const listenersBefore = routerEvents.listenerCount("job:delivered");
      const promise = waitForJob(db, jobId, 1000);

      // One listener added
      expect(routerEvents.listenerCount("job:delivered")).toBe(
        listenersBefore + 1,
      );

      // Attach catch handler before advancing timers to avoid unhandled rejection
      const catchPromise = promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1500);
      await catchPromise;

      // Listener removed
      expect(routerEvents.listenerCount("job:delivered")).toBe(listenersBefore);
    });

    it("integrates end-to-end: startNotifier + waitForJob", async () => {
      const cleanup = startNotifier(db);
      const jobId = createCompletedJob();

      const promise = waitForJob(db, jobId, 5000);

      // Trigger the notifier via job:completed
      routerEvents.emit("job:completed", { jobId });

      const result = await promise;
      expect(result.id).toBe(jobId);
      expect(result.delivered_at).toBeTruthy();

      cleanup();
    });
  });
});
