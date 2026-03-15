#!/usr/bin/env npx tsx
/**
 * Hippocampus Memory Backfill — ingest any of 11 source types into the
 * knowledge graph (hippocampus_facts + hippocampus_edges).
 *
 * Usage:
 *   npx tsx scripts/backfill-memory.ts --source curated_memory
 *   npx tsx scripts/backfill-memory.ts --source daily_log --base "C:\Users\Temp User\.openclaw"
 *   npx tsx scripts/backfill-memory.ts --source architecture_doc --dry-run
 *   npx tsx scripts/backfill-memory.ts --help
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join, basename, relative } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { complete } from "../src/llm/simple-complete.js";

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

const SOURCE_TYPES = [
  "curated_memory",
  "daily_log",
  "agent_facts",
  "pipeline_task",
  "correction",
  "main_session",
  "cortex_archive",
  "executor_session",
  "architecture_doc",
  "workspace_session",
  "executor_doc",
] as const;

type SourceType = (typeof SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { source: SourceType; base: string; dryRun: boolean; help: boolean } {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    return { source: "curated_memory", base: "", dryRun: false, help: true };
  }

  const sourceIdx = args.indexOf("--source");
  const source = sourceIdx !== -1 ? args[sourceIdx + 1] : undefined;

  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1] : join(homedir(), ".openclaw");

  const dryRun = args.includes("--dry-run");

  if (!source || !SOURCE_TYPES.includes(source as SourceType)) {
    console.error(
      `Error: --source required. Must be one of:\n  ${SOURCE_TYPES.join(", ")}`,
    );
    process.exit(1);
  }

  return { source: source as SourceType, base, dryRun, help: false };
}

function printHelp(): void {
  console.log(`
Hippocampus Memory Backfill
===========================

Ingest source files into the hippocampus knowledge graph.

Usage:
  npx tsx scripts/backfill-memory.ts --source <type> [--base <path>] [--dry-run]

Options:
  --source <type>   Source type to process (required)
  --base <path>     OpenClaw root path (default: ~/.openclaw)
  --dry-run         Parse and extract but don't write to DB
  --help, -h        Show this help

Source types:
  curated_memory    Curated long-term memory facts (agents/main/memory/long-term/facts-*.md)
  daily_log         Daily workspace logs (workspace/memory/*.md)
  agent_facts       All agent fact files (agents/*/memory/long-term/facts-*.md)
  pipeline_task     Pipeline task specs (workspace/pipeline/*/SPEC.md)
  correction        Corrections and feedback (learning/corrections.jsonl)
  main_session      Main agent sessions (agents/main/sessions/*.jsonl)
  cortex_archive    Cortex session archives (cortex/session-archive-*.json)
  executor_session  Router executor sessions (agents/router-executor/sessions/*.jsonl)
  architecture_doc  Architecture documents (workspace/docs/*.md)
  workspace_session Workspace sessions (workspace/sessions/*.jsonl)
  executor_doc      Executor workspace docs (workspace-router-executor/**/*.md)

Examples:
  npx tsx scripts/backfill-memory.ts --source curated_memory
  npx tsx scripts/backfill-memory.ts --source daily_log --base "C:\\Users\\Temp User\\.openclaw"
  npx tsx scripts/backfill-memory.ts --source architecture_doc --dry-run
