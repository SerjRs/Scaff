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

/** Initialize the cortex_hot_memory table + companion vec table for dedup */
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
  initGraphTables(db);
}

/** Initialize the hot memory vector table (requires sqlite-vec loaded) */
export async function initHotMemoryVecTable(db: DatabaseSync): Promise<void> {
  const result = await loadSqliteVecExtension({ db });
  if (!result.ok) {
    throw new Error(`Failed to load sqlite-vec extension: ${result.error}`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cortex_hot_memory_vec
    USING vec0(embedding float[768])
  `);
}

// ---------------------------------------------------------------------------
// Graph Vec Table
// ---------------------------------------------------------------------------

/** Initialize the hippocampus_facts vector table (requires sqlite-vec loaded) */
export async function initGraphVecTable(db: DatabaseSync): Promise<void> {
  const result = await loadSqliteVecExtension({ db });
  if (!result.ok) {
    throw new Error(`Failed to load sqlite-vec extension: ${result.error}`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hippocampus_facts_vec
    USING vec0(embedding float[768])
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

/** Insert a fact into hot memory (optionally with embedding for dedup) */
export function insertHotFact(
  db: DatabaseSync,
  fact: { id?: string; factText: string; embedding?: Float32Array },
): string {
  const id = fact.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, fact.factText, now, now);

  // If embedding provided, insert into vec table for similarity search
  if (fact.embedding) {
    const row = db.prepare(`SELECT rowid FROM cortex_hot_memory WHERE id = ?`).get(id) as { rowid: number | bigint };
    const rowidNum = Number(row.rowid);
    db.prepare(`
      INSERT INTO cortex_hot_memory_vec (rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `).run(rowidNum, new Uint8Array(fact.embedding.buffer));
  }

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

/** Delete a fact from hot memory (and its vec embedding if present) */
export function deleteHotFact(db: DatabaseSync, id: string): void {
  // Clean up vec table first (best-effort — table may not exist yet)
  try {
    const row = db.prepare(`SELECT rowid FROM cortex_hot_memory WHERE id = ?`).get(id) as { rowid: number } | undefined;
    if (row) {
      db.prepare(`DELETE FROM cortex_hot_memory_vec WHERE rowid = ?`).run(row.rowid);
    }
  } catch {
    // Vec table may not exist — ignore
  }
  db.prepare(`DELETE FROM cortex_hot_memory WHERE id = ?`).run(id);
}

/** Search hot memory by vector similarity (KNN) */
export function searchHotFacts(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit = 5,
): (HotFact & { distance: number })[] {
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, m.id, m.fact_text, m.created_at, m.last_accessed_at, m.hit_count
    FROM cortex_hot_memory_vec v
    JOIN cortex_hot_memory m ON m.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(new Uint8Array(queryEmbedding.buffer), limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    factText: row.fact_text as string,
    createdAt: row.created_at as string,
    lastAccessedAt: row.last_accessed_at as string,
    hitCount: row.hit_count as number,
    distance: row.distance as number,
  }));
}

/** Update an existing hot fact's text and embedding (for dedup replacement) */
export function updateHotFact(
  db: DatabaseSync,
  id: string,
  newFactText: string,
  newEmbedding: Float32Array,
): void {
  // Update text
  db.prepare(`
    UPDATE cortex_hot_memory
    SET fact_text = ?, last_accessed_at = ?
    WHERE id = ?
  `).run(newFactText, new Date().toISOString(), id);

  // Update embedding — need the rowid
  const row = db.prepare(`SELECT rowid FROM cortex_hot_memory WHERE id = ?`).get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare(`DELETE FROM cortex_hot_memory_vec WHERE rowid = ?`).run(row.rowid);
    db.prepare(`
      INSERT INTO cortex_hot_memory_vec (rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `).run(row.rowid, new Uint8Array(newEmbedding.buffer));
  }
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
// Graph Schema (hippocampus_facts + hippocampus_edges)
// ---------------------------------------------------------------------------

/** A graph fact node */
export interface GraphFact {
  id: string;
  factText: string;
  factType: string;
  confidence: string;
  status: string;
  sourceType: string | null;
  sourceRef: string | null;
  createdAt: string;
  lastAccessedAt: string;
  hitCount: number;
}

/** A graph edge between two facts */
export interface GraphEdge {
  id: string;
  fromFactId: string;
  toFactId: string;
  edgeType: string;
  confidence: string;
  isStub: boolean;
  stubTopic: string | null;
}

/** A fact with its immediate edges */
export interface GraphFactWithEdges extends GraphFact {
  edges: Array<{
    edgeId: string;
    edgeType: string;
    targetFactId: string;
    targetHint: string;
    isStub: boolean;
  }>;
}

/** Initialize hippocampus_facts + hippocampus_edges tables */
export function initGraphTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hippocampus_facts (
      id               TEXT PRIMARY KEY,
      fact_text        TEXT NOT NULL,
      fact_type        TEXT DEFAULT 'fact',
      confidence       TEXT DEFAULT 'medium',
      status           TEXT DEFAULT 'active',
      source_type      TEXT,
      source_ref       TEXT,
      created_at       TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      hit_count        INTEGER NOT NULL DEFAULT 0,
      cold_vector_id   INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hippocampus_edges (
      id             TEXT PRIMARY KEY,
      from_fact_id   TEXT NOT NULL,
      to_fact_id     TEXT NOT NULL,
      edge_type      TEXT NOT NULL,
      confidence     TEXT DEFAULT 'medium',
      is_stub        INTEGER DEFAULT 0,
      stub_topic     TEXT,
      created_at     TEXT NOT NULL,
      FOREIGN KEY (from_fact_id) REFERENCES hippocampus_facts(id),
      FOREIGN KEY (to_fact_id) REFERENCES hippocampus_facts(id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from ON hippocampus_edges(from_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to ON hippocampus_edges(to_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_status ON hippocampus_facts(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_hot ON hippocampus_facts(hit_count DESC, last_accessed_at DESC)`);
}

/** Migrate existing cortex_hot_memory rows into hippocampus_facts (idempotent) */
export function migrateHotMemoryToGraph(db: DatabaseSync): void {
  // Skip if already migrated
  const existing = db.prepare(`SELECT COUNT(*) as cnt FROM hippocampus_facts`).get() as { cnt: number };
  if (existing.cnt > 0) return;

  const rows = db.prepare(`
    SELECT id, fact_text, created_at, last_accessed_at, hit_count
    FROM cortex_hot_memory
  `).all() as Record<string, unknown>[];

  const stmt = db.prepare(`
    INSERT INTO hippocampus_facts (id, fact_text, fact_type, confidence, status, source_type, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, 'fact', 'medium', 'active', 'conversation', ?, ?, ?)
  `);

  for (const row of rows) {
    stmt.run(row.id, row.fact_text, row.created_at, row.last_accessed_at, row.hit_count);
  }
}

// ---------------------------------------------------------------------------
// Graph CRUD
// ---------------------------------------------------------------------------

/** Insert a fact into the graph. Optionally insert embedding into vec table for dedup. */
export function insertFact(
  db: DatabaseSync,
  opts: {
    factText: string;
    factType?: string;
    confidence?: string;
    sourceType?: string;
    sourceRef?: string;
    embedding?: Float32Array;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_facts (id, fact_text, fact_type, confidence, status, source_type, source_ref, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)
  `).run(
    id,
    opts.factText,
    opts.factType ?? "fact",
    opts.confidence ?? "medium",
    opts.sourceType ?? null,
    opts.sourceRef ?? null,
    now,
    now,
  );

  if (opts.embedding) {
    const row = db.prepare(`SELECT rowid FROM hippocampus_facts WHERE id = ?`).get(id) as { rowid: number | bigint };
    const rowidNum = Number(row.rowid);
    db.prepare(`
      INSERT INTO hippocampus_facts_vec (rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `).run(rowidNum, new Uint8Array(opts.embedding.buffer));
  }

  return id;
}

/** Insert an edge between two facts */
export function insertEdge(
  db: DatabaseSync,
  opts: {
    fromFactId: string;
    toFactId: string;
    edgeType: string;
    confidence?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, opts.fromFactId, opts.toFactId, opts.edgeType, opts.confidence ?? "medium", now);
  return id;
}

/** Search graph facts by vector similarity (KNN). Only returns active facts. */
export function searchGraphFacts(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  limit = 5,
): (GraphFact & { distance: number })[] {
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, f.id, f.fact_text, f.fact_type, f.confidence, f.status,
           f.source_type, f.source_ref, f.created_at, f.last_accessed_at, f.hit_count
    FROM hippocampus_facts_vec v
    JOIN hippocampus_facts f ON f.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
      AND f.status = 'active'
    ORDER BY v.distance
  `).all(new Uint8Array(queryEmbedding.buffer), limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...rowToGraphFact(row),
    distance: row.distance as number,
  }));
}

/** Get a single fact with its edges (both directions) */
export function getFactWithEdges(db: DatabaseSync, factId: string): GraphFactWithEdges | null {
  const row = db.prepare(`
    SELECT id, fact_text, fact_type, confidence, status, source_type, source_ref,
           created_at, last_accessed_at, hit_count
    FROM hippocampus_facts WHERE id = ?
  `).get(factId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const fact = rowToGraphFact(row);
  const edges = queryEdgesForFact(db, factId);

  return { ...fact, edges };
}

/** Get top facts ordered by hit_count DESC, last_accessed_at DESC, with edges */
export function getTopFactsWithEdges(
  db: DatabaseSync,
  limit = 30,
  maxEdgesPerFact = 3,
): GraphFactWithEdges[] {
  const rows = db.prepare(`
    SELECT id, fact_text, fact_type, confidence, status, source_type, source_ref,
           created_at, last_accessed_at, hit_count
    FROM hippocampus_facts
    WHERE status = 'active'
    ORDER BY hit_count DESC, last_accessed_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map((row) => {
    const fact = rowToGraphFact(row);
    const edges = queryEdgesForFact(db, fact.id, maxEdgesPerFact);
    return { ...fact, edges };
  });
}

/** Update a fact's status */
export function updateFactStatus(
  db: DatabaseSync,
  factId: string,
  status: "active" | "superseded" | "evicted",
): void {
  db.prepare(`UPDATE hippocampus_facts SET status = ? WHERE id = ?`).run(status, factId);
}

/** Convert an edge to a stub (target evicted, keep skeleton) */
export function setEdgeStub(db: DatabaseSync, edgeId: string, stubTopic: string): void {
  db.prepare(`UPDATE hippocampus_edges SET is_stub = 1, stub_topic = ? WHERE id = ?`).run(stubTopic, edgeId);
}

/** Touch a graph fact: update last_accessed_at and increment hit_count */
export function touchGraphFact(db: DatabaseSync, factId: string): void {
  db.prepare(`
    UPDATE hippocampus_facts
    SET last_accessed_at = ?, hit_count = hit_count + 1
    WHERE id = ?
  `).run(new Date().toISOString(), factId);
}

// ---------------------------------------------------------------------------
// Graph Eviction / Revival
// ---------------------------------------------------------------------------

/** Get stale graph facts: old + low hit count (eviction candidates). Only active facts. */
export function getStaleGraphFacts(
  db: DatabaseSync,
  olderThanDays = 14,
  maxHitCount = 3,
): GraphFact[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffIso = cutoff.toISOString();

  const rows = db.prepare(`
    SELECT id, fact_text, fact_type, confidence, status, source_type, source_ref,
           created_at, last_accessed_at, hit_count
    FROM hippocampus_facts
    WHERE status = 'active' AND last_accessed_at < ? AND hit_count <= ?
    ORDER BY hit_count ASC, last_accessed_at ASC
  `).all(cutoffIso, maxHitCount) as Record<string, unknown>[];

  return rows.map(rowToGraphFact);
}

/** Evict a graph fact to cold storage, marking edges as stubs. */
export function evictFact(
  db: DatabaseSync,
  factId: string,
  embedding: Float32Array,
): void {
  // 1. Read the fact
  const factRow = db.prepare(
    `SELECT fact_text FROM hippocampus_facts WHERE id = ?`,
  ).get(factId) as { fact_text: string } | undefined;
  if (!factRow) return;

  // 2. Insert into cold storage
  const coldRowid = insertColdFact(db, factRow.fact_text, embedding);

  // 3. Update fact status
  db.prepare(`
    UPDATE hippocampus_facts
    SET status = 'evicted', cold_vector_id = ?
    WHERE id = ?
  `).run(coldRowid, factId);

  // 4. Mark touching edges as stubs
  const stubTopic = factRow.fact_text.slice(0, 50);
  db.prepare(`
    UPDATE hippocampus_edges
    SET is_stub = 1, stub_topic = ?
    WHERE from_fact_id = ? OR to_fact_id = ?
  `).run(stubTopic, factId, factId);
}

/** Revive an evicted graph fact back to active status. Reconnects edges where the other endpoint is active. */
export function reviveFact(db: DatabaseSync, factId: string): void {
  // 1. Restore fact status
  db.prepare(`
    UPDATE hippocampus_facts
    SET status = 'active', hit_count = 1, last_accessed_at = ?, cold_vector_id = NULL
    WHERE id = ?
  `).run(new Date().toISOString(), factId);

  // 2. Reconnect edges where the OTHER endpoint is active
  // Edges where this fact is from_fact_id: check to_fact_id status
  db.prepare(`
    UPDATE hippocampus_edges
    SET is_stub = 0, stub_topic = NULL
    WHERE from_fact_id = ? AND is_stub = 1
      AND to_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'active')
  `).run(factId);

  // Edges where this fact is to_fact_id: check from_fact_id status
  db.prepare(`
    UPDATE hippocampus_edges
    SET is_stub = 0, stub_topic = NULL
    WHERE to_fact_id = ? AND is_stub = 1
      AND from_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'active')
  `).run(factId);
}

/** Prune old stub edges where both endpoints are evicted. Returns count of deleted edges. */
export function pruneOldStubs(db: DatabaseSync, olderThanDays = 90): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffIso = cutoff.toISOString();

  const result = db.prepare(`
    DELETE FROM hippocampus_edges
    WHERE is_stub = 1
      AND created_at < ?
      AND from_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'evicted')
      AND to_fact_id IN (SELECT id FROM hippocampus_facts WHERE status = 'evicted')
  `).run(cutoffIso);

  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Graph Traversal
// ---------------------------------------------------------------------------

/** A node in a graph traversal result */
export interface TraversalNode {
  factId: string;
  factText: string;
  factType: string;
  status: string;
  depth: number;
  edges: Array<{
    edgeType: string;
    direction: "outgoing" | "incoming";
    targetFactId: string;
    targetText: string;
    isStub: boolean;
    stubTopic: string | null;
  }>;
}

/**
 * Walk the knowledge graph N hops from a starting fact.
 * Uses a recursive CTE to collect reachable fact IDs.
 * Caps at depth=4 max, 50 total nodes max.
 * Returns a formatted string showing the subgraph.
 */
export function traverseGraph(
  db: DatabaseSync,
  startFactId: string,
  depth: number = 2,
  direction: "outgoing" | "incoming" | "both" = "both",
): string {
  // Enforce caps
  const maxDepth = Math.min(Math.max(depth, 1), 4);
  const maxNodes = 50;

  // Check starting fact exists
  const startRow = db.prepare(
    `SELECT id, fact_text, fact_type, status FROM hippocampus_facts WHERE id = ?`,
  ).get(startFactId) as Record<string, unknown> | undefined;

  if (!startRow) {
    return `Error: fact "${startFactId}" not found in knowledge graph.`;
  }

  // Build direction-specific edge conditions for the CTE
  let edgeJoin: string;
  if (direction === "outgoing") {
    edgeJoin = `SELECT e.to_fact_id AS next_id, r.depth + 1 AS depth
                FROM hippocampus_edges e
                JOIN reachable r ON e.from_fact_id = r.fact_id
                WHERE r.depth < ?`;
  } else if (direction === "incoming") {
    edgeJoin = `SELECT e.from_fact_id AS next_id, r.depth + 1 AS depth
                FROM hippocampus_edges e
                JOIN reachable r ON e.to_fact_id = r.fact_id
                WHERE r.depth < ?`;
  } else {
    edgeJoin = `SELECT CASE WHEN e.from_fact_id = r.fact_id THEN e.to_fact_id ELSE e.from_fact_id END AS next_id,
                       r.depth + 1 AS depth
                FROM hippocampus_edges e
                JOIN reachable r ON (e.from_fact_id = r.fact_id OR e.to_fact_id = r.fact_id)
                WHERE r.depth < ?`;
  }

  // Recursive CTE to find all reachable facts within maxDepth hops
  const cteQuery = `
    WITH RECURSIVE reachable(fact_id, depth) AS (
      SELECT ?, 0
      UNION
      ${edgeJoin}
    )
    SELECT DISTINCT fact_id, MIN(depth) AS depth
    FROM reachable
    GROUP BY fact_id
    ORDER BY depth ASC
    LIMIT ?
  `;

  const reachableRows = db.prepare(cteQuery).all(
    startFactId, maxDepth, maxNodes,
  ) as Array<{ fact_id: string; depth: number }>;

  // Build a map of fact_id -> TraversalNode
  const nodes = new Map<string, TraversalNode>();

  for (const r of reachableRows) {
    const factRow = db.prepare(
      `SELECT id, fact_text, fact_type, status FROM hippocampus_facts WHERE id = ?`,
    ).get(r.fact_id) as Record<string, unknown> | undefined;

    if (!factRow) continue;

    nodes.set(r.fact_id, {
      factId: r.fact_id,
      factText: factRow.fact_text as string,
      factType: factRow.fact_type as string,
      status: factRow.status as string,
      depth: r.depth,
      edges: [],
    });
  }

  // Populate edges for each node (only edges that connect to other nodes in the result set)
  for (const [factId, node] of nodes) {
    // Outgoing edges
    const outEdges = db.prepare(`
      SELECT e.edge_type, e.to_fact_id, e.is_stub, e.stub_topic, f.fact_text AS target_text
      FROM hippocampus_edges e
      LEFT JOIN hippocampus_facts f ON f.id = e.to_fact_id
      WHERE e.from_fact_id = ?
    `).all(factId) as Array<Record<string, unknown>>;

    for (const e of outEdges) {
      const targetId = e.to_fact_id as string;
      const isStub = (e.is_stub as number) === 1;
      // Only include edges to nodes in our result set, or stub edges
      if (nodes.has(targetId) || isStub) {
        node.edges.push({
          edgeType: e.edge_type as string,
          direction: "outgoing",
          targetFactId: targetId,
          targetText: isStub ? "" : (e.target_text as string ?? ""),
          isStub,
          stubTopic: (e.stub_topic as string) ?? null,
        });
      }
    }

    // Incoming edges
    const inEdges = db.prepare(`
      SELECT e.edge_type, e.from_fact_id, e.is_stub, e.stub_topic, f.fact_text AS source_text
      FROM hippocampus_edges e
      LEFT JOIN hippocampus_facts f ON f.id = e.from_fact_id
      WHERE e.to_fact_id = ?
    `).all(factId) as Array<Record<string, unknown>>;

    for (const e of inEdges) {
      const sourceId = e.from_fact_id as string;
      const isStub = (e.is_stub as number) === 1;
      if (nodes.has(sourceId) || isStub) {
        node.edges.push({
          edgeType: e.edge_type as string,
          direction: "incoming",
          targetFactId: sourceId,
          targetText: isStub ? "" : (e.source_text as string ?? ""),
          isStub,
          stubTopic: (e.stub_topic as string) ?? null,
        });
      }
    }
  }

  // Format output
  const startNode = nodes.get(startFactId)!;
  const lines: string[] = [
    `Subgraph from "${startNode.factText}" (depth=${maxDepth}, ${nodes.size} nodes):`,
    "",
  ];

  for (const [, node] of nodes) {
    const statusSuffix = node.status !== "active" ? ` [${node.status.toUpperCase()}]` : "";
    lines.push(`[${node.factId}] ${node.factText} (${node.factType})${statusSuffix}`);

    for (const edge of node.edges) {
      const arrow = edge.direction === "outgoing" ? "→" : "←";
      if (edge.isStub) {
        lines.push(`  ${arrow} ${edge.edgeType} [EVICTED: ${edge.stubTopic ?? "unknown"}]`);
      } else {
        lines.push(`  ${arrow} ${edge.edgeType} [${edge.targetFactId}] ${edge.targetText}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
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

function rowToGraphFact(row: Record<string, unknown>): GraphFact {
  return {
    id: row.id as string,
    factText: row.fact_text as string,
    factType: row.fact_type as string,
    confidence: row.confidence as string,
    status: row.status as string,
    sourceType: (row.source_type as string) ?? null,
    sourceRef: (row.source_ref as string) ?? null,
    createdAt: row.created_at as string,
    lastAccessedAt: row.last_accessed_at as string,
    hitCount: row.hit_count as number,
  };
}

/** Query edges for a fact (both directions), with target hint */
export function queryEdgesForFact(
  db: DatabaseSync,
  factId: string,
  limit?: number,
): GraphFactWithEdges["edges"] {
  const limitClause = limit != null ? `LIMIT ${limit}` : "";

  const rows = db.prepare(`
    SELECT
      e.id AS edge_id,
      e.edge_type,
      e.is_stub,
      e.stub_topic,
      CASE WHEN e.from_fact_id = ? THEN e.to_fact_id ELSE e.from_fact_id END AS target_fact_id,
      f.fact_text AS target_fact_text
    FROM hippocampus_edges e
    LEFT JOIN hippocampus_facts f
      ON f.id = CASE WHEN e.from_fact_id = ? THEN e.to_fact_id ELSE e.from_fact_id END
    WHERE e.from_fact_id = ? OR e.to_fact_id = ?
    ${limitClause}
  `).all(factId, factId, factId, factId) as Record<string, unknown>[];

  return rows.map((r) => {
    const isStub = (r.is_stub as number) === 1;
    const targetText = r.target_fact_text as string | null;
    const stubTopic = r.stub_topic as string | null;
    const targetHint = isStub && stubTopic
      ? stubTopic
      : targetText
        ? targetText.slice(0, 80)
        : "";

    return {
      edgeId: r.edge_id as string,
      edgeType: r.edge_type as string,
      targetFactId: r.target_fact_id as string,
      targetHint,
      isStub,
    };
  });
}
