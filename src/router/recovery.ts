import type { DatabaseSync } from "node:sqlite";
import { getStuckJobs, updateJob } from "./queue.js";
import { deliverResult } from "./notifier.js";
import type { RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Crash recovery — called on gateway startup before the Router Loop begins
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;

/**
 * Recover jobs left in intermediate states due to a gateway crash.
 *
 * 1. `evaluating` jobs → reset to `in_queue` (re-evaluate from scratch)
 * 2. `in_execution` jobs:
 *    - retry_count < 2 → reset to `pending`, increment retry_count
 *    - retry_count >= 2 → mark `failed`
 * 3. Undelivered terminal jobs (`completed`/`failed` with NULL delivered_at)
 *    → re-emit via `deliverResult()`
 *
 * @returns `{ recovered, failed }` — counts of jobs reset vs permanently failed
 */
export function recover(db: DatabaseSync): { recovered: number; failed: number } {
  let recovered = 0;
  let failed = 0;

  // -----------------------------------------------------------------------
  // Step 1 & 2: Handle stuck jobs (evaluating / in_execution)
  // -----------------------------------------------------------------------

  const stuckJobs = getStuckJobs(db);

  for (const job of stuckJobs) {
    if (job.status === "evaluating") {
      updateJob(db, job.id, { status: "in_queue" });
      recovered++;
      console.log(
        `[router:recovery] job ${job.id}: evaluating → in_queue (will re-evaluate)`,
      );
    } else if (job.status === "in_execution") {
      if (job.retry_count < MAX_RETRIES) {
        updateJob(db, job.id, {
          status: "pending",
          retry_count: job.retry_count + 1,
        });
        recovered++;
        console.log(
          `[router:recovery] job ${job.id}: in_execution → pending (retry ${job.retry_count + 1}/${MAX_RETRIES})`,
        );
      } else {
        updateJob(db, job.id, {
          status: "failed",
          error: "gateway crash: max retries exceeded",
          finished_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        });
        failed++;
        console.log(
          `[router:recovery] job ${job.id}: in_execution → failed (max retries exceeded)`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Re-deliver undelivered terminal jobs
  // -----------------------------------------------------------------------

  const undelivered = db
    .prepare(
      `SELECT * FROM jobs
       WHERE status IN ('completed', 'failed')
         AND delivered_at IS NULL`,
    )
    .all() as unknown as RouterJob[];

  for (const job of undelivered) {
    console.log(
      `[router:recovery] job ${job.id}: re-delivering undelivered ${job.status} result`,
    );
    deliverResult(db, job.id);
  }

  if (stuckJobs.length > 0 || undelivered.length > 0) {
    console.log(
      `[router:recovery] complete: ${recovered} recovered, ${failed} failed, ${undelivered.length} re-delivered`,
    );
  }

  return { recovered, failed };
}
