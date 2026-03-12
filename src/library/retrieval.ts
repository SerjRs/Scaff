/**
 * Library Retrieval — Breadcrumbs, full item fetch, semantic search.
 *
 * All read-only operations against library/library.sqlite.
 * Used by context assembly (breadcrumbs) and sync tools (library_get, library_search).
 *
 * @see docs/library-architecture.md §3.2, §5, §6.2-6.4
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import path from "node:path";

// ---------------------------------------------------------------------------
// Read-Only DB Access
// ---------------------------------------------------------------------------

function getLibraryDbPath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "library", "library.sqlite");
}

/**
 * Open the Library database in read-only mode.
 * Returns null if the Library doesn't exist yet (no items ingested).
 * Loads sqlite-vec extension for vector queries.
 */
export function openLibraryDbReadonly(): DatabaseSync | null {
  const dbPath = getLibraryDbPath();
  if (!fs.existsSync(dbPath)) return null;

  try {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, {
      readOnly: true,
      allowExtension: true,
    } as any);

    // Load sqlite-vec for KNN queries
    try {
      const sqliteVec = require("sqlite-vec");
      db.enableLoadExtension(true);
      sqliteVec.load(db);
    } catch (err) {
      console.warn("[library] sqlite-vec not available for read-only DB:", err instanceof Error ? err.message : String(err));
    }

    return db;
  } catch (err) {
    console.warn("[library] Failed to open library DB:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  id: number;
  title: string;
  tags: string;    // JSON array string
  teaser: string;  // first 100 chars of summary
}

export interface LibraryItem {
  id: number;
  url: string;
  title: string;
  summary: string;
  key_concepts: string;  // JSON array string
  tags: string;          // JSON array string
  content_type: string;
  source_quality: string;
  ingested_at: string;
}

export interface SearchResult {
  id: number;
  title: string;
  tags: string;    // JSON array string
  teaser: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get breadcrumbs: top-K items by embedding similarity to the query.
 * Returns titles, tags, and teasers only — lightweight for context injection.
 *
 * Uses sqlite-vec KNN: WHERE embedding MATCH ? AND k = ?
 * (NOT ORDER BY + LIMIT — see MEMORY.md node:sqlite notes)
 */
export function getBreadcrumbs(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit: number = 10,
): BreadcrumbItem[] {
  try {
    const rows = db.prepare(`
      SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
      FROM item_embeddings v
      JOIN items i ON i.id = v.item_id
      WHERE v.embedding MATCH ? AND k = ?
      AND i.status = 'active'
      ORDER BY v.distance
    `).all(new Uint8Array(queryEmbedding.buffer), limit) as unknown as BreadcrumbItem[];
    return rows;
  } catch (err) {
    console.warn("[library] getBreadcrumbs failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Get full details of a Library item by ID.
 * Used by the library_get sync tool.
 */
export function getItemById(db: DatabaseSync, itemId: number): LibraryItem | null {
  try {
    const row = db.prepare(`
      SELECT id, url, title, summary, key_concepts, tags, content_type,
             source_quality, ingested_at
      FROM items
      WHERE id = ? AND status = 'active'
    `).get(itemId) as LibraryItem | undefined;
    return row ?? null;
  } catch (err) {
    console.warn(`[library] getItemById(${itemId}) failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Semantic search across the Library.
 * Used by the library_search sync tool.
 * Returns breadcrumb-format results with teasers.
 */
export function searchItems(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit: number = 10,
): SearchResult[] {
  try {
    const effectiveLimit = Math.min(limit, 20);
    const rows = db.prepare(`
      SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
      FROM item_embeddings v
      JOIN items i ON i.id = v.item_id
      WHERE v.embedding MATCH ? AND k = ?
      AND i.status = 'active'
      ORDER BY v.distance
    `).all(new Uint8Array(queryEmbedding.buffer), effectiveLimit) as unknown as SearchResult[];
    return rows;
  } catch (err) {
    console.warn("[library] searchItems failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Format breadcrumbs for context injection into the system prompt. */
export function formatBreadcrumbs(items: BreadcrumbItem[]): string {
  if (items.length === 0) return "";

  const lines = items.map((item) => {
    let tags: string[];
    try { tags = JSON.parse(item.tags); } catch (err) { console.warn(`[library] Malformed tags JSON for item ${item.id}:`, err); tags = []; }
    return `  [id:${item.id}] "${item.title}" — ${tags.join(", ")}`;
  });

  return `📚 Library (${items.length} relevant items — use library_get(id) for details, library_search(query) to explore):\n${lines.join("\n")}`;
}

/** Format a full Library item for the library_get tool response. */
export function formatItem(item: LibraryItem): string {
  let concepts: string[];
  let tags: string[];
  try { concepts = JSON.parse(item.key_concepts); } catch (err) { console.warn(`[library] Malformed key_concepts JSON for item ${item.id}:`, err); concepts = []; }
  try { tags = JSON.parse(item.tags); } catch (err) { console.warn(`[library] Malformed tags JSON for item ${item.id}:`, err); tags = []; }

  return [
    `📚 [id:${item.id}] "${item.title}"`,
    `URL: ${item.url}`,
    `Type: ${item.content_type} | Quality: ${item.source_quality} | Ingested: ${item.ingested_at.slice(0, 10)}`,
    `Tags: ${tags.join(", ")}`,
    "",
    "Summary:",
    item.summary,
    "",
    "Key Concepts:",
    concepts.map((c) => `• ${c}`).join("\n"),
  ].join("\n");
}

/** Format search results for the library_search tool response. */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matching items found in the Library.";

  const lines = results.map((r) => {
    let tags: string[];
    try { tags = JSON.parse(r.tags); } catch (err) { console.warn(`[library] Malformed tags JSON for item ${r.id}:`, err); tags = []; }
    return `  [id:${r.id}] "${r.title}" — ${tags.join(", ")}\n    ${r.teaser}...`;
  });

  return `📚 Library search results (${results.length} items — use library_get(id) for full details):\n${lines.join("\n")}`;
}

/** Compressed reference for shard persistence (~20 tokens instead of ~500). */
export function formatCompressedReference(item: LibraryItem): string {
  let tags: string[];
  try { tags = JSON.parse(item.tags); } catch (err) { console.warn(`[library] Malformed tags JSON for item ${item.id}:`, err); tags = []; }
  return `📚 Referenced: [id:${item.id}] "${item.title}" — ${tags.slice(0, 4).join(", ")}`;
}

/** Compressed search reference for shard persistence. */
export function formatCompressedSearchRef(query: string, resultCount: number): string {
  return `📚 Searched: "${query}" — ${resultCount} results`;
}
