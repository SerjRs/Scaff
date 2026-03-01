import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  archiveJob,
  dequeue,
  enqueue,
  getHungJobs,
  getJob,
  getStuckJobs,
  initRouterDb,
  queryArchive,
  updateJob,
} from "./queue.js";
import type { ArchivedJob, RouterJob } from "./types.js";

// ---------------------------------------------------------------------------
// Task 1 — Schema tests (unchanged)
// ---------------------------------------------------------------------------

describe("router queue schema", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-router-test-"));
    dbPath = path.join(tmpDir, "queue.sqlite");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes without error", () => {
    const db = initRouterDb(dbPath);
    expect(db).toBeDefined();
    db.close();
  });

  it("creates both jobs and jobs_archive tables", () => {
    const db = initRouterDb(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'jobs_archive') ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual(["jobs", "jobs_archive"]);
    db.close();
  });

  it("has WAL journal mode enabled", () => {
    const db = initRouterDb(dbPath);
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    db.close();
  });

  it("jobs table has all expected columns", () => {
    const db = initRouterDb(dbPath);
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    const expected = [
      "id",
      "type",
      "status",
      "weight",
      "tier",
      "issuer",
      "payload",
      "result",
      "error",
      "created_at",
      "updated_at",
      "started_at",
      "finished_at",
      "delivered_at",
      "retry_count",
      "worker_id",
      "last_checkpoint",
      "checkpoint_data",
    ];

    for (const col of expected) {
      expect(columnNames).toContain(col);
    }
    db.close();
  });

  it("jobs_archive table has all expected columns including archived_at", () => {
    const db = initRouterDb(dbPath);
    const columns = db.prepare("PRAGMA table_info(jobs_archive)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    const expected = [
      "id",
      "type",
      "status",
      "weight",
      "tier",
      "issuer",
      "payload",
      "result",
      "error",
      "retry_count",
      "created_at",
      "updated_at",
      "started_at",
      "finished_at",
      "delivered_at",
      "archived_at",
      "worker_id",
    ];

    for (const col of expected) {
      expect(columnNames).toContain(col);
    }
    db.close();
  });

  it("is idempotent — calling initRouterDb twice on the same path succeeds", () => {
    const db1 = initRouterDb(dbPath);
    db1.close();
    const db2 = initRouterDb(dbPath);
    expect(db2).toBeDefined();
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Queue operations
// ---------------------------------------------------------------------------

describe("router queue operations", () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-router-ops-"));
  });

  beforeEach(() => {
    // Fresh DB per test to avoid cross-contamination
    const dbPath = path.join(tmpDir, `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = initRouterDb(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // -- enqueue ---------------------------------------------------------------

  describe("enqueue", () => {
    it("returns a unique job ID for each enqueue call", () => {
      const id1 = enqueue(db, "agent_run", '{"msg":"a"}', "session:1", crypto.randomUUID());
      const id2 = enqueue(db, "agent_run", '{"msg":"b"}', "session:1", crypto.randomUUID());
      const id3 = enqueue(db, "agent_run", '{"msg":"c"}', "session:2", crypto.randomUUID());

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id3).toBeTruthy();
      // All unique
      const ids = new Set([id1, id2, id3]);
      expect(ids.size).toBe(3);
    });

    it("inserts jobs with status in_queue", () => {
      const id = enqueue(db, "agent_run", '{"msg":"hello"}', "session:x", crypto.randomUUID());
      const job = getJob(db, id);
      expect(job).not.toBeNull();
      expect(job!.status).toBe("in_queue");
      expect(job!.type).toBe("agent_run");
      expect(job!.issuer).toBe("session:x");
      expect(job!.payload).toBe('{"msg":"hello"}');
    });

    it("sets created_at and updated_at automatically", () => {
      const id = enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      const job = getJob(db, id)!;
      expect(job.created_at).toBeTruthy();
      expect(job.updated_at).toBeTruthy();
    });
  });

  // -- dequeue ---------------------------------------------------------------

  describe("dequeue", () => {
    it("returns null on empty queue", () => {
      const result = dequeue(db);
      expect(result).toBeNull();
    });

    it("returns the oldest job first (FIFO)", () => {
      // Insert with slight created_at offsets to guarantee ordering
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('aaa', 'agent_run', 'in_queue', '{}', 's', datetime('now', '-3 seconds'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('bbb', 'agent_run', 'in_queue', '{}', 's', datetime('now', '-2 seconds'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('ccc', 'agent_run', 'in_queue', '{}', 's', datetime('now', '-1 seconds'), datetime('now'))`,
      ).run();

      const first = dequeue(db);
      expect(first).not.toBeNull();
      expect(first!.id).toBe("aaa");

      const second = dequeue(db);
      expect(second!.id).toBe("bbb");

      const third = dequeue(db);
      expect(third!.id).toBe("ccc");
    });

    it("sets status to evaluating", () => {
      enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      const job = dequeue(db);
      expect(job).not.toBeNull();
      expect(job!.status).toBe("evaluating");
    });

    it("does not dequeue non-in_queue jobs", () => {
      const id = enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      updateJob(db, id, { status: "in_execution" });

      const result = dequeue(db);
      expect(result).toBeNull();
    });
  });

  // -- updateJob -------------------------------------------------------------

  describe("updateJob", () => {
    it("changes status and sets updated_at", () => {
      const id = enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      const before = getJob(db, id)!;

      updateJob(db, id, { status: "pending", weight: 5, tier: "sonnet" });
      const after = getJob(db, id)!;

      expect(after.status).toBe("pending");
      expect(after.weight).toBe(5);
      expect(after.tier).toBe("sonnet");
      // updated_at should be >= before (both are datetime('now') but the update bumps it)
      expect(after.updated_at).toBeTruthy();
    });

    it("can set error and result", () => {
      const id = enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      updateJob(db, id, { status: "completed", result: '{"answer":42}' });
      const job = getJob(db, id)!;
      expect(job.result).toBe('{"answer":42}');
    });

    it("does nothing when fields is empty", () => {
      const id = enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      const before = getJob(db, id)!;
      updateJob(db, id, {});
      const after = getJob(db, id)!;
      expect(after.updated_at).toBe(before.updated_at);
    });
  });

  // -- getJob ----------------------------------------------------------------

  describe("getJob", () => {
    it("returns the correct job by ID", () => {
      const id = enqueue(db, "agent_run", '{"x":1}', "session:abc", crypto.randomUUID());
      const job = getJob(db, id);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(id);
      expect(job!.payload).toBe('{"x":1}');
      expect(job!.issuer).toBe("session:abc");
    });

    it("returns null for unknown ID", () => {
      const job = getJob(db, "nonexistent-id-12345");
      expect(job).toBeNull();
    });
  });

  // -- archiveJob ------------------------------------------------------------

  describe("archiveJob", () => {
    it("moves job from jobs to jobs_archive", () => {
      const id = enqueue(db, "agent_run", '{"task":"test"}', "session:a", crypto.randomUUID());
      updateJob(db, id, { status: "completed", result: '"done"' });

      archiveJob(db, id);

      // Should be gone from jobs
      expect(getJob(db, id)).toBeNull();

      // Should exist in archive
      const archived = db
        .prepare("SELECT * FROM jobs_archive WHERE id = ?")
        .get(id) as ArchivedJob | undefined;
      expect(archived).toBeDefined();
      expect(archived!.id).toBe(id);
    });

    it("preserves all data and adds archived_at", () => {
      const id = enqueue(db, "agent_run", '{"data":"preserve"}', "session:b", crypto.randomUUID());
      updateJob(db, id, {
        status: "completed",
        weight: 7,
        tier: "sonnet",
        result: '{"out":"ok"}',
        worker_id: "worker-1",
      });

      const jobBeforeArchive = getJob(db, id)!;
      archiveJob(db, id);

      const archived = db
        .prepare("SELECT * FROM jobs_archive WHERE id = ?")
        .get(id) as ArchivedJob;

      expect(archived.type).toBe(jobBeforeArchive.type);
      expect(archived.status).toBe(jobBeforeArchive.status);
      expect(archived.weight).toBe(jobBeforeArchive.weight);
      expect(archived.tier).toBe(jobBeforeArchive.tier);
      expect(archived.issuer).toBe(jobBeforeArchive.issuer);
      expect(archived.payload).toBe(jobBeforeArchive.payload);
      expect(archived.result).toBe(jobBeforeArchive.result);
      expect(archived.worker_id).toBe(jobBeforeArchive.worker_id);
      expect(archived.created_at).toBe(jobBeforeArchive.created_at);
      expect(archived.archived_at).toBeTruthy();
    });

    it("is a no-op for nonexistent job ID", () => {
      // Should not throw
      archiveJob(db, "does-not-exist");
    });
  });

  // -- getHungJobs -----------------------------------------------------------

  describe("getHungJobs", () => {
    it("finds jobs with stale last_checkpoint", () => {
      // Insert a job in_execution with a very old checkpoint
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at)
         VALUES ('hung1', 'agent_run', 'in_execution', '{}', 's',
                 datetime('now', '-300 seconds'),
                 datetime('now', '-200 seconds'),
                 datetime('now', '-300 seconds'),
                 datetime('now'))`,
      ).run();

      const hung = getHungJobs(db, 90);
      expect(hung.length).toBe(1);
      expect(hung[0].id).toBe("hung1");
    });

    it("finds jobs with NULL last_checkpoint and stale started_at", () => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, started_at, created_at, updated_at)
         VALUES ('hung2', 'agent_run', 'in_execution', '{}', 's',
                 datetime('now', '-200 seconds'),
                 datetime('now', '-200 seconds'),
                 datetime('now'))`,
      ).run();

      const hung = getHungJobs(db, 90);
      expect(hung.length).toBe(1);
      expect(hung[0].id).toBe("hung2");
    });

    it("ignores jobs with recent checkpoints", () => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at)
         VALUES ('fresh1', 'agent_run', 'in_execution', '{}', 's',
                 datetime('now', '-60 seconds'),
                 datetime('now', '-10 seconds'),
                 datetime('now', '-60 seconds'),
                 datetime('now'))`,
      ).run();

      const hung = getHungJobs(db, 90);
      expect(hung.length).toBe(0);
    });

    it("ignores jobs that are not in_execution", () => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at)
         VALUES ('other1', 'agent_run', 'evaluating', '{}', 's',
                 datetime('now', '-300 seconds'),
                 datetime('now', '-200 seconds'),
                 datetime('now', '-300 seconds'),
                 datetime('now'))`,
      ).run();

      const hung = getHungJobs(db, 90);
      expect(hung.length).toBe(0);
    });

    it("respects custom threshold", () => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, started_at, last_checkpoint, created_at, updated_at)
         VALUES ('thresh1', 'agent_run', 'in_execution', '{}', 's',
                 datetime('now', '-60 seconds'),
                 datetime('now', '-50 seconds'),
                 datetime('now', '-60 seconds'),
                 datetime('now'))`,
      ).run();

      // 90s threshold: not hung
      expect(getHungJobs(db, 90).length).toBe(0);
      // 30s threshold: hung
      expect(getHungJobs(db, 30).length).toBe(1);
    });
  });

  // -- getStuckJobs ----------------------------------------------------------

  describe("getStuckJobs", () => {
    it("finds evaluating and in_execution jobs", () => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('eval1', 'agent_run', 'evaluating', '{}', 's', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('exec1', 'agent_run', 'in_execution', '{}', 's', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('queued1', 'agent_run', 'in_queue', '{}', 's', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at)
         VALUES ('done1', 'agent_run', 'completed', '{}', 's', datetime('now'), datetime('now'))`,
      ).run();

      const stuck = getStuckJobs(db);
      const stuckIds = stuck.map((j) => j.id).sort();
      expect(stuckIds).toEqual(["eval1", "exec1"]);
    });

    it("returns empty array when no stuck jobs exist", () => {
      enqueue(db, "agent_run", "{}", "s", crypto.randomUUID());
      const stuck = getStuckJobs(db);
      expect(stuck.length).toBe(0); // in_queue is not stuck
    });
  });

  // -- queryArchive ----------------------------------------------------------

  describe("queryArchive", () => {
    function seedArchive() {
      // Seed 3 archived jobs with different attributes
      const id1 = enqueue(db, "agent_run", '{"a":1}', "session:alpha", crypto.randomUUID());
      updateJob(db, id1, { status: "completed", weight: 3, tier: "haiku" });
      archiveJob(db, id1);

      const id2 = enqueue(db, "agent_run", '{"b":2}', "session:beta", crypto.randomUUID());
      updateJob(db, id2, { status: "failed", weight: 7, tier: "sonnet" });
      archiveJob(db, id2);

      const id3 = enqueue(db, "agent_run", '{"c":3}', "session:alpha", crypto.randomUUID());
      updateJob(db, id3, { status: "completed", weight: 9, tier: "opus" });
      archiveJob(db, id3);

      return [id1, id2, id3];
    }

    it("returns all archived jobs with no filters", () => {
      seedArchive();
      const all = queryArchive(db);
      expect(all.length).toBe(3);
    });

    it("filters by issuer", () => {
      seedArchive();
      const alpha = queryArchive(db, { issuer: "session:alpha" });
      expect(alpha.length).toBe(2);
      for (const job of alpha) {
        expect(job.issuer).toBe("session:alpha");
      }
    });

    it("filters by status", () => {
      seedArchive();
      const failed = queryArchive(db, { status: "failed" });
      expect(failed.length).toBe(1);
      expect(failed[0].status).toBe("failed");
    });

    it("filters by type", () => {
      seedArchive();
      const runs = queryArchive(db, { type: "agent_run" });
      expect(runs.length).toBe(3);
    });

    it("returns empty array when no match", () => {
      seedArchive();
      const none = queryArchive(db, { issuer: "nonexistent" });
      expect(none.length).toBe(0);
    });

    it("all archived jobs have archived_at set", () => {
      seedArchive();
      const all = queryArchive(db);
      for (const job of all) {
        expect(job.archived_at).toBeTruthy();
      }
    });
  });
});
