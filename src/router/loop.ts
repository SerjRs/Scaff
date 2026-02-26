import type { DatabaseSync } from "node:sqlite";
import { dequeue, getHungJobs, getJob, updateJob } from "./queue.js";
import { evaluate } from "./evaluator.js";
import { dispatch } from "./dispatcher.js";
import type { AgentExecutor } from "./worker.js";
import type { RouterConfig, RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOP_INTERVAL_MS = 1_000; // poll every 1 second
const WATCHDOG_INTERVAL_MS = 30_000; // check for hung jobs every 30 seconds
const HUNG_THRESHOLD_SECONDS = 90; // job is considered hung after 90s without checkpoint
const MAX_RETRIES = 2; // max retry_count before permanent failure
const RETRY_DELAY_MS = 5_000; // wait 5 seconds before re-dispatching retries
const MAX_CONCURRENT = 2; // max jobs executing simultaneously

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the oldest `pending` job that already has a tier (i.e. a retry).
 * Only returns jobs whose `updated_at` is at least RETRY_DELAY_MS ago.
 */
function dequeueRetry(db: DatabaseSync): RouterJob | null {
  // Use a 5-second delay: only pick up pending retries that have been waiting
  const row = db
    .prepare(
      `SELECT id FROM jobs
       WHERE status = 'pending'
         AND tier IS NOT NULL
         AND retry_count > 0
         AND updated_at <= datetime('now', '-5 seconds')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (!row) return null;
  return getJob(db, row.id);
}

// ---------------------------------------------------------------------------
// Router Loop
// ---------------------------------------------------------------------------

/**
 * Start the Router Loop: continuously process jobs and detect hung workers.
 *
 * Returns a `{ stop }` handle to cleanly shut down both intervals.
 *
 * **Job processing loop** (every 1 second):
 *  1. Check for `pending` retry jobs (already have tier) → dispatch directly
 *  2. Check for `in_queue` jobs (new) → evaluate → set pending → dispatch
 *
 * **Watchdog timer** (every 30 seconds):
 *  - Scans for `in_execution` jobs with stale checkpoints
 *  - Retries (retry_count < 2) → reset to `pending`, bump retry_count
 *  - Permanent failures (retry_count >= 2) → mark `failed`
 */
export function startRouterLoop(
  db: DatabaseSync,
  config: RouterConfig,
  executor?: AgentExecutor,
): { stop: () => void } {
  let stopped = false;

  // Track pending setTimeout handles so stop() can clear them
  const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  // -----------------------------------------------------------------------
  // Job processing tick
  // -----------------------------------------------------------------------

  async function processTick(): Promise<void> {
    if (stopped) return;

    try {
      // 0. Concurrency gate — don't dispatch if too many jobs are running
      const executing = db
        .prepare(`SELECT count(*) as c FROM jobs WHERE status = 'in_execution'`)
        .get() as { c: number };
      if (executing.c >= MAX_CONCURRENT) return;

      // 1. Check for retry jobs first (pending with tier set, retry_count > 0)
      const retryJob = dequeueRetry(db);
      if (retryJob) {
        try {
          dispatch(db, retryJob, config, executor);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          updateJob(db, retryJob.id, {
            status: "failed",
            error: errorMessage,
          });
        }
        return; // Process one job per tick
      }

      // 2. Check for new jobs in the queue
      const job = dequeue(db);
      if (!job) return; // Queue empty — nothing to do

      try {
        // Parse payload to get message and context
        const payload: { message?: string; context?: string } =
          typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;

        // Evaluate complexity
        const result = await evaluate(
          config.evaluator,
          payload.message ?? "",
          payload.context,
        );

        // Update job with weight, set status to pending
        updateJob(db, job.id, {
          weight: result.weight,
          status: "pending",
        });

        // Re-read job to get updated state before dispatching
        const updatedJob = getJob(db, job.id);
        if (!updatedJob) return; // Job disappeared (shouldn't happen)

        // Dispatch the job
        dispatch(db, updatedJob, config, executor);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        updateJob(db, job.id, {
          status: "failed",
          error: errorMessage,
        });
      }
    } catch {
      // Top-level safety net — never let the loop crash
    }
  }

  // -----------------------------------------------------------------------
  // Watchdog tick
  // -----------------------------------------------------------------------

  function watchdogTick(): void {
    if (stopped) return;

    try {
      const hungJobs = getHungJobs(db, HUNG_THRESHOLD_SECONDS);

      for (const job of hungJobs) {
        if (job.retry_count < MAX_RETRIES) {
          // Schedule retry after delay
          const timer = setTimeout(() => {
            pendingTimeouts.delete(timer);
            if (stopped) return;
            try {
              updateJob(db, job.id, {
                status: "pending",
                retry_count: job.retry_count + 1,
              });
            } catch {
              // Best-effort — don't crash watchdog on DB error
            }
          }, RETRY_DELAY_MS);
          pendingTimeouts.add(timer);
        } else {
          // Permanent failure — too many retries
          updateJob(db, job.id, {
            status: "failed",
            error: "hung: no checkpoint for 90s",
          });
        }
      }
    } catch {
      // Best-effort — never crash the watchdog
    }
  }

  // -----------------------------------------------------------------------
  // Start intervals
  // -----------------------------------------------------------------------

  const loopTimer = setInterval(() => {
    void processTick();
  }, LOOP_INTERVAL_MS);

  const watchdogTimer = setInterval(() => {
    watchdogTick();
  }, WATCHDOG_INTERVAL_MS);

  // -----------------------------------------------------------------------
  // Stop handle
  // -----------------------------------------------------------------------

  function stop(): void {
    stopped = true;
    clearInterval(loopTimer);
    clearInterval(watchdogTimer);
    for (const t of pendingTimeouts) {
      clearTimeout(t);
    }
    pendingTimeouts.clear();
  }

  return { stop };
}
