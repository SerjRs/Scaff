import type { DatabaseSync } from "node:sqlite";
import { initRouterDb, enqueue as dbEnqueue, getJob } from "./queue.js";
import { recover } from "./recovery.js";
import { startNotifier, waitForJob, type OnDeliveredCallback } from "./notifier.js";
import { startRouterLoop } from "./loop.js";
import { routerEvents, type AgentExecutor } from "./worker.js";
import type { JobType, RouterConfig, RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

export { routerEvents } from "./worker.js";
export type { AgentExecutor } from "./worker.js";
export type { RouterConfig, JobType, RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// RouterInstance — public handle returned by startRouter()
// ---------------------------------------------------------------------------

export interface RouterInstance {
  /** Enqueue a job and return its ID immediately (fire-and-forget). */
  enqueue: (
    type: JobType,
    payload: { message: string; context?: string },
    issuer: string,
    taskId: string,
  ) => string;

  /** Enqueue a job and wait for the result (sync-style). */
  enqueueAndWait: (
    type: JobType,
    payload: { message: string; context?: string },
    issuer: string,
    taskId: string,
    timeoutMs?: number,
  ) => Promise<RouterJob>;

  /** Gracefully stop the router: stop loop, notifier, close DB. */
  stop: () => void;

  /** Get the Router configuration. */
  getConfig: () => RouterConfig;

  /** Snapshot of queue health. */
  getStatus: () => {
    queueDepth: number;
    inFlight: number;
    totalProcessed: number;
  };
}

// ---------------------------------------------------------------------------
// startRouter — wire everything together
// ---------------------------------------------------------------------------

/**
 * Initialize and start the Router service.
 *
 * 1. Opens (or creates) the SQLite queue database
 * 2. Runs crash recovery on any stuck jobs from a prior run
 * 3. Starts the Notifier (event-driven result delivery)
 * 4. Starts the Router Loop + Watchdog (job processing)
 * 5. Returns a {@link RouterInstance} handle
 *
 * The function is **synchronous** — `initRouterDb` and `recover` are sync.
 */
export function startRouter(
  config: RouterConfig,
  executor?: AgentExecutor,
  onDelivered?: OnDeliveredCallback,
): RouterInstance {
  // 1. Initialize the SQLite database
  const db: DatabaseSync = initRouterDb();

  // 2. Crash recovery — reset stuck jobs
  const { recovered, failed } = recover(db);
  console.log(
    `[router] Recovery complete: ${recovered} recovered, ${failed} failed`,
  );

  // 3. Start the Notifier (listens on routerEvents for delivery)
  const stopNotifier = startNotifier(db, onDelivered);

  // 4. Start the Router Loop + Watchdog
  const loop = startRouterLoop(db, config, executor);

  console.log("[router] Router started");

  // Track whether we've already stopped (idempotent stop)
  let stopped = false;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  function enqueue(
    type: JobType,
    payload: { message: string; context?: string },
    issuer: string,
    taskId: string,
  ): string {
    return dbEnqueue(db, type, JSON.stringify(payload), issuer, taskId);
  }

  async function enqueueAndWait(
    type: JobType,
    payload: { message: string; context?: string },
    issuer: string,
    taskId: string,
    timeoutMs?: number,
  ): Promise<RouterJob> {
    const jobId = enqueue(type, payload, issuer, taskId);
    return waitForJob(db, jobId, timeoutMs);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;

    // Stop processing first, then notifier, then DB
    loop.stop();
    stopNotifier();

    try {
      db.close();
    } catch {
      // Best-effort — DB may already be closed
    }

    console.log("[router] Router stopped");
  }

  function getStatus(): {
    queueDepth: number;
    inFlight: number;
    totalProcessed: number;
  } {
    const depthRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs
         WHERE status IN ('in_queue', 'evaluating', 'pending')`,
      )
      .get() as { count: number };

    const inFlightRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs WHERE status = 'in_execution'`,
      )
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

  function getConfig(): RouterConfig {
    return config;
  }

  return { enqueue, enqueueAndWait, stop, getConfig, getStatus };
}
