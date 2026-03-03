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

/** Record a tool call in the session so the LLM can see its own actions in future turns.
 *  @deprecated Use appendStructuredContent() for new code — this stores tool calls as flat text
 *  which causes context poisoning (the LLM learns to output tool calls as text on replay). */
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

/** Store structured content blocks (tool_use, tool_result, text) in the session.
 *  Content is JSON-serialized so contextToMessages() can replay it as proper
 *  Anthropic API content blocks instead of flat text.
 *  @see docs/hipocampus-architecture.md §6.6 */
export function appendStructuredContent(
  db: DatabaseSync,
  envelopeId: string,
  role: "user" | "assistant",
  channel: string,
  contentBlocks: unknown[],
  issuer = "agent:main:cortex",
): void {
  const content = JSON.stringify(contentBlocks);
  db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
    VALUES (?, ?, ?, 'cortex', ?, ?, NULL, ?)
  `).run(envelopeId, role, channel, content, new Date().toISOString(), issuer);
}

/** Write a task result directly to the session as a foreground message.
 *  This replaces the old cortex_pending_ops → System Floor path so the LLM
 *  sees completed/failed results as conversation messages it naturally responds to. */
export function appendTaskResult(db: DatabaseSync, params: {
  taskId: string;
  description: string;
  status: "completed" | "failed";
  channel: string;
  result?: string;
  error?: string;
  completedAt: string;
  issuer?: string;
}): void {
  const { taskId, description, status, channel, result, error, completedAt, issuer } = params;
  let content: string;
  if (status === "completed") {
    content = `[TASK_ID]=${taskId}, Message='${description}', Status=Completed, Channel=${channel}, Result='${result ?? "(no result)"}', CompletedAt=${completedAt}`;
  } else {
    content = `[TASK_ID]=${taskId}, Message='${description}', Status=Failed, Channel=${channel}, Error='${error ?? "Unknown error"}', CompletedAt=${completedAt}`;
  }
  db.prepare(`
    INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
    VALUES (?, 'user', ?, 'cortex:ops', ?, ?, NULL, ?)
  `).run(taskId, channel, content, completedAt, issuer ?? "agent:main:cortex");
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
// Helpers
// ---------------------------------------------------------------------------

/** Migration: add issuer column to existing tables */
function _migrateSchema(db: DatabaseSync): void {
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
