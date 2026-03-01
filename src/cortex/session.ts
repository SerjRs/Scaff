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
  // --- Create tables (IF NOT EXISTS = no-op on existing DB) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_session (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_id TEXT NOT NULL,
      role        TEXT NOT NULL,
      channel     TEXT NOT NULL,
      sender_id   TEXT NOT NULL,
      content     TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      metadata    TEXT,
      issuer      TEXT NOT NULL DEFAULT 'agent:main:cortex'
    )
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
      reply_channel    TEXT,
      result_priority  TEXT,
      issuer           TEXT NOT NULL DEFAULT 'agent:main:cortex'
    )
  `);

  // --- Migration MUST run BEFORE index creation ---
  // Existing tables may lack columns (issuer, status, etc.).
  // ALTER TABLE adds them so subsequent CREATE INDEX succeeds.
  _migrateSchema(db);

  // --- Indexes (safe now — all columns exist) ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_channel
    ON cortex_session(channel, timestamp)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_timestamp
    ON cortex_session(timestamp)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_issuer
    ON cortex_session(issuer, timestamp)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_ops_status
    ON cortex_pending_ops(status)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_ops_issuer
    ON cortex_pending_ops(issuer, status)
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
  /** Cognitive owner — which agent session owns this message */
  issuer?: string;
}

/** Append an inbound message to the unified session */
export function appendToSession(db: DatabaseSync, envelope: CortexEnvelope, issuer = "agent:main:cortex"): void {
  const stmt = db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
    VALUES (?, 'user', ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    envelope.id,
    envelope.channel,
    envelope.sender.id,
    envelope.content,
    envelope.timestamp,
    envelope.metadata ? JSON.stringify(envelope.metadata) : null,
    issuer,
  );
}

/** Record a tool call in the session so the LLM can see its own actions in future turns */
export function appendToolCall(
  db: DatabaseSync,
  envelopeId: string,
  toolName: string,
  detail: string,
  issuer = "agent:main:cortex",
): void {
  const content = `[Tool] ${toolName}: ${detail}`;
  db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
    VALUES (?, 'assistant', 'internal', 'cortex', ?, ?, NULL, ?)
  `).run(envelopeId, content, new Date().toISOString(), issuer);
}

/** Append Cortex's response to the unified session */
export function appendResponse(
  db: DatabaseSync,
  output: CortexOutput,
  inResponseTo: string,
  issuer = "agent:main:cortex",
): void {
  // Store the response for each output target
  for (const target of output.targets) {
    const stmt = db.prepare(`
      INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
      VALUES (?, 'assistant', ?, 'cortex', ?, ?, ?, ?)
    `);
    stmt.run(
      inResponseTo,
      target.channel,
      target.content,
      new Date().toISOString(),
      null,
      issuer,
    );
  }

  // If silence (no targets), still record it
  if (output.targets.length === 0) {
    const stmt = db.prepare(`
      INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
      VALUES (?, 'assistant', 'internal', 'cortex', '[silence]', ?, NULL, ?)
    `);
    stmt.run(inResponseTo, new Date().toISOString(), issuer);
  }
}

