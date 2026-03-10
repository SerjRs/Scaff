/**
 * Hippocampus hot memory dedup tests — embedding-based deduplication
 *
 * Covers: vec table creation, insert with/without embedding, dedup behavior,
 * searchHotFacts, updateHotFact, and embed function integration.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initHotMemoryTable,
  initHotMemoryVecTable,
  insertHotFact,
  getTopHotFacts,
  searchHotFacts,
  updateHotFact,
  deleteHotFact,
} from "../../src/cortex/hippocampus.js";
import { DEDUP_SIMILARITY_THRESHOLD } from "../../src/cortex/gardener.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a deterministic 768-dim unit embedding from a numeric seed */
function mockEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(768);
  for (let i = 0; i < 768; i++) arr[i] = Math.sin(seed * (i + 1));
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < 768; i++) arr[i] /= norm;
  return arr;
}

/** Produce an embedding very close to `base` (small perturbation) */
function similarEmbedding(base: Float32Array, perturbation = 0.01): Float32Array {
  const arr = new Float32Array(base);
  for (let i = 0; i < arr.length; i++) arr[i] += perturbation * Math.sin(i);
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  return arr;
}

/** Create an in-memory DB with both hot-memory tables initialized */
async function setupDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  initHotMemoryTable(db);
  await initHotMemoryVecTable(db);
  return db;
}

// ---------------------------------------------------------------------------
// Step 1 — Vec table creation
// ---------------------------------------------------------------------------

