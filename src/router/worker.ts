import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { updateJob } from "./queue.js";

// ---------------------------------------------------------------------------
// Shared lifecycle event emitter — other modules (Notifier) listen on this.
// ---------------------------------------------------------------------------

export const routerEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Agent executor type
// ---------------------------------------------------------------------------

/**
 * Function signature for agent execution.
 * Receives the rendered prompt and the target model identifier.
 * Returns the agent's text response.
 *
 * The executor runs in a fully isolated session under the `router-executor`
 * agent — no parent context, no tools, no memory. The prompt (from the
 * Router's tier template) is the executor's only instruction set.
 */
export type AgentExecutor = (prompt: string, model: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Default (placeholder) executor
// ---------------------------------------------------------------------------

/**
 * Placeholder executor — will be replaced with real callGateway integration
 * in the integration task (Task 11).
 */
export const defaultExecuteAgent: AgentExecutor = async (
  prompt: string,
  model: string,
): Promise<string> => {
  throw new Error(
    `executeAgent not wired: prompt length=${prompt.length}, model=${model}`,
  );
};

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

export interface WorkerHandle {
  jobId: string;
  /** Stops the heartbeat timer. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Heartbeat interval (ms)
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// ISO-like timestamp helper (matches SQLite datetime() format)
// ---------------------------------------------------------------------------

function nowTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Worker — run a single job to completion
// ---------------------------------------------------------------------------

/**
 * Execute a router job: start heartbeat, call the agent, record result/error.
 *
 * The heartbeat timer is **always** cleaned up — on success, failure, or
 * unexpected exception.
 *
 * Lifecycle events emitted on `routerEvents`:
 *  - `'job:completed'` with `{ jobId }` on success
 *  - `'job:failed'`    with `{ jobId, error }` on failure
 *
 * @param db        - Router SQLite database handle
 * @param jobId     - The job row ID to execute
 * @param prompt    - Rendered prompt (from Dispatcher)
 * @param model     - Target model identifier (e.g. "anthropic/claude-haiku-4-5")
 * @param executor  - Agent execution function (defaults to placeholder)
 */
export async function run(
  db: DatabaseSync,
  jobId: string,
  prompt: string,
  model: string,
  executor: AgentExecutor = defaultExecuteAgent,
): Promise<void> {
  const now = nowTimestamp();

  // 1. Mark job as started
  updateJob(db, jobId, {
    started_at: now,
    last_checkpoint: now,
  });

  // 2. Start heartbeat timer
  const heartbeatTimer = setInterval(() => {
    try {
      updateJob(db, jobId, { last_checkpoint: nowTimestamp() });
    } catch {
      // Best-effort — don't crash the worker if a checkpoint write fails.
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // 3. Execute the agent (isolated session — no parent context)
    const result = await executor(prompt, model);

    // 4. Success — stop heartbeat first
    clearInterval(heartbeatTimer);
    updateJob(db, jobId, {
      status: "completed",
      result,
      finished_at: nowTimestamp(),
    });
    routerEvents.emit("job:completed", { jobId });
  } catch (err) {
    // 5. Failure — stop heartbeat first
    clearInterval(heartbeatTimer);
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    updateJob(db, jobId, {
      status: "failed",
      error: errorMessage,
      finished_at: nowTimestamp(),
    });
    routerEvents.emit("job:failed", { jobId, error: errorMessage });
  }
}
