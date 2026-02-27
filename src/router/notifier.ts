import type { DatabaseSync } from "node:sqlite";
import { getJob, updateJob, archiveJob } from "./queue.js";
import { routerEvents } from "./worker.js";
import type { RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Callback type — fires after each delivery for session push, cleanup, etc.
// ---------------------------------------------------------------------------

export type OnDeliveredCallback = (jobId: string, job: RouterJob) => void;

// ---------------------------------------------------------------------------
// Terminal statuses — deliverResult only acts on these
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

// ---------------------------------------------------------------------------
// Default timeout for waitForJob (5 minutes)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// deliverResult — stamp delivered_at, emit job:delivered, archive
// ---------------------------------------------------------------------------

/**
 * Deliver the result of a terminal job to its issuer.
 *
 * - Stamps `delivered_at` on the job
 * - Emits `'job:delivered'` on `routerEvents` with `{ jobId, job }`
 * - Archives the job (moves from `jobs` to `jobs_archive`)
 *
 * No-ops silently if the job doesn't exist or isn't in a terminal status.
 */
export function deliverResult(db: DatabaseSync, jobId: string): void {
  const job = getJob(db, jobId);
  if (!job || !TERMINAL_STATUSES.has(job.status)) return;

  updateJob(db, jobId, {
    delivered_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  });

  // Re-read the job to get the updated delivered_at
  const updatedJob = getJob(db, jobId);

  routerEvents.emit("job:delivered", { jobId, job: updatedJob ?? job });

  archiveJob(db, jobId);
}

// ---------------------------------------------------------------------------
// startNotifier — wire up routerEvents listeners
// ---------------------------------------------------------------------------

/**
 * Start the Notifier: register listeners on `routerEvents` for job lifecycle
 * events (`job:completed`, `job:failed`).
 *
 * The optional `onDelivered` callback fires after each delivery — use it to
 * push the result to the issuer's session (§3.7 step 3).
 *
 * Returns a cleanup function that removes the listeners.
 */
export function startNotifier(
  db: DatabaseSync,
  onDelivered?: OnDeliveredCallback,
): () => void {
  const onCompleted = ({ jobId }: { jobId: string }) => {
    const job = getJob(db, jobId);
    deliverResult(db, jobId);
    if (onDelivered && job) {
      try { onDelivered(jobId, job); } catch { /* best-effort */ }
    }
  };

  const onFailed = ({ jobId }: { jobId: string }) => {
    const job = getJob(db, jobId);
    deliverResult(db, jobId);
    if (onDelivered && job) {
      try { onDelivered(jobId, job); } catch { /* best-effort */ }
    }
  };

  routerEvents.on("job:completed", onCompleted);
  routerEvents.on("job:failed", onFailed);

  return () => {
    routerEvents.removeListener("job:completed", onCompleted);
    routerEvents.removeListener("job:failed", onFailed);
  };
}

// ---------------------------------------------------------------------------
// waitForJob — Promise-based waiter for enqueueAndWait callers
// ---------------------------------------------------------------------------

/**
 * Wait for a specific job to be delivered.
 *
 * Listens on `routerEvents` for `'job:delivered'` where the `jobId` matches.
 * Resolves with the delivered `RouterJob`.
 *
 * Rejects with a timeout error if `timeoutMs` elapses (default: 5 minutes).
 * Cleans up the listener on resolve or reject.
 */
export function waitForJob(
  db: DatabaseSync,
  jobId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RouterJob> {
  return new Promise<RouterJob>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onDelivered = (data: { jobId: string; job: RouterJob }) => {
      if (data.jobId !== jobId) return;

      // Match found — clean up and resolve
      routerEvents.removeListener("job:delivered", onDelivered);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(data.job);
    };

    routerEvents.on("job:delivered", onDelivered);

    timer = setTimeout(() => {
      routerEvents.removeListener("job:delivered", onDelivered);
      timer = undefined;
      reject(new Error(`waitForJob timed out after ${timeoutMs}ms for job ${jobId}`));
    }, timeoutMs);
  });
}