`);
}

// ---------------------------------------------------------------------------
// File discovery per source type
// ---------------------------------------------------------------------------

function discoverFiles(source: SourceType, base: string): string[] {
  switch (source) {
    case "curated_memory":
      return globDir(join(base, "agents", "main", "memory", "long-term"), /^facts-.*\.md$/);

    case "daily_log":
      return globDir(join(base, "workspace", "memory"), /^\d{4}-\d{2}-\d{2}\.md$/);

    case "agent_facts": {
      const agentsDir = join(base, "agents");
      if (!existsSync(agentsDir)) return [];
      const agents = readdirSync(agentsDir).filter((d) =>
        statSync(join(agentsDir, d)).isDirectory(),
      );
      const files: string[] = [];
      for (const agent of agents) {
        files.push(
          ...globDir(join(agentsDir, agent, "memory", "long-term"), /^facts-.*\.md$/),
        );
      }
      return files;
    }

    case "pipeline_task": {
      const pipelineDir = join(base, "workspace", "pipeline");
      if (!existsSync(pipelineDir)) return [];
      const files: string[] = [];
      for (const status of ["Done", "InProgress", "Cooking", "Canceled"]) {
        const statusDir = join(pipelineDir, status);
        if (!existsSync(statusDir)) continue;
        for (const task of safeReaddir(statusDir)) {
          const specPath = join(statusDir, task, "SPEC.md");
          if (existsSync(specPath)) files.push(specPath);
        }
      }
      return files;
    }

    case "correction":
      // Corrections live in learning/corrections.jsonl
      const correctionsPath = join(base, "learning", "corrections.jsonl");
      return existsSync(correctionsPath) ? [correctionsPath] : [];

    case "main_session":
      return globDir(join(base, "agents", "main", "sessions"), /\.jsonl$/);

    case "cortex_archive":
      return globDir(join(base, "cortex"), /^session-archive-.*\.json$/);

    case "executor_session":
      return globDir(join(base, "agents", "router-executor", "sessions"), /\.jsonl$/);

    case "architecture_doc":
      return globDir(join(base, "workspace", "docs"), /\.md$/);

    case "workspace_session":
      return globDir(join(base, "workspace", "sessions"), /\.jsonl$/);

    case "executor_doc": {
      const execWs = join(base, "workspace-router-executor");
      if (!existsSync(execWs)) return [];
      return walkDir(execWs, /\.md$/);
    }

    default:
      return [];
  }
}

function globDir(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

function walkDir(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkDir(full, pattern));
    } else if (st.isFile() && pattern.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Content reading & chunking
// ---------------------------------------------------------------------------

const MAX_CHUNK_SIZE = 4096;
const SINGLE_CHUNK_THRESHOLD = 8192;

interface Chunk {
  text: string;
  sourceRef: string;
}

function readAndChunk(filePath: string, source: SourceType, base: string): Chunk[] {
  const relPath = relative(base, filePath);
  const sourceRef = `backfill://${source}/${relPath.replace(/\\/g, "/")}`;

  if (filePath.endsWith(".jsonl")) {
    return readJsonlChunks(filePath, sourceRef, source);
  }

  if (filePath.endsWith(".json")) {
    return readJsonChunks(filePath, sourceRef);
  }

  // Markdown / text files
  return readMarkdownChunks(filePath, sourceRef);
}

function readMarkdownChunks(filePath: string, sourceRef: string): Chunk[] {
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  if (content.length <= SINGLE_CHUNK_THRESHOLD) {
    return [{ text: content, sourceRef }];
  }

  // Split into ~4KB sections at paragraph boundaries
  const chunks: Chunk[] = [];
  const lines = content.split("\n");
  let current = "";
  let chunkIdx = 0;

  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
      chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
      chunkIdx++;
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
  }

  return chunks;
}

function readJsonlChunks(
  filePath: string,
  sourceRef: string,
  source: SourceType,
): Chunk[] {
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      // Correction source: learning/corrections.jsonl format
      // { feedbackType, userPrompt, targetMessage: { role, content: [{type,text}] } }
      if (source === "correction") {
        if (!obj.userPrompt && !obj.targetMessage) continue;
        const parts: string[] = [];
        if (obj.userPrompt) parts.push(`user: ${obj.userPrompt}`);
        if (obj.targetMessage?.content && Array.isArray(obj.targetMessage.content)) {
          const assistantText = obj.targetMessage.content
            .filter((b: any) => b.type === "text" && b.text)
            .map((b: any) => b.text)
            .join("\n");
          if (assistantText) parts.push(`assistant: ${assistantText}`);
        }
        if (parts.length > 0) {
          messages.push(parts.join("\n"));
        }
        continue;
      }

      // Session JSONL format: { type:"message", message: { role, content: [{type,text}] } }
      if (obj.type !== "message") continue;
      const msg = obj.message;
      if (!msg || !msg.role || !Array.isArray(msg.content)) continue;

      // Skip tool round-trip messages
      if (msg.role === "toolResult") continue;

      // Extract text blocks, skip tool_use and tool_result content blocks
      const textParts = msg.content
        .filter((b: any) => b.type === "text" && b.text)
        .map((b: any) => b.text);
      if (textParts.length === 0) continue;

      const text = textParts.join("\n");
      messages.push(`${msg.role}: ${text}`);
    } catch {
      // Skip unparseable lines
    }
  }

  if (messages.length === 0) return [];

  // Group messages into ~4KB chunks
  const chunks: Chunk[] = [];
  let current = "";
  let chunkIdx = 0;

  for (const msg of messages) {
    if (current.length + msg.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
      chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
      chunkIdx++;
      current = "";
    }
    current += msg + "\n";
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
  }

  return chunks;
}

