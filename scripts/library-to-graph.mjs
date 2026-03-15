#!/usr/bin/env node
// Migration script: extract facts+edges from existing Library items
// and insert them into the hippocampus knowledge graph.
// Idempotent — safe to run multiple times.
//
// Usage:
//   node scripts/library-to-graph.mjs
//   node scripts/library-to-graph.mjs --dry-run
//   node scripts/library-to-graph.mjs --limit 3
//   node scripts/library-to-graph.mjs --dry-run --limit 5

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Database paths (same conventions as other scripts)
// ---------------------------------------------------------------------------
const OPENCLAW_ROOT = join(homedir(), ".openclaw");

const libraryDbPath =
  process.env.OPENCLAW_LIBRARY_DB ||
  join(OPENCLAW_ROOT, "library", "library.sqlite");

const busDbPath =
  process.env.OPENCLAW_BUS_DB ||
  join(OPENCLAW_ROOT, "cortex", "bus.sqlite");

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const MODEL = "llama3.2:3b";
const TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 10_000; // cap full_text at ~10KB

async function callLLM(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.response;
}

// ---------------------------------------------------------------------------
// Graph helpers (self-contained, no imports needed)
// ---------------------------------------------------------------------------
function ensureGraphTables(db) {
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
    );
    CREATE INDEX IF NOT EXISTS idx_facts_status ON hippocampus_facts(status);
    CREATE INDEX IF NOT EXISTS idx_facts_hot ON hippocampus_facts(hit_count DESC, last_accessed_at DESC);

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
      FOREIGN KEY (to_fact_id)   REFERENCES hippocampus_facts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON hippocampus_edges(from_fact_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON hippocampus_edges(to_fact_id);
  `);
}

function insertFact(db, opts) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_facts
      (id, fact_text, fact_type, confidence, status, source_type, source_ref, created_at, last_accessed_at, hit_count)
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
  return id;
}

function insertEdge(db, opts) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_edges
      (id, from_fact_id, to_fact_id, edge_type, confidence, created_at)
    VALUES (?, ?, ?, ?, 'medium', ?)
  `).run(id, opts.fromFactId, opts.toFactId, opts.edgeType, now);
  return id;
}

// ---------------------------------------------------------------------------
// Extraction prompt (mirrors 017e Librarian prompt)
// ---------------------------------------------------------------------------
function buildPrompt(articleText) {
  return `From this article, extract facts and relationships between them.

CATEGORIES:
- fact: specific claims, data points, findings
- decision: recommendations, conclusions
- outcome: results, findings
- correction: debunking, errata

RELATIONSHIPS (only when clearly stated):
- because, informed_by, resulted_in, contradicts, updated_by, related_to

RULES:
- ONLY extract what is directly stated. Do NOT infer.
- Each fact must be a standalone statement.
- Assign confidence: high (explicitly stated), medium (clearly implied), low (loosely implied).
- If no facts found, return {"facts": [], "edges": []}

Return ONLY valid JSON:
{"facts": [{"id": "f1", "text": "...", "type": "fact", "confidence": "high"}], "edges": [{"from": "f1", "to": "f2", "type": "because"}]}

Article:
${articleText}`;
}

// ---------------------------------------------------------------------------
// Parse LLM response with fallbacks
// ---------------------------------------------------------------------------
function parseExtraction(raw) {
  const empty = { facts: [], edges: [] };

  // Try direct parse
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.facts)) return parsed;
    return empty;
  } catch {
    // fallback: extract JSON object via regex
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.facts)) return parsed;
    } catch {
      // give up
    }
  }

  return empty;
}

// ---------------------------------------------------------------------------
// Build article text for extraction
// ---------------------------------------------------------------------------
function buildArticleText(item) {
  const concepts = safeParse(item.key_concepts);
  const tags = safeParse(item.tags);

  let text = `Title: ${item.title}
Summary: ${item.summary}
Key Concepts: ${concepts.join(", ")}
Tags: ${tags.join(", ")}`;

  if (item.full_text) {
    const capped =
      item.full_text.length > MAX_TEXT_BYTES
        ? item.full_text.slice(0, MAX_TEXT_BYTES) + "\n[...truncated]"
        : item.full_text;
    text += `\n\n${capped}`;
  }

  return text;
}