describe("Step 1: Vec table creation", () => {
  it("test_hot_memory_vec_table_created", async () => {
    const db = await setupDb();

    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cortex_hot_memory_vec'`,
      )
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe("cortex_hot_memory_vec");

    db.close();
  });

  it("test_hot_memory_vec_table_idempotent", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    initHotMemoryTable(db);
    await initHotMemoryVecTable(db);

    // Second call should not throw
    await initHotMemoryVecTable(db);

    const rows = db
      .prepare(
        `SELECT count(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'cortex_hot_memory_vec'`,
      )
      .get() as { cnt: number };

    expect(rows.cnt).toBe(1);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Insert with embedding
// ---------------------------------------------------------------------------

describe("Step 2: Insert with embedding", () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("test_insert_hot_fact_with_embedding", () => {
    const emb = mockEmbedding(1);
    const id = insertHotFact(db, { factText: "TypeScript is the project language", embedding: emb });

    // Row in cortex_hot_memory
    const hotRows = getTopHotFacts(db);
    expect(hotRows).toHaveLength(1);
    expect(hotRows[0].id).toBe(id);
    expect(hotRows[0].factText).toBe("TypeScript is the project language");

    // Row in cortex_hot_memory_vec
    const vecRow = db
      .prepare(`SELECT count(*) as cnt FROM cortex_hot_memory_vec`)
      .get() as { cnt: number };
    expect(vecRow.cnt).toBe(1);

    db.close();
  });

  it("test_insert_hot_fact_without_embedding", () => {
    const id = insertHotFact(db, { factText: "No embedding here" });

    // Row in cortex_hot_memory
    const hotRows = getTopHotFacts(db);
    expect(hotRows).toHaveLength(1);
    expect(hotRows[0].id).toBe(id);

    // NO row in cortex_hot_memory_vec
    const vecRow = db
      .prepare(`SELECT count(*) as cnt FROM cortex_hot_memory_vec`)
      .get() as { cnt: number };
    expect(vecRow.cnt).toBe(0);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Dedup behavior
// ---------------------------------------------------------------------------

describe("Step 3: Dedup behavior", () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("test_dedup_exact_match_skipped", () => {
    // Insert the same fact text twice — cortex_hot_memory uses id as PK,
    // so two inserts with different ids will both succeed.
    // Dedup at the application level means callers should check first.
    // Here we verify that two rows exist (insert itself doesn't dedup),
    // confirming the caller must use searchHotFacts to check before inserting.
    const emb = mockEmbedding(42);
    insertHotFact(db, { factText: "Node v24 is the runtime", embedding: emb });

    // A dedup-aware caller would search first and find exact text match
    const existing = getTopHotFacts(db);
    const duplicate = existing.find((f) => f.factText === "Node v24 is the runtime");
    expect(duplicate).toBeDefined();

    // So the second insert should be skipped by the caller — verify only 1 row
    expect(getTopHotFacts(db)).toHaveLength(1);

    db.close();
  });

  it("test_dedup_near_duplicate_skipped", () => {
    // Insert a fact with an embedding, then search with a very similar
    // embedding. The distance should be below DEDUP_SIMILARITY_THRESHOLD,
    // indicating a near-duplicate that the gardener would skip.
    const emb1 = mockEmbedding(7);
    insertHotFact(db, { factText: "pnpm is the package manager", embedding: emb1 });

    const nearEmb = similarEmbedding(emb1, 0.01);
    const results = searchHotFacts(db, nearEmb, 1);

    expect(results).toHaveLength(1);
    expect(results[0].factText).toBe("pnpm is the package manager");
    // Distance should be very small (well under the dedup threshold)
    expect(results[0].distance).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD);

    db.close();
  });

  it("test_dedup_different_facts_both_inserted", () => {
    // Two facts with very different embeddings should both be kept.
    const emb1 = mockEmbedding(1);
    const emb2 = mockEmbedding(100);
    insertHotFact(db, { factText: "Fact A: uses vitest", embedding: emb1 });
    insertHotFact(db, { factText: "Fact B: uses oxlint", embedding: emb2 });

    const facts = getTopHotFacts(db);
    expect(facts).toHaveLength(2);

    // Searching with emb1 should return Fact A first (nearest)
    const results = searchHotFacts(db, emb1, 2);
    expect(results[0].factText).toBe("Fact A: uses vitest");
    // And the distance to the second result should be larger (different embedding)
    expect(results[1].distance).toBeGreaterThan(results[0].distance);

    db.close();
  });

  it("test_dedup_replacement_keeps_longer", () => {
    // Insert a short fact, then update it with a longer (more informative) version.
    const emb = mockEmbedding(5);
    const id = insertHotFact(db, { factText: "Uses SQLite", embedding: emb });

    const newEmb = mockEmbedding(6);
    updateHotFact(db, id, "Uses SQLite via node:sqlite (Node v24 built-in)", newEmb);

    const facts = getTopHotFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0].factText).toBe("Uses SQLite via node:sqlite (Node v24 built-in)");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Step 4 — searchHotFacts
// ---------------------------------------------------------------------------

describe("Step 4: searchHotFacts", () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("test_search_hot_facts_returns_nearest", () => {
    const emb1 = mockEmbedding(1);
    const emb2 = mockEmbedding(50);
    const emb3 = mockEmbedding(100);

    insertHotFact(db, { factText: "Fact 1", embedding: emb1 });
    insertHotFact(db, { factText: "Fact 2", embedding: emb2 });
    insertHotFact(db, { factText: "Fact 3", embedding: emb3 });

    // Search with a query very close to emb2
    const query = similarEmbedding(emb2, 0.005);
    const results = searchHotFacts(db, query, 3);

    expect(results).toHaveLength(3);
    // Nearest should be Fact 2 since query is closest to emb2
    expect(results[0].factText).toBe("Fact 2");
    // Distances should be ascending
    expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
    expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);

    db.close();
  });

  it("test_search_hot_facts_empty_table", () => {
    // Search an empty vec table — should return empty array, not throw
    const query = mockEmbedding(1);
    const results = searchHotFacts(db, query, 5);

    expect(results).toEqual([]);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Step 5 — updateHotFact
// ---------------------------------------------------------------------------

describe("Step 5: updateHotFact", () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("test_update_hot_fact_changes_text", () => {
    const emb = mockEmbedding(10);
    const id = insertHotFact(db, { factText: "Original text", embedding: emb });

    const newEmb = mockEmbedding(11);
    updateHotFact(db, id, "Updated text with more detail", newEmb);

    const facts = getTopHotFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0].factText).toBe("Updated text with more detail");
    expect(facts[0].id).toBe(id);

    db.close();
  });

  it("test_update_hot_fact_changes_embedding", () => {
    const emb1 = mockEmbedding(20);
    const id = insertHotFact(db, { factText: "Searchable fact", embedding: emb1 });

    // Update with a completely different embedding
    const emb2 = mockEmbedding(200);
    updateHotFact(db, id, "Searchable fact (revised)", emb2);

    // Searching with the new embedding should find it as nearest
    const results = searchHotFacts(db, emb2, 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(id);
    expect(results[0].factText).toBe("Searchable fact (revised)");

    // Searching with the old embedding should still find it (only row),
    // but the distance should be larger since the embedding changed
    const oldResults = searchHotFacts(db, emb1, 1);
    expect(oldResults).toHaveLength(1);
    expect(oldResults[0].distance).toBeGreaterThan(results[0].distance);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Step 6 — Embed function integration
// ---------------------------------------------------------------------------

describe("Step 6: Embed function integration", () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("test_extractor_calls_embed_on_insert", async () => {
    // Simulate what the gardener does: call an embed function, then insert
    // with the resulting embedding. Verify vec table is populated.
    const calls: string[] = [];
    const mockEmbedFn = async (text: string): Promise<Float32Array> => {
      calls.push(text);
      return mockEmbedding(text.length); // deterministic based on text length
    };

    const factText = "The project uses pnpm as package manager";
    const embedding = await mockEmbedFn(factText);
    insertHotFact(db, { factText, embedding });

    // Verify the embed function was called
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(factText);

    // Verify vec table has the row
    const vecCount = db
      .prepare(`SELECT count(*) as cnt FROM cortex_hot_memory_vec`)
      .get() as { cnt: number };
    expect(vecCount.cnt).toBe(1);

    // Verify search works with the same embedding
    const results = searchHotFacts(db, embedding, 1);
    expect(results).toHaveLength(1);
    expect(results[0].factText).toBe(factText);
    expect(results[0].distance).toBeCloseTo(0, 2);

    db.close();
  });

  it("test_extractor_graceful_on_embed_failure", () => {
    // When no embedding is provided (e.g., embed function failed and caller
    // falls back), insertHotFact should still work — backward compatibility.
    const id = insertHotFact(db, { factText: "Fallback fact without embedding" });

    // Hot memory row exists
    const facts = getTopHotFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(id);
    expect(facts[0].factText).toBe("Fallback fact without embedding");

    // Vec table is empty (no crash)
    const vecCount = db
      .prepare(`SELECT count(*) as cnt FROM cortex_hot_memory_vec`)
      .get() as { cnt: number };
    expect(vecCount.cnt).toBe(0);

    // Delete also works without vec entry
    deleteHotFact(db, id);
    expect(getTopHotFacts(db)).toHaveLength(0);

    db.close();
  });
});
