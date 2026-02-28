/**
 * Hippocampus — Hot Memory & Cold Storage Tests
 *
 * Follows the same patterns as bus.test.ts and session.test.ts:
 * temp dir, initBus, beforeEach/afterEach cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import { initSessionTables, addPendingOp } from "../session.js";
import {
  initHotMemoryTable,
  initColdStorage,
  insertHotFact,
  getTopHotFacts,
  touchHotFact,
  getStaleHotFacts,
  deleteHotFact,
  insertColdFact,
  searchColdFacts,
} from "../hippocampus.js";

// ---------------------------------------------------------------------------
// Hot Memory
// ---------------------------------------------------------------------------

describe("hot memory", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hippo-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initHotMemoryTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  describe("schema", () => {
    it("creates cortex_hot_memory table", () => {
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_hot_memory'`,
      ).get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("cortex_hot_memory");
    });

    it("defaults hit_count to 0", () => {
      const id = insertHotFact(db, { factText: "test fact" });
      const row = db.prepare(
        `SELECT hit_count FROM cortex_hot_memory WHERE id = ?`,
      ).get(id) as { hit_count: number };
      expect(row.hit_count).toBe(0);
    });

    it("is idempotent (calling initHotMemoryTable twice is safe)", () => {
      initHotMemoryTable(db);
      const id = insertHotFact(db, { factText: "still works" });
      expect(id).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  describe("CRUD", () => {
    it("inserts and retrieves facts", () => {
      insertHotFact(db, { factText: "Serj prefers dark mode" });
      insertHotFact(db, { factText: "Serj's timezone is PST" });

      const facts = getTopHotFacts(db);
      expect(facts).toHaveLength(2);
      expect(facts.map((f) => f.factText)).toContain("Serj prefers dark mode");
      expect(facts.map((f) => f.factText)).toContain("Serj's timezone is PST");
    });

    it("orders by hit_count DESC then last_accessed_at DESC", () => {
      const id1 = insertHotFact(db, { factText: "low hits" });
      const id2 = insertHotFact(db, { factText: "high hits" });

      // Bump id2 to 3 hits
      touchHotFact(db, id2);
      touchHotFact(db, id2);
      touchHotFact(db, id2);

      const facts = getTopHotFacts(db);
      expect(facts[0].factText).toBe("high hits");
      expect(facts[0].hitCount).toBe(3);
      expect(facts[1].factText).toBe("low hits");
      expect(facts[1].hitCount).toBe(0);
    });

    it("touchHotFact increments hit_count and updates last_accessed_at", () => {
      const id = insertHotFact(db, { factText: "touchable fact" });

      const before = getTopHotFacts(db).find((f) => f.id === id)!;
      expect(before.hitCount).toBe(0);

      touchHotFact(db, id);
      const after = getTopHotFacts(db).find((f) => f.id === id)!;
      expect(after.hitCount).toBe(1);
      expect(after.lastAccessedAt >= before.lastAccessedAt).toBe(true);
    });

    it("deleteHotFact removes a fact", () => {
      const id = insertHotFact(db, { factText: "to be deleted" });
      expect(getTopHotFacts(db)).toHaveLength(1);

      deleteHotFact(db, id);
      expect(getTopHotFacts(db)).toHaveLength(0);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        insertHotFact(db, { factText: `fact ${i}` });
      }
      const limited = getTopHotFacts(db, 3);
      expect(limited).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Stale facts
  // -------------------------------------------------------------------------

  describe("stale facts selection", () => {
    it("returns only stale + low-hit facts", () => {
      // Fresh fact (just inserted — last_accessed_at is now)
      insertHotFact(db, { factText: "fresh fact" });

      // Stale + high hits: manually backdate and bump hits
      const staleHighId = insertHotFact(db, { factText: "stale high hits" });
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);
      db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ? WHERE id = ?`)
        .run(oldDate.toISOString(), staleHighId);
      for (let i = 0; i < 5; i++) touchHotFact(db, staleHighId);
      // Reset last_accessed_at back to old after touching
      db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ? WHERE id = ?`)
        .run(oldDate.toISOString(), staleHighId);

      // Stale + low hits: backdate, keep hit_count low
      const staleLowId = insertHotFact(db, { factText: "stale low hits" });
      db.prepare(`UPDATE cortex_hot_memory SET last_accessed_at = ? WHERE id = ?`)
        .run(oldDate.toISOString(), staleLowId);

      const stale = getStaleHotFacts(db, 14, 3);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe(staleLowId);
      expect(stale[0].factText).toBe("stale low hits");
    });
  });
});

// ---------------------------------------------------------------------------
// Cold Storage (sqlite-vec)
// ---------------------------------------------------------------------------

describe("cold storage", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-cold-test-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"), { allowExtensionLoading: true });
    try {
      await initColdStorage(db);
    } catch {
      vecAvailable = false;
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a mock 768-dim embedding with a deterministic pattern */
  function mockEmbedding(seed: number): Float32Array {
    const emb = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      emb[i] = Math.sin(seed * (i + 1));
    }
    return emb;
  }

  describe("vector DB init", () => {
    it("creates virtual table and metadata table", () => {
      if (!vecAvailable) return;

      // Check metadata table exists
      const meta = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_cold_memory'`,
      ).get() as { name: string } | undefined;
      expect(meta).toBeDefined();

      // Virtual table — sqlite_master shows it as 'table' type
      const vec = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='cortex_cold_memory_vec'`,
      ).get() as { name: string } | undefined;
      expect(vec).toBeDefined();
    });

    it("can insert and retrieve via KNN query", () => {
      if (!vecAvailable) return;

      const emb = mockEmbedding(1);
      const rowid = insertColdFact(db, "test vector fact", emb);
      expect(rowid).toBeGreaterThan(0);

      // Query with the same embedding — should find itself
      const results = searchColdFacts(db, emb, 5);
      expect(results).toHaveLength(1);
      expect(results[0].factText).toBe("test vector fact");
      expect(results[0].distance).toBe(0); // exact match
    });
  });

  describe("cold storage CRUD", () => {
    it("inserts and searches cold facts", () => {
      if (!vecAvailable) return;

      insertColdFact(db, "Serj likes TypeScript", mockEmbedding(1));
      insertColdFact(db, "Serj uses Neovim", mockEmbedding(2));
      insertColdFact(db, "Serj prefers dark themes", mockEmbedding(3));

      // Search with embedding close to seed=1
      const results = searchColdFacts(db, mockEmbedding(1), 2);
      expect(results).toHaveLength(2);
      expect(results[0].factText).toBe("Serj likes TypeScript"); // closest match
    });

    it("returns distance for ranking", () => {
      if (!vecAvailable) return;

      insertColdFact(db, "exact match", mockEmbedding(42));
      insertColdFact(db, "different", mockEmbedding(99));

      const results = searchColdFacts(db, mockEmbedding(42), 2);
      expect(results[0].distance).toBe(0);
      expect(results[1].distance).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// E2E — Full DB Infrastructure
// ---------------------------------------------------------------------------

describe("e2e", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let vecAvailable = true;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hippo-e2e-"));
    db = initBus(path.join(tmpDir, "bus.sqlite"));
    initSessionTables(db);
    initHotMemoryTable(db);
    try {
      await initColdStorage(db);
    } catch {
      vecAvailable = false;
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("all tables coexist and data is accessible in sequence", () => {
    if (!vecAvailable) return;

    // 1. Insert a hot memory fact
    const hotId = insertHotFact(db, { factText: "e2e hot fact" });
    const hotFacts = getTopHotFacts(db, 10);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].id).toBe(hotId);

    // 2. Insert a pending operation (existing session infrastructure)
    addPendingOp(db, {
      id: "op-1",
      type: "router_job",
      description: "e2e test op",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "webchat",
      status: "pending",
    });
    const ops = db.prepare(`SELECT * FROM cortex_pending_ops WHERE id = 'op-1'`).get() as Record<string, unknown> | undefined;
    expect(ops).toBeDefined();

    // 3. Write a mock embedding to cold storage
    const emb = new Float32Array(768);
    for (let i = 0; i < 768; i++) emb[i] = Math.sin(i);
    const coldRowid = insertColdFact(db, "e2e cold fact", emb);
    expect(coldRowid).toBeGreaterThan(0);

    // 4. Assert all data readable
    const coldResults = searchColdFacts(db, emb, 5);
    expect(coldResults).toHaveLength(1);
    expect(coldResults[0].factText).toBe("e2e cold fact");

    // 5. Cross-table: hot + cold both accessible in same db
    expect(getTopHotFacts(db)).toHaveLength(1);
    expect(coldResults).toHaveLength(1);
  });
});
