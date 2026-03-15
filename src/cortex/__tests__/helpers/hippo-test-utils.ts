/**
 * Hippocampus E2E Test Utilities
 *
 * TestReporter, dump helpers, mock helpers for the full lifecycle test suite.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// TestReporter
// ---------------------------------------------------------------------------

export interface TestResult {
  id: string;
  name: string;
  category: string;
  passed: boolean;
  expected: string;
  actual: string;
  data?: string;
  error?: string;
  durationMs?: number;
}

export class TestReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();

  record(result: TestResult): void {
    this.results.push(result);
  }

  writeReport(outputPath: string): void {
    const totalMs = Date.now() - this.startTime;
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;

    let md = `# Hippocampus E2E Test Results\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;
    md += `## Summary\n`;
    md += `- Total: ${this.results.length}\n`;
    md += `- Passed: ${passed}\n`;
    md += `- Failed: ${failed}\n`;
    md += `- Duration: ${(totalMs / 1000).toFixed(1)}s\n\n`;

    // Group by category
    const categories = new Map<string, TestResult[]>();
    for (const r of this.results) {
      const cat = categories.get(r.category) ?? [];
      cat.push(r);
      categories.set(r.category, cat);
    }

    for (const [category, tests] of categories) {
      md += `## ${category}\n\n`;
      for (const t of tests) {
        const icon = t.passed ? "\u2705" : "\u274C";
        md += `### ${t.id}. ${t.name} ${icon}\n`;
        md += `**Expected:** ${t.expected}\n`;
        md += `**Result:** ${t.actual}\n`;
        if (t.data) {
          md += `**Data:**\n\`\`\`\n${t.data}\n\`\`\`\n`;
        }
        if (t.error) {
          md += `**Error:**\n\`\`\`\n${t.error}\n\`\`\`\n`;
        }
        md += `\n`;
      }
    }

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, md, "utf-8");
    console.log(`\nTest report written to: ${outputPath}`);
  }
}

// ---------------------------------------------------------------------------
// Dump Helpers (return strings)
// ---------------------------------------------------------------------------

export function dumpFacts(db: DatabaseSync, label: string): string {
  const facts = db
    .prepare(
      `SELECT id, substr(fact_text, 1, 60) as text, fact_type, confidence, status,
              source_type, source_ref, hit_count, cold_vector_id
       FROM hippocampus_facts ORDER BY created_at`,
    )
    .all() as Record<string, unknown>[];
  let out = `${label} \u2014 hippocampus_facts (${facts.length} rows)\n`;
  for (const f of facts) {
    out += `  ${f.text} | type=${f.fact_type} status=${f.status} hits=${f.hit_count}\n`;
  }
  return out;
}

export function dumpEdges(db: DatabaseSync, label: string): string {
  const edges = db
    .prepare(
      `SELECT e.id,
              substr(f1.fact_text, 1, 30) as from_fact,
              substr(f2.fact_text, 1, 30) as to_fact,
              e.edge_type, e.confidence, e.is_stub, e.stub_topic
       FROM hippocampus_edges e
       JOIN hippocampus_facts f1 ON e.from_fact_id = f1.id
       JOIN hippocampus_facts f2 ON e.to_fact_id = f2.id
       ORDER BY e.created_at`,
    )
    .all() as Record<string, unknown>[];
  let out = `${label} \u2014 hippocampus_edges (${edges.length} rows)\n`;
  for (const e of edges) {
    const stub = (e.is_stub as number) ? ` [STUB: ${e.stub_topic}]` : "";
    out += `  ${e.from_fact} \u2192 ${e.to_fact} (${e.edge_type})${stub}\n`;
  }
  return out;
}

export function dumpCold(db: DatabaseSync, label: string): string {
  try {
    const cold = db
      .prepare(
        `SELECT rowid, substr(fact_text, 1, 60) as text, created_at, archived_at
         FROM cortex_cold_memory ORDER BY created_at`,
      )
      .all() as Record<string, unknown>[];
    let out = `${label} \u2014 cortex_cold_memory (${cold.length} rows)\n`;
    for (const c of cold) {
      out += `  [${c.rowid}] ${c.text}\n`;
    }
    return out;
  } catch {
    return `${label} \u2014 cortex_cold_memory (table not available)\n`;
  }
}

export function dumpShards(db: DatabaseSync, label: string): string {
  const shards = db
    .prepare(
      `SELECT id, channel, topic, ended_at, message_count, token_count, extracted_at
       FROM cortex_shards ORDER BY created_at`,
    )
    .all() as Record<string, unknown>[];
  let out = `${label} \u2014 cortex_shards (${shards.length} rows)\n`;
  for (const s of shards) {
    const status = s.ended_at ? "closed" : "active";
    const extracted = s.extracted_at ? " [extracted]" : "";
    out += `  ${(s.id as string).slice(0, 8)} | ${s.channel} | ${s.topic} | ${status}${extracted} | msgs=${s.message_count}\n`;
  }
  return out;
}

export function dumpHotMemory(db: DatabaseSync, label: string): string {
  const facts = db
    .prepare(
      `SELECT id, substr(fact_text, 1, 60) as text, hit_count, last_accessed_at
       FROM cortex_hot_memory ORDER BY hit_count DESC, last_accessed_at DESC`,
    )
    .all() as Record<string, unknown>[];
  let out = `${label} \u2014 cortex_hot_memory (${facts.length} rows)\n`;
  for (const f of facts) {
    out += `  ${f.text} | hits=${f.hit_count}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

/** Deterministic 768-dim mock embedding seeded from a number */
export function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) emb[i] = Math.sin(seed * (i + 1));
  return emb;
}

/** Deterministic mock embed function: hash text to seed, then generate sin-wave vector */
export const mockEmbedFn = async (text: string): Promise<Float32Array> => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
  return mockEmbedding(seed);
};

/**
 * Create a mock LLM that returns a specific extraction result JSON.
 * Useful for fact extractor tests.
 */
export function mockExtractionLLM(result: {
  facts: Array<{ id: string; text: string; type: string; confidence: string }>;
  edges: Array<{ from: string; to: string; type: string }>;
}): (prompt: string) => Promise<string> {
  return async (_prompt: string) => JSON.stringify(result);
}

/** Insert a message into cortex_session directly (avoids needing full CortexEnvelope) */
export function insertTestMessage(
  db: DatabaseSync,
  opts: {
    channel: string;
    senderId: string;
    content: string;
    timestamp: string;
    role?: string;
    issuer?: string;
  },
): number {
  const role = opts.role ?? "user";
  const issuer = opts.issuer ?? "agent:main:cortex";
  db.prepare(
    `INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, issuer)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    opts.channel,
    opts.senderId,
    opts.content,
    opts.timestamp,
    issuer,
  );
  const row = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number | bigint };
  return Number(row.id);
}

/**
 * Try to initialize vec tables. Returns true if successful.
 * Fails silently if sqlite-vec extension is not available.
 */
export async function tryInitVecTables(
  db: DatabaseSync,
  initFns: {
    initGraphVecTable: (db: DatabaseSync) => Promise<void>;
    initColdStorage: (db: DatabaseSync) => Promise<void>;
    initHotMemoryVecTable: (db: DatabaseSync) => Promise<void>;
  },
): Promise<boolean> {
  try {
    await initFns.initGraphVecTable(db);
    await initFns.initColdStorage(db);
    await initFns.initHotMemoryVecTable(db);
    return true;
  } catch {
    return false;
  }
}
