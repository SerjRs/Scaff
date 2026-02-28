/**
 * Cortex Hippocampus — Hot Memory & Cold Storage
 *
 * Hot memory: high-frequency facts kept in a flat SQLite table,
 * ranked by hit_count + recency for System Floor injection.
 *
 * Cold storage: archived facts with vector embeddings (sqlite-vec)
 * for semantic retrieval when hot memory doesn't cover the query.
 *
 * @see docs/cortex-architecture.md (Hippocampus)
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../memory/sqlite-vec.js";

// ---------------------------------------------------------------------------
// Hot Memory Schema
// ---------------------------------------------------------------------------

/** Initialize the cortex_hot_memory table */
export function initHotMemoryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_hot_memory (
      id               TEXT PRIMARY KEY,
      fact_text        TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      hit_count        INTEGER NOT NULL DEFAULT 0
    )
  `);
}

// ---------------------------------------------------------------------------
// Cold Storage Schema
// ---------------------------------------------------------------------------

/** Initialize cold storage: sqlite-vec virtual table + metadata table */
export async function initColdStorage(db: DatabaseSync): Promise<void> {
  const result = await loadSqliteVecExtension({ db });
  if (!result.ok) {
    throw new Error(`Failed to load sqlite-vec extension: ${result.error}`);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cortex_cold_memory_vec
    USING vec0(embedding float[768])
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_cold_memory (
      rowid       INTEGER PRIMARY KEY,
      fact_text   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      archived_at TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// Hot Memory CRUD
// ---------------------------------------------------------------------------

/** A hot memory fact */
export interface HotFact {
  id: string;
  factText: string;
  createdAt: string;
  lastAccessedAt: string;
  hitCount: number;
}

/** Insert a fact into hot memory */
export function insertHotFact(
  db: DatabaseSync,
  fact: { id?: string; factText: string },
): string {
  const id = fact.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, fact.factText, now, now);
  return id;
}

/** Get top hot facts ordered by hit_count DESC, last_accessed_at DESC */
export function getTopHotFacts(db: DatabaseSync, limit = 50): HotFact[] {
  const rows = db.prepare(`
    SELECT id, fact_text, created_at, last_accessed_at, hit_count
    FROM cortex_hot_memory
    ORDER BY hit_count DESC, last_accessed_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map(rowToHotFact);
}

/** Touch a fact: update last_accessed_at and increment hit_count */
export function touchHotFact(db: DatabaseSync, id: string): void {
  db.prepare(`
    UPDATE cortex_hot_memory
    SET last_accessed_at = ?, hit_count = hit_count + 1
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

/** Get stale facts: old + low hit count (eviction candidates) */
export function getStaleHotFacts(
  db: DatabaseSync,
  olderThanDays = 14,
  maxHitCount = 3,
): HotFact[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffIso = cutoff.toISOString();

  const rows = db.prepare(`
    SELECT id, fact_text, created_at, last_accessed_at, hit_count
    FROM cortex_hot_memory
    WHERE last_accessed_at < ? AND hit_count <= ?
    ORDER BY hit_count ASC, last_accessed_at ASC
  `).all(cutoffIso, maxHitCount) as Record<string, unknown>[];

  return rows.map(rowToHotFact);
}

/** Delete a fact from hot memory */
export function deleteHotFact(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM cortex_hot_memory WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Cold Storage CRUD
// ---------------------------------------------------------------------------

/** A cold memory fact (archived from hot memory) */
export interface ColdFact {
  rowid: number;
  factText: string;
  createdAt: string;
  archivedAt: string;
}

/** Insert a fact + embedding into cold storage */
export function insertColdFact(
  db: DatabaseSync,
  factText: string,
  embedding: Float32Array,
): number {
  const now = new Date().toISOString();

  // Insert metadata first to get rowid
  db.prepare(`
    INSERT INTO cortex_cold_memory (fact_text, created_at, archived_at)
    VALUES (?, ?, ?)
  `).run(factText, now, now);

  const { id: rowid } = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number | bigint };
  const rowidNum = Number(rowid);

  // Insert embedding into vec table with matching rowid
  // CAST required: node:sqlite binds JS numbers as REAL, but sqlite-vec requires INTEGER rowids
  db.prepare(`
    INSERT INTO cortex_cold_memory_vec (rowid, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `).run(rowidNum, new Uint8Array(embedding.buffer));

  return rowidNum;
}

/** Search cold storage by vector similarity (KNN) */
export function searchColdFacts(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit = 5,
): (ColdFact & { distance: number })[] {
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, m.fact_text, m.created_at, m.archived_at
    FROM cortex_cold_memory_vec v
    JOIN cortex_cold_memory m ON m.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(new Uint8Array(queryEmbedding.buffer), limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    rowid: row.rowid as number,
    factText: row.fact_text as string,
    createdAt: row.created_at as string,
    archivedAt: row.archived_at as string,
    distance: row.distance as number,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToHotFact(row: Record<string, unknown>): HotFact {
  return {
    id: row.id as string,
    factText: row.fact_text as string,
    createdAt: row.created_at as string,
    lastAccessedAt: row.last_accessed_at as string,
    hitCount: row.hit_count as number,
  };
}
