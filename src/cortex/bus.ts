/**
 * Cortex Message Bus — SQLite-backed, priority-ordered, crash-durable.
 *
 * Every message entering Cortex goes through this bus.
 * Messages are dequeued in priority order (urgent > normal > background),
 * FIFO within the same priority tier.
 *
 * @see docs/cortex-architecture.md §10 (State persistence)
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";
import {
  PRIORITY_ORDER,
  type BusMessage,
  type BusMessageState,
  type CheckpointData,
  type CortexEnvelope,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = "~/.openclaw/cortex/bus.sqlite";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** Initialize the Cortex bus database (creates file + tables if needed) */
export function initBus(dbPath?: string, opts?: { allowExtensionLoading?: boolean }): DatabaseSync {
  const resolved = resolveUserPath(dbPath ?? DEFAULT_DB_PATH);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolved, {
    allowExtension: opts?.allowExtensionLoading === true,
  } as any);

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_bus (
      id          TEXT PRIMARY KEY,
      envelope    TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'pending',
      priority    INTEGER NOT NULL,
      enqueued_at TEXT NOT NULL,
      processed_at TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      checkpoint_id INTEGER
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bus_state_priority
    ON cortex_bus(state, priority, enqueued_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_checkpoints (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT NOT NULL,
      session_snapshot TEXT NOT NULL,
      channel_states  TEXT NOT NULL,
      pending_ops     TEXT NOT NULL
    )
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Enqueue a message into the bus. Returns the envelope ID. */
export function enqueue(db: DatabaseSync, envelope: CortexEnvelope): string {
  const stmt = db.prepare(`
    INSERT INTO cortex_bus (id, envelope, state, priority, enqueued_at, attempts)
    VALUES (?, ?, 'pending', ?, ?, 0)
  `);
  stmt.run(
    envelope.id,
    JSON.stringify(envelope),
    PRIORITY_ORDER[envelope.priority],
    new Date().toISOString(),
  );
  return envelope.id;
}

// ---------------------------------------------------------------------------
// Dequeue
// ---------------------------------------------------------------------------

/** Dequeue the next pending message (priority-ordered, FIFO within tier). Returns null if empty. */
export function dequeueNext(db: DatabaseSync): BusMessage | null {
  const stmt = db.prepare(`
    SELECT id, envelope, state, priority, enqueued_at, processed_at, attempts, error
    FROM cortex_bus
    WHERE state = 'pending'
    ORDER BY priority ASC, enqueued_at ASC
    LIMIT 1
  `);
  const row = stmt.get() as Record<string, unknown> | undefined;
  if (!row) return null;

  return rowToBusMessage(row);
}

/** Peek at all pending messages without consuming them. */
export function peekPending(db: DatabaseSync): BusMessage[] {
  const stmt = db.prepare(`
    SELECT id, envelope, state, priority, enqueued_at, processed_at, attempts, error
    FROM cortex_bus
    WHERE state = 'pending'
    ORDER BY priority ASC, enqueued_at ASC
  `);
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToBusMessage);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Mark a message as processing */
export function markProcessing(db: DatabaseSync, id: string): void {
  const stmt = db.prepare(`
    UPDATE cortex_bus
    SET state = 'processing', attempts = attempts + 1
    WHERE id = ? AND state = 'pending'
  `);
  stmt.run(id);
}

/** Mark a message as completed */
export function markCompleted(db: DatabaseSync, id: string): void {
  const stmt = db.prepare(`
    UPDATE cortex_bus
    SET state = 'completed', processed_at = ?
    WHERE id = ? AND state = 'processing'
  `);
  stmt.run(new Date().toISOString(), id);
}

/** Mark a message as failed with an error */
export function markFailed(db: DatabaseSync, id: string, error: string): void {
  const stmt = db.prepare(`
    UPDATE cortex_bus
    SET state = 'failed', processed_at = ?, error = ?
    WHERE id = ? AND state = 'processing'
  `);
  stmt.run(new Date().toISOString(), error, id);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Count pending messages */
export function countPending(db: DatabaseSync): number {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_bus WHERE state = 'pending'`);
  const row = stmt.get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/** Save a checkpoint. Returns the checkpoint ID. */
export function checkpoint(db: DatabaseSync, data: CheckpointData): number {
  const stmt = db.prepare(`
    INSERT INTO cortex_checkpoints (created_at, session_snapshot, channel_states, pending_ops)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(
    data.createdAt,
    data.sessionSnapshot,
    JSON.stringify(data.channelStates),
    JSON.stringify(data.pendingOps),
  );

  const idRow = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number };
  return idRow.id;
}

/** Load the most recent checkpoint, or null if none exist. */
export function loadLatestCheckpoint(db: DatabaseSync): CheckpointData | null {
  const stmt = db.prepare(`
    SELECT id, created_at, session_snapshot, channel_states, pending_ops
    FROM cortex_checkpoints
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = stmt.get() as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as number,
    createdAt: row.created_at as string,
    sessionSnapshot: row.session_snapshot as string,
    channelStates: JSON.parse(row.channel_states as string),
    pendingOps: JSON.parse(row.pending_ops as string),
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Purge completed messages older than the given ISO timestamp. Returns count removed. */
export function purgeCompleted(db: DatabaseSync, olderThan: string): number {
  const stmt = db.prepare(`
    DELETE FROM cortex_bus
    WHERE state = 'completed' AND processed_at < ?
  `);
  stmt.run(olderThan);

  // Get changes count
  const changes = db.prepare(`SELECT changes() as cnt`).get() as { cnt: number };
  return changes.cnt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToBusMessage(row: Record<string, unknown>): BusMessage {
  return {
    envelope: JSON.parse(row.envelope as string) as CortexEnvelope,
    state: row.state as BusMessageState,
    enqueuedAt: row.enqueued_at as string,
    processedAt: (row.processed_at as string) ?? undefined,
    attempts: row.attempts as number,
    error: (row.error as string) ?? undefined,
  };
}
