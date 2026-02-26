/**
 * Cortex State Persistence & Recovery
 *
 * Recovers Cortex state after a crash: resets stalled messages,
 * loads latest checkpoint, identifies unprocessed messages.
 *
 * @see docs/cortex-architecture.md §10 (State persistence)
 */

import type { DatabaseSync } from "node:sqlite";
import { loadLatestCheckpoint, peekPending } from "./bus.js";
import { getChannelStates, getPendingOps } from "./session.js";
import type { BusMessage, ChannelState, CheckpointData, PendingOperation } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  checkpoint: CheckpointData | null;
  unprocessedMessages: BusMessage[];
  stalledMessages: BusMessage[];
  channelStates: ChannelState[];
  pendingOps: PendingOperation[];
}

export interface RepairReport {
  stalledReset: number;
  orphansRemoved: number;
  checksumValid: boolean;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** Recover Cortex state from SQLite after crash */
export function recoverState(db: DatabaseSync): RecoveryResult {
  // Load latest checkpoint
  const cp = loadLatestCheckpoint(db);

  // Find stalled messages (were "processing" when crash happened)
  const stalledRows = db.prepare(`
    SELECT id, envelope, state, priority, enqueued_at, processed_at, attempts, error
    FROM cortex_bus
    WHERE state = 'processing'
  `).all() as Record<string, unknown>[];

  const stalledMessages: BusMessage[] = stalledRows.map(rowToBusMessage);

  // Find pending messages
  const unprocessedMessages = peekPending(db);

  // Get current state
  const channelStates = getChannelStates(db);
  const pendingOps = getPendingOps(db);

  return {
    checkpoint: cp,
    unprocessedMessages,
    stalledMessages,
    channelStates,
    pendingOps,
  };
}

/** Reset stalled messages (processing → pending) so they get reprocessed */
export function resetStalledMessages(db: DatabaseSync): number {
  const stmt = db.prepare(`
    UPDATE cortex_bus
    SET state = 'pending'
    WHERE state = 'processing'
  `);
  stmt.run();

  const changes = db.prepare(`SELECT changes() as cnt`).get() as { cnt: number };
  return changes.cnt;
}

/** Validate and repair bus state after crash */
export function repairBusState(db: DatabaseSync): RepairReport {
  // Reset stalled messages
  const stalledReset = resetStalledMessages(db);

  // Check for orphans (entries with invalid state)
  const orphanStmt = db.prepare(`
    DELETE FROM cortex_bus
    WHERE state NOT IN ('pending', 'processing', 'completed', 'failed')
  `);
  orphanStmt.run();
  const orphansRemoved = (db.prepare(`SELECT changes() as cnt`).get() as { cnt: number }).cnt;

  // SQLite integrity check
  let checksumValid = true;
  try {
    const result = db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
    checksumValid = result.integrity_check === "ok";
  } catch {
    checksumValid = false;
  }

  return { stalledReset, orphansRemoved, checksumValid };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToBusMessage(row: Record<string, unknown>): BusMessage {
  return {
    envelope: JSON.parse(row.envelope as string),
    state: row.state as BusMessage["state"],
    enqueuedAt: row.enqueued_at as string,
    processedAt: (row.processed_at as string) ?? undefined,
    attempts: row.attempts as number,
    error: (row.error as string) ?? undefined,
  };
}