function safeParse(jsonStr) {
  try {
    const val = JSON.parse(jsonStr);
    return Array.isArray(val) ? val : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (DRY_RUN) console.log("=== DRY RUN — no writes will be made ===\n");

  // Validate paths
  if (!existsSync(libraryDbPath)) {
    console.error(`Library DB not found: ${libraryDbPath}`);
    process.exit(1);
  }
  if (!existsSync(busDbPath)) {
    console.error(`Bus DB not found: ${busDbPath}`);
    process.exit(1);
  }

  console.log(`Library DB: ${libraryDbPath}`);
  console.log(`Bus DB:     ${busDbPath}`);
  console.log();

  const libraryDb = new DatabaseSync(libraryDbPath, { readOnly: true });
  const busDb = new DatabaseSync(busDbPath);
  busDb.exec("PRAGMA journal_mode = WAL");
  ensureGraphTables(busDb);

  // Fetch active library items
  let items = libraryDb
    .prepare(
      `SELECT id, url, title, summary, key_concepts, tags, content_type, full_text
       FROM items
       WHERE status != 'failed'
       ORDER BY created_at ASC`,
    )
    .all();

  if (items.length === 0) {
    console.log("No active items found in library.");
    return;
  }

  if (LIMIT < items.length) {
    items = items.slice(0, LIMIT);
    console.log(`--limit ${LIMIT}: processing first ${LIMIT} items\n`);
  }

  let totalFacts = 0;
  let totalEdges = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of items) {
    const sourceRef = `library://item/${item.id}`;

    // Idempotency: check if already migrated
    const existing = busDb
      .prepare(
        `SELECT id FROM hippocampus_facts
         WHERE source_ref = ? AND fact_type = 'source'`,
      )
      .get(sourceRef);

    if (existing) {
      console.log(`  Skip (already migrated): ${item.title}`);
      skipped++;
      continue;
    }

    console.log(`Processing: ${item.title}`);

    // Build article text and call LLM
    const articleText = buildArticleText(item);
    const prompt = buildPrompt(articleText);

    let extraction;
    try {
      const raw = await callLLM(prompt);
      extraction = parseExtraction(raw);
    } catch (err) {
      console.error(`  ERROR (LLM): ${err.message}`);
      errors++;
      continue;
    }

    const factCount = extraction.facts.length;
    const edgeCount = (extraction.edges ?? []).length;
    console.log(`  Extracted: ${factCount} facts, ${edgeCount} edges`);

    if (DRY_RUN) {
      for (const f of extraction.facts) {
        console.log(`    [${f.type}/${f.confidence}] ${f.text}`);
      }
      totalFacts += factCount;
      totalEdges += edgeCount;
      continue;
    }

    // Insert source node
    const sourceFactId = insertFact(busDb, {
      factText: `Article: ${item.title}`,
      factType: "source",
      confidence: "high",
      sourceType: "article",
      sourceRef,
    });

    // Insert extracted facts and build id map (f1 -> uuid)
    const idMap = new Map();
    for (const f of extraction.facts) {
      const factId = insertFact(busDb, {
        factText: f.text,
        factType: f.type ?? "fact",
        confidence: f.confidence ?? "medium",
        sourceType: "article",
        sourceRef,
      });
      idMap.set(f.id, factId);

      // Link fact -> source node
      insertEdge(busDb, {
        fromFactId: factId,
        toFactId: sourceFactId,
        edgeType: "sourced_from",
      });
    }

    // Insert extracted edges
    for (const e of extraction.edges ?? []) {
      const fromId = idMap.get(e.from);
      const toId = idMap.get(e.to);
      if (fromId && toId) {
        insertEdge(busDb, {
          fromFactId: fromId,
          toFactId: toId,
          edgeType: e.type ?? "related_to",
        });
      }
    }

    totalFacts += factCount;
    totalEdges += edgeCount;
  }

  libraryDb.close();
  busDb.close();

  console.log("\n=== Migration Summary ===");
  console.log(`Items processed: ${items.length - skipped - errors}`);
  console.log(`Items skipped:   ${skipped}`);
  console.log(`Errors:          ${errors}`);
  console.log(`Facts extracted: ${totalFacts}`);
  console.log(`Edges extracted: ${totalEdges}`);
  if (DRY_RUN) console.log("\n(Dry run — nothing was written to the database)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