function readJsonChunks(filePath: string, sourceRef: string): Chunk[] {
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  try {
    const data = JSON.parse(content);

    // Cortex archive: array of session records
    if (Array.isArray(data)) {
      const messages: string[] = [];
      for (const record of data) {
        const role = record.role ?? "unknown";
        const sender = record.sender_id ?? record.senderId ?? role;
        const text = record.content ?? "";
        if (!text || typeof text !== "string") continue;
        messages.push(`${sender} (${role}): ${text}`);
      }

      if (messages.length === 0) return [];

      // Group into ~4KB chunks
      const chunks: Chunk[] = [];
      let current = "";
      let chunkIdx = 0;

      for (const msg of messages) {
        if (current.length + msg.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
          chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
          chunkIdx++;
          current = "";
        }
        current += msg + "\n";
      }
      if (current.trim()) {
        chunks.push({ text: current.trim(), sourceRef: `${sourceRef}#chunk${chunkIdx}` });
      }
      return chunks;
    }

    // Single object — stringify relevant fields
    const text = JSON.stringify(data, null, 2);
    if (text.length <= SINGLE_CHUNK_THRESHOLD) {
      return [{ text, sourceRef }];
    }

    // Split large JSON
    return [{ text: text.slice(0, MAX_CHUNK_SIZE), sourceRef: `${sourceRef}#chunk0` }];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Embedding (Ollama nomic-embed-text)
// ---------------------------------------------------------------------------

async function embedFn(text: string): Promise<Float32Array> {
  const resp = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return new Float32Array(data.embedding);
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

interface ExtractedFact {
  id: string;
  text: string;
  type: "fact" | "decision" | "outcome" | "correction";
  confidence: "high" | "medium" | "low";
}

interface ExtractedEdge {
  from: string;
  to: string;
  type: string;
}

interface ExtractionResult {
  facts: ExtractedFact[];
  edges: ExtractedEdge[];
}

const EXTRACTION_PROMPT = `Extract facts and relationships from this text. Return JSON:
{
  "facts": [
    { "id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low" }
  ],
  "edges": [
    { "from": "f1", "to": "f2", "type": "because|informed_by|resulted_in|contradicts|updated_by|related_to|sourced_from|part_of" }
  ]
}

Focus on: decisions made, preferences stated, lessons learned, architecture choices,
relationships between concepts, corrections of earlier beliefs.
Skip: routine tool outputs, code blocks, timestamps without context.
If no facts found, return {"facts": [], "edges": []}.

Text:
`;

async function extractFacts(text: string): Promise<ExtractionResult> {
  const empty: ExtractionResult = { facts: [], edges: [] };
  const prompt = EXTRACTION_PROMPT + text;

  const response = await complete(prompt, {
    model: "claude-haiku-4-5",
    maxTokens: 4096,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return empty;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return empty;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const obj = parsed as Record<string, unknown>;
  const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];

  const facts: ExtractedFact[] = rawFacts
    .filter((f): f is Record<string, unknown> => f != null && typeof f === "object")
    .filter((f) => f.id && f.text && f.type)
    .map((f) => ({
      id: String(f.id),
      text: String(f.text),
      type: f.type as ExtractedFact["type"],
      confidence: (f.confidence as ExtractedFact["confidence"]) ?? "medium",
    }));

  const edges: ExtractedEdge[] = rawEdges
    .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
    .filter((e) => e.from && e.to && e.type)
    .map((e) => ({
      from: String(e.from),
      to: String(e.to),
      type: String(e.type),
    }));

  return { facts, edges };
}

// ---------------------------------------------------------------------------
// Graph helpers (self-contained SQL — same as library-to-graph.ts)
// ---------------------------------------------------------------------------

function ensureGraphTables(db: DatabaseSync): void {
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
      created_at     TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from ON hippocampus_edges(from_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to ON hippocampus_edges(to_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_source_ref ON hippocampus_facts(source_ref)`);
}

function dbInsertFact(
  db: DatabaseSync,
  opts: {
    factText: string;
    factType?: string;
    confidence?: string;
    sourceType?: string;
    sourceRef?: string;
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
  return id;
}

function dbInsertEdge(
  db: DatabaseSync,
  opts: { fromFactId: string; toFactId: string; edgeType: string },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, confidence, created_at)
    VALUES (?, ?, ?, ?, 'medium', ?)
  `).run(id, opts.fromFactId, opts.toFactId, opts.edgeType, now);
  return id;
}

function isSourceRefProcessed(db: DatabaseSync, sourceRef: string): boolean {
  const row = db
    .prepare(`SELECT id FROM hippocampus_facts WHERE source_ref = ? LIMIT 1`)
    .get(sourceRef) as { id: string } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------

async function processChunk(
  db: DatabaseSync,
  chunk: Chunk,
  source: SourceType,
  dryRun: boolean,
  stats: Stats,
): Promise<void> {
  // Idempotency: skip if sourceRef already processed
  if (!dryRun && isSourceRefProcessed(db, chunk.sourceRef)) {
    stats.skipped++;
    return;
  }

  // Extract facts via Haiku
  const extraction = await extractFacts(chunk.text);

  if (extraction.facts.length === 0) {
    stats.emptyExtractions++;
    return;
  }

  if (dryRun) {
    console.log(
      `  [DRY] ${chunk.sourceRef}: ${extraction.facts.length} facts, ${extraction.edges.length} edges`,
    );
    stats.factsExtracted += extraction.facts.length;
    stats.edgesExtracted += extraction.edges.length;
    return;
  }

  // Insert facts with dedup (exact text match)
  const idMap = new Map<string, string>();

  for (const fact of extraction.facts) {
    if (!fact.text?.trim()) continue;

    // Exact-match dedup
    const existing = db
      .prepare(`SELECT id FROM hippocampus_facts WHERE fact_text = ?`)
      .get(fact.text.trim()) as { id: string } | undefined;

    if (existing) {
      idMap.set(fact.id, existing.id);
      stats.duplicates++;
      continue;
    }

    const factId = dbInsertFact(db, {
      factText: fact.text.trim(),
      factType: fact.type,
      confidence: fact.confidence,
      sourceType: source,
      sourceRef: chunk.sourceRef,
    });
    idMap.set(fact.id, factId);
    stats.factsInserted++;
  }

  // Insert edges
  for (const edge of extraction.edges) {
    const fromId = idMap.get(edge.from);
    const toId = idMap.get(edge.to);
    if (fromId && toId && fromId !== toId) {
      dbInsertEdge(db, { fromFactId: fromId, toFactId: toId, edgeType: edge.type });
      stats.edgesInserted++;
    }
  }

  stats.factsExtracted += extraction.facts.length;
  stats.edgesExtracted += extraction.edges.length;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface Stats {
  filesFound: number;
  chunksProcessed: number;
  factsExtracted: number;
  edgesExtracted: number;
  factsInserted: number;
  edgesInserted: number;
  duplicates: number;
  skipped: number;
  emptyExtractions: number;
  errors: number;
}

function newStats(): Stats {
  return {
    filesFound: 0,
    chunksProcessed: 0,
    factsExtracted: 0,
    edgesExtracted: 0,
    factsInserted: 0,
    edgesInserted: 0,
    duplicates: 0,
    skipped: 0,
    emptyExtractions: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { source, base, dryRun, help } = parseArgs();

  if (help) {
    printHelp();
    return;
  }

  console.log(`\nHippocampus Memory Backfill`);
  console.log(`==========================`);
  console.log(`Source:  ${source}`);
  console.log(`Base:    ${base}`);
  console.log(`Dry run: ${dryRun}\n`);

  // Discover files
  const files = discoverFiles(source, base);
  console.log(`Files found: ${files.length}`);

  if (files.length === 0) {
    console.log("No files to process. Exiting.");
    return;
  }

  // Open DB
  const busDbPath = join(base, "cortex", "bus.sqlite");
  let db: DatabaseSync | null = null;

  if (!dryRun) {
    if (!existsSync(busDbPath)) {
      console.error(`Error: Bus DB not found at ${busDbPath}`);
      process.exit(1);
    }
    db = new DatabaseSync(busDbPath, { open: true });
    ensureGraphTables(db);
  }

  const stats = newStats();
  stats.filesFound = files.length;

  for (const filePath of files) {
    const name = basename(filePath);
    console.log(`\nProcessing: ${name}`);

    try {
      const chunks = readAndChunk(filePath, source, base);
      console.log(`  Chunks: ${chunks.length}`);

      for (const chunk of chunks) {
        try {
          await processChunk(db!, chunk, source, dryRun, stats);
          stats.chunksProcessed++;

          // Rate limit: 200ms between Haiku calls
          await delay(200);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ERROR (chunk ${chunk.sourceRef}): ${msg}`);
          stats.errors++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR (file ${name}): ${msg}`);
      stats.errors++;
    }
  }

  if (db) db.close();

  // Summary
  console.log(`\n=== Backfill Summary (${source}) ===`);
  console.log(`Files found:        ${stats.filesFound}`);
  console.log(`Chunks processed:   ${stats.chunksProcessed}`);
  console.log(`Facts extracted:    ${stats.factsExtracted}`);
  console.log(`Facts inserted:     ${stats.factsInserted}`);
  console.log(`Edges extracted:    ${stats.edgesExtracted}`);
  console.log(`Edges inserted:     ${stats.edgesInserted}`);
  console.log(`Duplicates skipped: ${stats.duplicates}`);
  console.log(`Source-ref skipped: ${stats.skipped}`);
  console.log(`Empty extractions:  ${stats.emptyExtractions}`);
  console.log(`Errors:             ${stats.errors}`);

  if (stats.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
