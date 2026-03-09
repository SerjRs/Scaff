/**
 * Gateway method handlers for the token monitor.
 * - usage.tokens     → returns current ledger snapshot
 * - usage.tokens.reset → clears the ledger
 *
 * On each snapshot request, syncs task status from the router queue DB
 * so the CLI display shows real-time Finished/Failed/Canceled states.
 */

import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import {
  snapshot,
  reset,
  updateStatusBySession,
  updateTaskBySession,
  type TokenLedgerRow,
  type TokenRowStatus,
} from "./ledger.js";

export type TokensSnapshotResult = {
  rows: TokenLedgerRow[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    cached: number;
    calls: number;
  };
};

/** Map router job status → token monitor display status. */
function mapJobStatus(dbStatus: string): TokenRowStatus | null {
  switch (dbStatus) {
    case "in_execution":
    case "evaluating":
      return "InProgress";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return null;
  }
}

/**
 * Extract a short task summary (max 40 chars) from a job's payload JSON.
 * Payload shape: { message?: string; context?: string; resources?: ... }
 * For evaluating jobs, returns "Evaluating task".
 */
function extractTaskSummary(status: string, payloadJson: string): string {
  if (status === "evaluating") return "Evaluating task";
  try {
    const payload = JSON.parse(payloadJson) as { message?: string };
    const msg = payload.message?.trim() ?? "";
    if (!msg) return "";
    return msg.length > 40 ? msg.slice(0, 37) + "..." : msg;
  } catch {
    return "";
  }
}

/**
 * Best-effort sync of router queue statuses and task descriptions into the
 * token ledger. Scans recently finished jobs for status updates, and active
 * jobs for task text.
 */
function syncRouterStatuses(): void {
  try {
    // Dynamic import to avoid hard dependency — router DB may not exist.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initRouterDb } = require("../router/queue.js") as typeof import("../router/queue.js");
    const db = initRouterDb();

    // Find recently finished/failed/canceled jobs (last 2 minutes) — status sync
    const terminalRows = db
      .prepare(
        `SELECT id, status, worker_id FROM jobs
         WHERE status IN ('completed', 'failed', 'canceled')
           AND finished_at > datetime('now', '-120 seconds')`,
      )
      .all() as Array<{ id: string; status: string; worker_id: string | null }>;

    for (const row of terminalRows) {
      const mapped = mapJobStatus(row.status);
      if (!mapped) continue;

      // Try to match by job ID embedded in session key patterns
      // Router executor sessions use key: agent:router-executor:task:<uuid>
      // The jobId might be stored as worker_id or we match by the job ID prefix
      if (row.worker_id) {
        updateStatusBySession(row.worker_id, mapped);
      }
      // Also try matching by the job ID itself (if used as sessionId)
      updateStatusBySession(row.id, mapped);
    }

    // Sync task text for active (in_execution / evaluating) jobs
    const activeRows = db
      .prepare(
        `SELECT id, status, payload, worker_id FROM jobs
         WHERE status IN ('in_execution', 'evaluating')`,
      )
      .all() as Array<{ id: string; status: string; payload: string; worker_id: string | null }>;

    for (const row of activeRows) {
      const taskText = extractTaskSummary(row.status, row.payload);
      if (!taskText) continue;

      if (row.worker_id) {
        updateTaskBySession(row.worker_id, taskText);
      }
      updateTaskBySession(row.id, taskText);
    }
  } catch {
    // Best-effort — router DB may not exist or may be locked
  }
}

function buildSnapshotResult(): TokensSnapshotResult {
  // Sync task statuses from router queue DB before taking snapshot
  syncRouterStatuses();

  const rows = snapshot();
  const totals = { tokensIn: 0, tokensOut: 0, cached: 0, calls: 0 };
  for (const row of rows) {
    totals.tokensIn += row.tokensIn;
    totals.tokensOut += row.tokensOut;
    totals.cached += row.cached;
    totals.calls += row.calls;
  }
  return { rows, totals };
}

export const tokenMonitorHandlers: GatewayRequestHandlers = {
  "usage.tokens": async ({ respond }) => {
    respond(true, buildSnapshotResult(), undefined);
  },
  "usage.tokens.reset": async ({ respond }) => {
    reset();
    respond(true, { ok: true }, undefined);
  },
};