/** Get session history, optionally filtered by channel and/or issuer */
export function getSessionHistory(
  db: DatabaseSync,
  opts?: { channel?: ChannelId; issuer?: string; limit?: number },
): SessionMessage[] {
  let sql = `
    SELECT id, envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer
    FROM cortex_session
  `;
  const params: import("node:sqlite").SQLInputValue[] = [];
  const conditions: string[] = [];

  if (opts?.channel) {
    conditions.push("channel = ?");
    params.push(opts.channel);
  }
  if (opts?.issuer) {
    conditions.push("issuer = ?");
    params.push(opts.issuer);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
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
    issuer: (row.issuer as string) ?? undefined,
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
    INSERT OR REPLACE INTO cortex_pending_ops (id, type, description, dispatched_at, expected_channel, status, reply_channel, result_priority, issuer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(op.id, op.type, op.description, op.dispatchedAt, op.expectedChannel, op.status ?? "pending", op.replyChannel ?? null, op.resultPriority ?? null, op.issuer ?? "agent:main:cortex");
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

/** Mark a pending op as failed. Stays visible in the System Floor until copy+delete. */
export function failPendingOp(db: DatabaseSync, id: string, error: string): void {
  db.prepare(`
    UPDATE cortex_pending_ops
    SET status = 'failed', completed_at = ?, result = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), `Error: ${error}`, id);
}

/** Get a single pending operation by ID. Returns null if not found. */
export function getPendingOpById(db: DatabaseSync, id: string): PendingOperation | null {
  const row = db.prepare(
    `SELECT * FROM cortex_pending_ops WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? rowToPendingOp(row) : null;
}

/**
 * Get pending operations for System Floor injection.
 *
 * Only `pending` ops remain in the table — completed/failed ops are
 * copied to cortex_session and deleted by copyAndDeleteCompletedOps().
 *
 * @param issuer — optional filter by cognitive owner
 */
export function getPendingOps(db: DatabaseSync, issuer?: string): PendingOperation[] {
  if (issuer) {
    const rows = db.prepare(
      `SELECT * FROM cortex_pending_ops WHERE issuer = ? ORDER BY dispatched_at ASC`,
    ).all(issuer) as Record<string, unknown>[];
    return rows.map(rowToPendingOp);
  }
  const rows = db.prepare(
    `SELECT * FROM cortex_pending_ops ORDER BY dispatched_at ASC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToPendingOp);
}

/**
 * Copy completed/failed ops to cortex_session, then delete them.
 *
 * Called after each LLM turn. The result is preserved in cortex_session
 * (where the Fact Extractor will find it), and the op is removed from
 * cortex_pending_ops so it no longer appears in the System Floor.
 *
 * @param issuer — optional filter by cognitive owner (also written to cortex_session)
 * @returns Number of ops copied and deleted
 */
export function copyAndDeleteCompletedOps(db: DatabaseSync, issuer?: string): number {
  let sql = `SELECT * FROM cortex_pending_ops WHERE (status = 'completed' OR status = 'failed')`;
  const sqlParams: import("node:sqlite").SQLInputValue[] = [];
  if (issuer) {
    sql += ` AND issuer = ?`;
    sqlParams.push(issuer);
  }

  const rows = db.prepare(sql).all(...sqlParams) as Record<string, unknown>[];

  if (rows.length === 0) return 0;

  const insertStmt = db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
    VALUES (?, 'user', ?, 'cortex:ops', ?, ?, NULL, ?)
  `);
  const deleteStmt = db.prepare(`DELETE FROM cortex_pending_ops WHERE id = ?`);

  for (const row of rows) {
    const op = rowToPendingOp(row);
    const channel = op.replyChannel ?? op.expectedChannel;
    const opIssuer = op.issuer ?? issuer ?? "agent:main:cortex";
    // Same structured format as context.ts System Floor rendering — only Status differs
    let content: string;
    if (op.status === "completed") {
      content = `[TASK_ID]=${op.id}, Message='${op.description}', Status=Completed, Channel=${channel}, Result='${op.result ?? "(no result)"}', CompletedAt=${op.completedAt ?? "unknown"}`;
    } else {
      const errorDetail = op.result ?? "Unknown error";
      content = `[TASK_ID]=${op.id}, Message='${op.description}', Status=Failed, Channel=${channel}, Error='${errorDetail}', CompletedAt=${op.completedAt ?? "unknown"}`;
    }
    insertStmt.run(op.id, channel, content, op.completedAt ?? new Date().toISOString(), opIssuer);
    deleteStmt.run(op.id);
  }

  return rows.length;
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
    replyChannel: (row.reply_channel as string) ?? undefined,
    resultPriority: (row.result_priority as PendingOperation["resultPriority"]) ?? undefined,
    issuer: (row.issuer as string) ?? undefined,
  };
}

/** Migration: add lifecycle + issuer columns to existing tables */
function _migrateSchema(db: DatabaseSync): void {
  // --- cortex_pending_ops ---
  try {
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
    if (!colNames.has("reply_channel")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN reply_channel TEXT`);
    }
    if (!colNames.has("result_priority")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN result_priority TEXT`);
    }
    if (!colNames.has("issuer")) {
      db.exec(`ALTER TABLE cortex_pending_ops ADD COLUMN issuer TEXT NOT NULL DEFAULT 'agent:main:cortex'`);
    }
  } catch {
    // Table doesn't exist yet or migration already done — no-op
  }

  // --- cortex_session ---
  try {
    const columns = db.prepare(`PRAGMA table_info(cortex_session)`).all() as { name: string }[];
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("issuer")) {
      db.exec(`ALTER TABLE cortex_session ADD COLUMN issuer TEXT NOT NULL DEFAULT 'agent:main:cortex'`);
    }
  } catch {
    // Table doesn't exist yet or migration already done — no-op
  }
}
