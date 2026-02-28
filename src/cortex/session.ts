/**
 * Cortex Session Unification
 *
 * All channels resolve to ONE Cortex session. Messages from all channels
 * are stored in a single unified history, tagged with channel metadata.
 *
 * @see docs/cortex-architecture.md §3.1, §7
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ChannelId,
  ChannelState,
  AttentionLayer,
  CortexEnvelope,
  CortexOutput,
  PendingOperation,
  PendingOpStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema (called during initBus, but defined here for clarity)
// ---------------------------------------------------------------------------

/** Initialize session tables in the bus database */
export function initSessionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_session (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_id TEXT NOT NULL,
      role        TEXT NOT NULL,
      channel     TEXT NOT NULL,
      sender_id   TEXT NOT NULL,
      content     TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      metadata    TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_channel
    ON cortex_session(channel, timestamp)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_timestamp
    ON cortex_session(timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_channel_states (
      channel         TEXT PRIMARY KEY,
      last_message_at TEXT NOT NULL,
      unread_count    INTEGER NOT NULL DEFAULT 0,
      summary         TEXT,
      layer           TEXT NOT NULL DEFAULT 'archived'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_pending_ops (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL,
      description      TEXT NOT NULL,
      dispatched_at    TEXT NOT NULL,
      expected_channel TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      completed_at     TEXT,
      result           TEXT,
      gardened_at      TEXT
    )
  `);

  // Migration MUST run before index creation — existing tables may lack the status column
  _migratePendingOps(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_ops_status
    ON cortex_pending_ops(status)
  `);
}

// ---------------------------------------------------------------------------
// Session Key
// ---------------------------------------------------------------------------

/** Get the unified Cortex session key. Always the same for a given agent. */
export function getCortexSessionKey(agentId: string): string {
  return `agent:${agentId}:cortex`;
}

// ---------------------------------------------------------------------------
// Session History
// ---------------------------------------------------------------------------

/** A message in the unified session history */
export interface SessionMessage {
  id: number;
  envelopeId: string;
  role: "user" | "assistant";
  channel: ChannelId;
  senderId: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Append an inbound message to the unified session */
export function appendToSession(db: DatabaseSync, envelope: CortexEnvelope): void {
  const stmt = db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata)
    VALUES (?, 'user', ?, ?, ?, ?, ?)
  `);
  stmt.run(
    envelope.id,
    envelope.channel,
    envelope.sender.id,
    envelope.content,
    envelope.timestamp,
    envelope.metadata ? JSON.stringify(envelope.metadata) : null,
  );
}

/** Append Cortex's response to the unified session */
export function appendResponse(
  db: DatabaseSync,
  output: CortexOutput,
  inResponseTo: string,
): void {
  // Store the response for each output target
  for (const target of output.targets) {
    const stmt = db.prepare(`
      INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata)
      VALUES (?, 'assistant', ?, 'cortex', ?, ?, ?)
    `);
    stmt.run(
      inResponseTo,
      target.channel,
      target.content,
      new Date().toISOString(),
      null,
    );
  }

  // If silence (no targets), still record it
  if (output.targets.length === 0) {
    const stmt = db.prepare(`
      INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata)
      VALUES (?, 'assistant', 'internal', 'cortex', '[silence]', ?, NULL)
    `);
    stmt.run(inResponseTo, new Date().toISOString());
  }
}

/** Get session history, optionally filtered by channel */
export function getSessionHistory(
  db: DatabaseSync,
  opts?: { channel?: ChannelId; limit?: number },
): SessionMessage[] {
  let sql = `
    SELECT id, envelope_id, role, channel, sender_id, content, timestamp, metadata
    FROM cortex_session
  `;
  const params: import("node:sqlite").SQLInputValue[] = [];

  if (opts?.channel) {
    sql += ` WHERE channel = ?`;
    params.push(opts.channel);
  }

  sql += ` ORDER BY timestamp ASC, id ASC`;

  if (opts?.limit) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as number,
    envelopeId: row.envelope_id as string,
    role: row.role as "user" | "assistant",
    channel: row.channel as ChannelId,
    senderId: row.sender_id as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Channel States
// ---------------------------------------------------------------------------

/** Create or update a channel's state */
export function updateChannelState(
  db: DatabaseSync,
  channelId: ChannelId,
  state: Partial<ChannelState>,
): void {
  // Upsert
  const existing = db.prepare(`SELECT * FROM cortex_channel_states WHERE channel = ?`).get(channelId) as Record<string, unknown> | undefined;

  if (existing) {
    const updates: string[] = [];
    const values: import("node:sqlite").SQLInputValue[] = [];

    if (state.lastMessageAt !== undefined) {
      updates.push("last_message_at = ?");
      values.push(state.lastMessageAt);
    }
    if (state.unreadCount !== undefined) {
      updates.push("unread_count = ?");
      values.push(state.unreadCount);
    }
    if (state.summary !== undefined) {
      updates.push("summary = ?");
      values.push(state.summary);
    }
    if (state.layer !== undefined) {
      updates.push("layer = ?");
      values.push(state.layer);
    }

    if (updates.length > 0) {
      values.push(channelId);
      db.prepare(`UPDATE cortex_channel_states SET ${updates.join(", ")} WHERE channel = ?`).run(...values);
    }
  } else {
    db.prepare(`
      INSERT INTO cortex_channel_states (channel, last_message_at, unread_count, summary, layer)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      channelId,
      state.lastMessageAt ?? new Date().toISOString(),
      state.unreadCount ?? 0,
      state.summary ?? null,
      state.layer ?? "archived",
    );
  }
}

