/**
 * Audio session tracking — SQLite table in bus.sqlite.
 *
 * Uses node:sqlite DatabaseSync (same pattern as src/cortex/bus.ts).
 */

import type { DatabaseSync } from "node:sqlite";
import type { AudioSession, AudioSessionStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initAudioSessionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_sessions (
      session_id      TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'receiving',
      chunks_received INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT,
      error           TEXT
    )
  `);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create or return existing session. Returns the session. */
export function upsertSession(db: DatabaseSync, sessionId: string): AudioSession {
  const existing = getSession(db, sessionId);
  if (existing) return existing;

  db.prepare(`
    INSERT INTO audio_sessions (session_id, status, chunks_received, created_at)
    VALUES (?, 'receiving', 0, datetime('now'))
  `).run(sessionId);

  return getSession(db, sessionId)!;
}

/** Increment chunk count for a session. */
export function incrementChunks(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    UPDATE audio_sessions
    SET chunks_received = chunks_received + 1
    WHERE session_id = ?
  `).run(sessionId);
}

/** Get session by ID. */
export function getSession(db: DatabaseSync, sessionId: string): AudioSession | null {
  const row = db.prepare(`
    SELECT session_id, status, chunks_received, created_at, completed_at, error
    FROM audio_sessions
    WHERE session_id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToSession(row);
}

/** Update session status. */
export function updateSessionStatus(
  db: DatabaseSync,
  sessionId: string,
  status: AudioSessionStatus,
  opts?: { error?: string },
): void {
  const completedAt = status === "pending_transcription" || status === "done" || status === "failed"
    ? new Date().toISOString()
    : null;

  db.prepare(`
    UPDATE audio_sessions
    SET status = ?, completed_at = COALESCE(?, completed_at), error = COALESCE(?, error)
    WHERE session_id = ?
  `).run(status, completedAt, opts?.error ?? null, sessionId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSession(row: Record<string, unknown>): AudioSession {
  return {
    sessionId: row.session_id as string,
    status: row.status as AudioSessionStatus,
    chunksReceived: row.chunks_received as number,
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
    error: (row.error as string) ?? null,
  };
}
