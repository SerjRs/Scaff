import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";
import type { ArchivedJob, JobStatus, JobType, RouterJob } from "./types.js";

const DEFAULT_DB_PATH = "~/.openclaw/router/queue.sqlite";

export function initRouterDb(dbPath?: string): DatabaseSync {
  const resolved = resolveUserPath(dbPath ?? DEFAULT_DB_PATH);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolved);

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'in_queue',
      weight          INTEGER,
      tier            TEXT,
      issuer          TEXT NOT NULL,
      payload         TEXT NOT NULL,
      result          TEXT,
      error           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      started_at      TEXT,
      finished_at     TEXT,
      delivered_at    TEXT,
      retry_count     INTEGER DEFAULT 0,
      worker_id       TEXT,
      last_checkpoint TEXT,
      checkpoint_data TEXT
    );
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_issuer ON jobs(issuer)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs_archive (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      status          TEXT NOT NULL,
      weight          INTEGER,
      tier            TEXT,
      issuer          TEXT NOT NULL,
      payload         TEXT NOT NULL,
      result          TEXT,
      error           TEXT,
      retry_count     INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT,
      delivered_at    TEXT,
      archived_at     TEXT NOT NULL DEFAULT (datetime('now')),
      worker_id       TEXT
    );
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_archive_issuer ON jobs_archive(issuer)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_archive_type ON jobs_archive(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_archive_status ON jobs_archive(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_archive_created ON jobs_archive(created_at)");

  return db;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Insert a new job into the queue with status `in_queue`. Returns the job ID.
 */
export function enqueue(
  db: DatabaseSync,
  type: JobType,
  payload: string,
  issuer: string,
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, type, status, payload, issuer) VALUES (?, ?, 'in_queue', ?, ?)`,
  ).run(id, type, payload, issuer);
  return id;
}

/**
 * Atomically dequeue the oldest `in_queue` job: SELECT + UPDATE to `evaluating`.
 * Returns the job row (already in `evaluating` status), or null if queue is empty.
 */
export function dequeue(db: DatabaseSync): RouterJob | null {
  const row = db.prepare(
    `SELECT id FROM jobs WHERE status = 'in_queue' ORDER BY created_at ASC LIMIT 1`,
  ).get() as { id: string } | undefined;

  if (!row) return null;

  db.prepare(
    `UPDATE jobs SET status = 'evaluating', updated_at = datetime('now') WHERE id = ?`,
  ).run(row.id);

  return getJob(db, row.id);
}

/**
 * Generic UPDATE for status transitions, weight, tier, result, error, timestamps, etc.
 * Automatically bumps `updated_at`.
 */
export function updateJob(
  db: DatabaseSync,
  id: string,
  fields: Partial<
    Pick<
      RouterJob,
      | "status"
      | "weight"
      | "tier"
      | "result"
      | "error"
      | "started_at"
      | "finished_at"
      | "delivered_at"
      | "retry_count"
      | "worker_id"
      | "last_checkpoint"
      | "checkpoint_data"
    >
  >,
): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    setClauses.push(`${key} = ?`);
    values.push(value ?? null);
  }

  if (setClauses.length === 0) return;

  // Always bump updated_at
  setClauses.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(
    ...(values as import("node:sqlite").SQLInputValue[]),
  );
}

/**
 * Get a single job by ID. Returns null if not found.
 */
export function getJob(db: DatabaseSync, id: string): RouterJob | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | RouterJob
    | undefined;
  return row ?? null;
}

/**
 * Archive a job: INSERT INTO jobs_archive + DELETE FROM jobs inside a single transaction.
 */
export function archiveJob(db: DatabaseSync, id: string): void {
  const job = getJob(db, id);
  if (!job) return;

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO jobs_archive
        (id, type, status, weight, tier, issuer, payload, result, error,
         retry_count, created_at, updated_at, started_at, finished_at,
         delivered_at, worker_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.type,
      job.status,
      job.weight,
      job.tier,
      job.issuer,
      job.payload,
      job.result,
      job.error,
      job.retry_count,
      job.created_at,
      job.updated_at,
      job.started_at,
      job.finished_at,
      job.delivered_at,
      job.worker_id,
    );

    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Find `in_execution` jobs whose last checkpoint (or started_at if no checkpoint)
 * is older than `thresholdSeconds`.
 */
export function getHungJobs(
  db: DatabaseSync,
  thresholdSeconds = 90,
): RouterJob[] {
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'in_execution'
         AND (
           (last_checkpoint IS NOT NULL
            AND last_checkpoint < datetime('now', ? || ' seconds'))
           OR
           (last_checkpoint IS NULL
            AND started_at IS NOT NULL
            AND started_at < datetime('now', ? || ' seconds'))
         )`,
    )
    .all(
      `-${thresholdSeconds}`,
      `-${thresholdSeconds}`,
    ) as unknown as RouterJob[];
}

/**
 * Crash recovery: find jobs stuck in `evaluating` or `in_execution`.
 */
export function getStuckJobs(db: DatabaseSync): RouterJob[] {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE status IN ('evaluating', 'in_execution')`,
    )
    .all() as unknown as RouterJob[];
}

/**
 * Query the archive table with optional filters.
 */
export interface ArchiveFilters {
  issuer?: string;
  status?: JobStatus;
  type?: JobType;
  created_after?: string;
  created_before?: string;
}

export function queryArchive(
  db: DatabaseSync,
  filters?: ArchiveFilters,
): ArchivedJob[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.issuer) {
    conditions.push("issuer = ?");
    params.push(filters.issuer);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }
  if (filters?.created_after) {
    conditions.push("created_at >= ?");
    params.push(filters.created_after);
  }
  if (filters?.created_before) {
    conditions.push("created_at <= ?");
    params.push(filters.created_before);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return db
    .prepare(`SELECT * FROM jobs_archive ${where} ORDER BY created_at DESC`)
    .all(...(params as import("node:sqlite").SQLInputValue[])) as unknown as ArchivedJob[];
}