/** Get all tracked channel states */
export function getChannelStates(db: DatabaseSync): ChannelState[] {
  const rows = db.prepare(`SELECT * FROM cortex_channel_states ORDER BY last_message_at DESC`).all() as Record<string, unknown>[];

  return rows.map((row) => ({
    channel: row.channel as ChannelId,
    lastMessageAt: row.last_message_at as string,
    unreadCount: row.unread_count as number,
    summary: (row.summary as string) ?? undefined,
    layer: row.layer as AttentionLayer,
  }));
}

// ---------------------------------------------------------------------------
// Pending Operations
// ---------------------------------------------------------------------------

/** Add a pending operation */
export function addPendingOp(db: DatabaseSync, op: PendingOperation): void {
  db.prepare(`
    INSERT OR REPLACE INTO cortex_pending_ops (id, type, description, dispatched_at, expected_channel, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(op.id, op.type, op.description, op.dispatchedAt, op.expectedChannel, op.status ?? "pending");
}

/**
 * Remove a pending operation (legacy — prefer completePendingOp).
 * @deprecated Use completePendingOp for the lifecycle-based approach.
 */
export function removePendingOp(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM cortex_pending_ops WHERE id = ?`).run(id);
}

/** Mark a pending op as completed and attach the result */
export function completePendingOp(db: DatabaseSync, id: string, result: string): void {
  db.prepare(`
    UPDATE cortex_pending_ops
    SET status = 'completed', completed_at = ?, result = ?
    WHERE id = ?
  `).run(new Date().toISOString(), result, id);
}

/** Mark a pending op as failed. Stays visible in the System Floor until acknowledged. */
export function failPendingOp(db: DatabaseSync, id: string, error: string): void {
  db.prepare(`
    UPDATE cortex_pending_ops
    SET status = 'failed', completed_at = ?, result = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), `Error: ${error}`, id);
}

/** Get all completed ops (for Op Harvester) */
export function getCompletedOps(db: DatabaseSync): PendingOperation[] {
  const rows = db.prepare(
    `SELECT * FROM cortex_pending_ops WHERE status = 'completed' ORDER BY completed_at ASC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToPendingOp);
}

/** Mark ops as gardened (facts extracted) */
export function markOpsGardened(db: DatabaseSync, ids: string[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE cortex_pending_ops
    SET status = 'gardened', gardened_at = ?
    WHERE id = ?
  `);
  for (const id of ids) {
    stmt.run(now, id);
  }
}

/** Archive old gardened ops (zero token cost after this) */
export function archiveOldGardenedOps(db: DatabaseSync, olderThanDays = 7): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const result = db.prepare(`
    UPDATE cortex_pending_ops
    SET status = 'archived'
    WHERE status = 'gardened' AND gardened_at < ?
  `).run(cutoff.toISOString());
  return Number(result.changes);
}

/**
 * Get active pending operations for System Floor injection.
 *
 * Returns:
 * - All `pending` ops (still waiting for a result)
 * - `completed` ops that have NOT been acknowledged (fresh results — inbox "unread")
 * - `failed` ops that have NOT been acknowledged (the LLM must see failures to inform the user)
 *
 * Acknowledged completed/failed ops drop from the System Floor. This is the structural
 * mechanism that lets any issuer distinguish new results from old ones (§6.4).
 */
export function getPendingOps(db: DatabaseSync): PendingOperation[] {
  const rows = db.prepare(
    `SELECT * FROM cortex_pending_ops
     WHERE (status = 'pending')
        OR (status = 'completed' AND acknowledged_at IS NULL)
        OR (status = 'failed' AND acknowledged_at IS NULL)
     ORDER BY dispatched_at ASC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToPendingOp);
}

/**
 * Mark all fresh completed/failed ops as acknowledged.
 *
 * Called by the issuer after processing a turn — signals that the results
 * have been "read" and should no longer appear in the System Floor.
 * This is the universal read/unread inbox pattern (§6.4).
 *
 * @returns Number of ops acknowledged
 */
export function acknowledgeCompletedOps(db: DatabaseSync): number {
  const result = db.prepare(`
    UPDATE cortex_pending_ops
    SET acknowledged_at = ?
    WHERE (status = 'completed' OR status = 'failed') AND acknowledged_at IS NULL
  `).run(new Date().toISOString());
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPendingOp(row: Record<string, unknown>): PendingOperation {
  return {
    id: row.id as string,
    type: row.type as PendingOperation["type"],
    description: row.description as string,
    dispatchedAt: row.dispatched_at as string,
    expectedChannel: row.expected_channel as ChannelId,
    status: (row.status as PendingOpStatus) ?? "pending",
    completedAt: (row.completed_at as string) ?? undefined,
    result: (row.result as string) ?? undefined,
    gardenedAt: (row.gardened_at as string) ?? undefined,
    acknowledgedAt: (row.acknowledged_at as string) ?? undefined,
  };
}

/** Migration: add lifecycle columns to existing cortex_pending_ops tables */
function _migratePendingOps(db: DatabaseSync): void {
  try {
    // Check if status column exists by querying table info
    const columns = db.prepare(`PRAGMA table_info(cortex_pending_ops)`).all() as { name: string }[];
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("status")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
    }
    if (!colNames.has("completed_at")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN completed_at TEXT`);
    }
    if (!colNames.has("result")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN result TEXT`);
    }
    if (!colNames.has("gardened_at")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN gardened_at TEXT`);
    }
    if (!colNames.has("acknowledged_at")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN acknowledged_at TEXT`);
    }
  } catch {
    // Table doesn't exist yet or migration already done — no-op
  }
}
