/**
 * Library Database — Domain knowledge store for any Cortex deployment.
 *
 * Separate from cortex/bus.sqlite. Persists across Cortex restarts,
 * context resets, and session cleanups.
 *
 * @see docs/library-architecture.md §5
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveStateDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function getLibraryDbPath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "library", "library.sqlite");
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open (or create) the Library database.
 * Creates the `library/` directory if it doesn't exist.
 * Creates tables if they don't exist.
 */
export function openLibraryDb(): DatabaseSync {
  const dbPath = getLibraryDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, {
    allowExtension: true,
  } as any);

  // Enable WAL mode for concurrent reads
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL,
      summary         TEXT NOT NULL,
      key_concepts    TEXT NOT NULL,
      full_text       TEXT,
      tags            TEXT NOT NULL,
      content_type    TEXT NOT NULL,
      source_quality  TEXT DEFAULT 'medium',
      partial         INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'active',
      error           TEXT,
      version         INTEGER DEFAULT 1,
      ingested_at     TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_ingested ON items(ingested_at);
    CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
  `);

  // sqlite-vec extension for vector search
  // Uses require() because openLibraryDb is synchronous (same pattern as bus.ts init).
  // The async loadSqliteVecExtension() from memory/sqlite-vec.ts isn't usable in a sync context.
  try {
    const sqliteVec = require("sqlite-vec");
    db.enableLoadExtension(true);
    sqliteVec.load(db);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(
        item_id INTEGER PRIMARY KEY,
        embedding float[768]
      );
    `);
  } catch {
    // sqlite-vec not available — embeddings table skipped
    // Items can still be stored; embeddings added when extension is available
    console.warn("[library] sqlite-vec not available, skipping item_embeddings table");
  }

  return db;
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a new Library item. Returns the item ID.
 * If the URL already exists, updates the existing entry and increments version.
 */
export function insertItem(db: DatabaseSync, item: {
  url: string;
  title: string;
  summary: string;
  key_concepts: string[];
  full_text?: string;
  tags: string[];
  content_type: string;
  source_quality?: string;
  partial?: boolean;
  status?: string;
  error?: string;
}): number {
  const existing = db.prepare("SELECT id, version FROM items WHERE url = ?").get(item.url) as
    | { id: number; version: number }
    | undefined;

  if (existing) {
    // Update existing entry, increment version
    db.prepare(`
      UPDATE items SET
        title = ?, summary = ?, key_concepts = ?, full_text = ?,
        tags = ?, content_type = ?, source_quality = ?,
        partial = ?, status = ?, error = ?,
        version = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      item.title, item.summary, JSON.stringify(item.key_concepts), item.full_text ?? null,
      JSON.stringify(item.tags), item.content_type, item.source_quality ?? "medium",
      item.partial ? 1 : 0, item.status ?? "active", item.error ?? null,
      existing.version + 1, existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO items (url, title, summary, key_concepts, full_text, tags,
                       content_type, source_quality, partial, status, error, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.url, item.title, item.summary, JSON.stringify(item.key_concepts),
    item.full_text ?? null, JSON.stringify(item.tags), item.content_type,
    item.source_quality ?? "medium", item.partial ? 1 : 0,
    item.status ?? "active", item.error ?? null,
    new Date().toISOString(),
  );

  return Number(result.lastInsertRowid);
}

/**
 * Insert or replace an embedding for a Library item.
 */
export function insertEmbedding(db: DatabaseSync, itemId: number, embedding: Float32Array | number[]): void {
  // Delete existing embedding if any (for re-ingestion)
  db.prepare("DELETE FROM item_embeddings WHERE item_id = ?").run(itemId);
  db.prepare("INSERT INTO item_embeddings (item_id, embedding) VALUES (CAST(? AS INTEGER), ?)").run(
    itemId,
    new Float32Array(embedding),
  );
}

/**
 * Insert a failed ingestion entry. Tracks the URL so duplicates are caught.
 */
export function insertFailedItem(db: DatabaseSync, url: string, error: string): number {
  const existing = db.prepare("SELECT id FROM items WHERE url = ?").get(url) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare("UPDATE items SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(error, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO items (url, title, summary, key_concepts, tags, content_type,
                       status, error, ingested_at)
    VALUES (?, '', '', '[]', '[]', 'unknown', 'failed', ?, ?)
  `).run(url, error, new Date().toISOString());

  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Library Task Metadata (stored in cortex/bus.sqlite, not library.sqlite)
// ---------------------------------------------------------------------------

/**
 * Store metadata for a pending Library ingestion task.
 * Used by the ops-trigger handler to detect Library tasks.
 *
 * @param db - cortex/bus.sqlite database handle (NOT library.sqlite)
 */
export function storeLibraryTaskMeta(db: DatabaseSync, taskId: string, url: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_pending_tasks (
      task_id   TEXT PRIMARY KEY,
      url       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare("INSERT OR REPLACE INTO library_pending_tasks (task_id, url) VALUES (?, ?)").run(taskId, url);
}

/**
 * Check if a task is a Library ingestion. Returns the URL if yes, null if no.
 *
 * @param db - cortex/bus.sqlite database handle
 */
export function getLibraryTaskMeta(db: DatabaseSync, taskId: string): string | null {
  try {
    const row = db.prepare("SELECT url FROM library_pending_tasks WHERE task_id = ?").get(taskId) as
      | { url: string }
      | undefined;
    return row?.url ?? null;
  } catch (err) {
    console.warn(`[library] getLibraryTaskMeta(${taskId}) failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Remove a completed Library task from pending.
 *
 * @param db - cortex/bus.sqlite database handle
 */
export function removeLibraryTaskMeta(db: DatabaseSync, taskId: string): void {
  try {
    db.prepare("DELETE FROM library_pending_tasks WHERE task_id = ?").run(taskId);
  } catch (err) {
    console.warn(`[library] removeLibraryTaskMeta(${taskId}) failed:`, err instanceof Error ? err.message : String(err));
  }
}
