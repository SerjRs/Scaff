# Library Phase 1 — Library DB + Librarian Executor

> **Status:** Not Started  
> **Date:** 2026-03-11  
> **Architecture:** `docs/library-architecture.md` (v2.3)  
> **Goal:** User drops a link → Cortex spawns Librarian → item stored in Library DB with summary, concepts, tags, and embedding.

---

## Overview

Phase 1 establishes the ingestion pipeline. After this phase:
- The Library database exists at `library/library.sqlite`
- A new Cortex tool `library_ingest(url)` spawns a Librarian executor
- The executor reads the URL, produces structured JSON (title, summary, concepts, tags)
- On task completion, the handler parses the JSON, writes to the Library DB, generates an embedding via Ollama, and sends a confirmation to the user
- The LLM calls `library_ingest` whenever the user shares a URL (per architecture §6.1: all links get ingested)

Phase 2 (retrieval) depends on Phase 1. Without items in the DB, there's nothing to retrieve.

---

## Task 1: Create Library Database

**Create file:** `src/library/db.ts`

This module creates and manages the Library SQLite database.

```typescript
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const LIBRARY_DB_PATH = path.join(process.cwd(), "library", "library.sqlite");

/**
 * Open (or create) the Library database.
 * Creates the `library/` directory if it doesn't exist.
 * Creates tables if they don't exist.
 */
export function openLibraryDb(): DatabaseSync {
  const dir = path.dirname(LIBRARY_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(LIBRARY_DB_PATH);

  // Enable WAL mode for concurrent reads
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL,
      summary         TEXT NOT NULL,
      key_concepts    TEXT NOT NULL,
      full_text       TEXT,
      tags            TEXT NOT NULL,
      content_type    TEXT NOT NULL,
      source_quality  TEXT DEFAULT 'medium',
      partial         INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'active',
      error           TEXT,
      version         INTEGER DEFAULT 1,
      ingested_at     TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_ingested ON items(ingested_at);
    CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
  `);

  // sqlite-vec extension must be loaded for vector search
  // This uses the same extension already used by Hippocampus / code-search
  // If sqlite-vec is not available, skip embedding table creation (Phase 2 will need it)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(
        item_id INTEGER PRIMARY KEY,
        embedding float[768]
      );
    `);
  } catch (err) {
    // sqlite-vec not loaded — embeddings will be created in Phase 2
    // Log but don't fail — items can still be stored without embeddings
    console.warn("[library] sqlite-vec not available, skipping item_embeddings table");
  }

  return db;
}

/**
 * Insert a new Library item. Returns the item ID.
 * If the URL already exists, updates the existing entry and increments version.
 */
export function insertItem(db: DatabaseSync, item: {
  url: string;
  title: string;
  summary: string;
  key_concepts: string[];
  full_text?: string;
  tags: string[];
  content_type: string;
  source_quality?: string;
  partial?: boolean;
  status?: string;
  error?: string;
}): number {
  const existing = db.prepare("SELECT id, version FROM items WHERE url = ?").get(item.url) as
    | { id: number; version: number }
    | undefined;

  if (existing) {
    // Update existing entry, increment version
    db.prepare(`
      UPDATE items SET
        title = ?, summary = ?, key_concepts = ?, full_text = ?,
        tags = ?, content_type = ?, source_quality = ?,
        partial = ?, status = ?, error = ?,
        version = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      item.title, item.summary, JSON.stringify(item.key_concepts), item.full_text ?? null,
      JSON.stringify(item.tags), item.content_type, item.source_quality ?? "medium",
      item.partial ? 1 : 0, item.status ?? "active", item.error ?? null,
      existing.version + 1, existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO items (url, title, summary, key_concepts, full_text, tags,
                       content_type, source_quality, partial, status, error, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.url, item.title, item.summary, JSON.stringify(item.key_concepts),
    item.full_text ?? null, JSON.stringify(item.tags), item.content_type,
    item.source_quality ?? "medium", item.partial ? 1 : 0,
    item.status ?? "active", item.error ?? null,
    new Date().toISOString(),
  );

  return Number(result.lastInsertRowid);
}

/**
 * Insert or replace an embedding for a Library item.
 */
export function insertEmbedding(db: DatabaseSync, itemId: number, embedding: Float32Array | number[]): void {
  // Delete existing embedding if any (for re-ingestion)
  db.prepare("DELETE FROM item_embeddings WHERE item_id = ?").run(itemId);
  db.prepare("INSERT INTO item_embeddings (item_id, embedding) VALUES (?, ?)").run(
    itemId,
    new Float32Array(embedding),
  );
}

/**
 * Insert a failed ingestion entry. Tracks the URL so duplicates are caught.
 */
export function insertFailedItem(db: DatabaseSync, url: string, error: string): number {
  const existing = db.prepare("SELECT id FROM items WHERE url = ?").get(url) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare("UPDATE items SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(error, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO items (url, title, summary, key_concepts, tags, content_type,
                       status, error, ingested_at)
    VALUES (?, '', '', '[]', '[]', 'unknown', 'failed', ?, ?)
  `).run(url, error, new Date().toISOString());

  return Number(result.lastInsertRowid);
}
```

**Key decisions:**
- Database is at `library/library.sqlite` — separate from `cortex/bus.sqlite`
- Add-only design: no DELETE operations, updates only for re-ingestion of same URL
- `key_concepts` and `tags` are stored as JSON arrays (not separate tables)
- sqlite-vec is optional at this phase — if not loadable, embeddings table is skipped (Phase 2 makes it required)
- WAL mode for concurrent reads (context assembly reads while ingestion writes)

---

## Task 2: Embedding Generation via Ollama

**Create file:** `src/library/embeddings.ts`

Uses the same Ollama instance already running for code-search and Hippocampus.

```typescript
/**
 * Generate an embedding for text via Ollama nomic-embed-text.
 * Same model and endpoint used by code-search (scaff-tools/code-index.sqlite).
 *
 * Ollama endpoint: http://127.0.0.1:11434
 * Model: nomic-embed-text
 * Dimension: 768
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}
```

**Notes:**
- Ollama is at `127.0.0.1:11434` (see TOOLS.md)
- Model `nomic-embed-text` produces 768-dim vectors
- This is the same infrastructure used by `scaff-tools/code-index.sqlite`
- If Ollama is down, the embedding generation fails but the item is still stored in the DB. Embedding can be retried later.

---

## Task 3: Librarian Executor Prompt

**Create file:** `src/library/librarian-prompt.ts`

```typescript
/**
 * Build the Librarian executor prompt for a given URL and its content.
 *
 * The executor receives this prompt, reads the content, and returns structured JSON.
 * The JSON is parsed by the gateway handler (not the executor) to write to the Library DB.
 */
export function buildLibrarianPrompt(url: string, content: string): string {
  return `You are a Librarian. Your job is to read, understand, and catalog knowledge.

You have been given content from this URL:
${url}

CONTENT:
${content}

Analyze the content and produce a structured knowledge entry as JSON.
Output ONLY valid JSON, no markdown, no explanation:

{
  "title": "...",
  "summary": "200-500 word summary capturing key ideas — what matters, not surface description. Focus on insights, findings, and actionable knowledge.",
  "key_concepts": ["atomic statement 1", "atomic statement 2", ...],
  "tags": ["kebab-case-tag-1", "kebab-case-tag-2", ...],
  "content_type": "article|documentation|tutorial|research|tool|discussion",
  "source_quality": "high|medium|low"
}

Rules:
- summary: 200-500 words. Extract INSIGHTS, not surface description. What could someone apply or learn?
- key_concepts: 3-7 atomic statements. Each should stand alone as a fact or insight.
- tags: 3-10 tags, kebab-case, specific. Not generic ("ai", "tech"). Specific ("erlang-supervisors", "o-ran-fronthaul").
- content_type: pick the most accurate classification.
- source_quality: "high" = deep, well-cited, authoritative. "medium" = useful but surface-level. "low" = opinion, thin, or questionable.

Output ONLY the JSON object.`;
}
```

**Notes:**
- The prompt asks for JSON-only output — no markdown wrapping
- The executor (Pi agent) will use web_fetch or read tools to get the content, then produce JSON
- The content parameter is provided so the executor doesn't need to re-fetch (saves time and handles auth)

---

## Task 4: `library_ingest` Tool

**Modify file:** `src/cortex/tools.ts`

Add `library_ingest` to the CORTEX_TOOLS array. This is an async tool (like `sessions_spawn`) — it dispatches work and returns immediately.

### 4.1 Tool Definition

Add to the tool definitions array:

```typescript
const LIBRARY_INGEST_TOOL = {
  name: "library_ingest",
  description: `Ingest a URL into the Library for long-term domain knowledge. Use this whenever 
the user shares a URL — every link the user shares should be ingested. The Librarian executor 
will read the content, summarize it, extract key concepts and tags, and store it in the Library 
database. You will be notified when ingestion completes. Do NOT poll — the system will wake you 
with the result.`,
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to ingest into the Library",
      },
    },
    required: ["url"],
  },
};
```

### 4.2 Tool Execution

In the async tool handling section of `loop.ts` (where `sessions_spawn` is handled), add a handler for `library_ingest`:

**Modify file:** `src/cortex/loop.ts`

In the section that processes tool calls (around line 380-430, where `sessions_spawn` is handled):

```typescript
if (tc.name === "library_ingest") {
  const url = tc.input?.url as string;
  if (!url) {
    appendStructuredContent(db, msg.envelope.id, "user", "internal",
      [{ type: "tool_result", tool_use_id: tc.id, content: "Error: URL is required." }],
      issuer, assignedShardId);
    continue;
  }

  // 1. Fetch content upfront so executor doesn't need web access
  let content = "";
  let fetchError = "";
  try {
    // Use the same web_fetch logic available to the gateway
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw/1.0)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      content = await response.text();
      // Truncate to ~50K chars to avoid oversized prompts
      if (content.length > 50_000) {
        content = content.slice(0, 50_000) + "\n\n[TRUNCATED — content exceeds 50K characters]";
      }
    } else {
      fetchError = `HTTP ${response.status} ${response.statusText}`;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (fetchError) {
    // Store failed ingestion in Library DB
    const { openLibraryDb, insertFailedItem } = await import("../library/db.js");
    const libraryDb = openLibraryDb();
    try {
      insertFailedItem(libraryDb, url, fetchError);
    } finally {
      libraryDb.close();
    }
    appendStructuredContent(db, msg.envelope.id, "user", "internal",
      [{ type: "tool_result", tool_use_id: tc.id,
         content: `Library ingestion failed for ${url}: ${fetchError}. URL tracked for retry.` }],
      issuer, assignedShardId);
    continue;
  }

  // 2. Build Librarian prompt with pre-fetched content
  const { buildLibrarianPrompt } = await import("../library/librarian-prompt.js");
  const librarianPrompt = buildLibrarianPrompt(url, content);

  // 3. Spawn via Router (reuse existing onSpawn mechanism)
  const taskId = crypto.randomUUID();
  const jobId = callbacks.onSpawn?.({
    task: librarianPrompt,
    replyChannel: msg.envelope.metadata?.replyChannel as string ?? msg.envelope.channel,
    resultPriority: "normal",
    taskId,
    resources: [],
  });

  if (!jobId) {
    appendStructuredContent(db, msg.envelope.id, "user", "internal",
      [{ type: "tool_result", tool_use_id: tc.id, content: "Library ingestion failed: Router not available." }],
      issuer, assignedShardId);
    continue;
  }

  // 4. Store metadata for the handler to know this is a library task
  // Use the same pending ops pattern or a simpler metadata store
  storeLibraryTaskMeta(db, taskId, url);

  // 5. Tool result — tell LLM not to poll
  appendStructuredContent(db, msg.envelope.id, "user", "internal",
    [{ type: "tool_result", tool_use_id: tc.id,
       content: `Library ingestion started for: ${url}. Task ID: ${taskId}. You will be notified automatically when complete — do NOT poll.` }],
    issuer, assignedShardId);
}
```

### 4.3 Library Task Metadata Storage

The gateway-bridge handler needs to know which tasks are Library ingestions so it can parse the JSON result and write to the Library DB instead of passing raw JSON to the LLM.

**Add to `src/library/db.ts`:**

```typescript
/**
 * Store metadata for a pending Library ingestion task.
 * Used by the ops-trigger handler to detect Library tasks.
 */
export function storeLibraryTaskMeta(db: DatabaseSync, taskId: string, url: string): void {
  // Use cortex/bus.sqlite (the db passed in) — not library.sqlite
  // This is a lightweight tracking table for in-flight tasks
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_pending_tasks (
      task_id   TEXT PRIMARY KEY,
      url       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare("INSERT OR REPLACE INTO library_pending_tasks (task_id, url) VALUES (?, ?)").run(taskId, url);
}

/**
 * Check if a task is a Library ingestion. Returns the URL if yes, null if no.
 */
export function getLibraryTaskMeta(db: DatabaseSync, taskId: string): string | null {
  try {
    const row = db.prepare("SELECT url FROM library_pending_tasks WHERE task_id = ?").get(taskId) as
      | { url: string }
      | undefined;
    return row?.url ?? null;
  } catch {
    return null; // Table doesn't exist yet
  }
}

/**
 * Remove a completed Library task from pending.
 */
export function removeLibraryTaskMeta(db: DatabaseSync, taskId: string): void {
  try {
    db.prepare("DELETE FROM library_pending_tasks WHERE task_id = ?").run(taskId);
  } catch {
    // Table doesn't exist — nothing to remove
  }
}
```

---

## Task 5: Ops-Trigger Handler for Library Results

**Modify file:** `src/cortex/gateway-bridge.ts`

In the `onJobDelivered` handler (around line 300-365), add Library task detection before the normal ops-trigger flow.

Find the section where `job.status === "completed"` is handled and add:

```typescript
// Check if this is a Library ingestion task
const { getLibraryTaskMeta, removeLibraryTaskMeta } = await import("../library/db.js");
const libraryUrl = getLibraryTaskMeta(instance.db, jobId);

if (libraryUrl && job.status === "completed") {
  // This is a Library task — parse JSON result, write to Library DB, generate embedding
  let confirmationMessage = "";

  try {
    const result = job.result ?? "";

    // Parse JSON from executor result (may have markdown wrapping)
    let jsonStr = result;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr) as {
      title: string;
      summary: string;
      key_concepts: string[];
      tags: string[];
      content_type: string;
      source_quality: string;
    };

    // Write to Library DB
    const { openLibraryDb, insertItem, insertEmbedding } = await import("../library/db.js");
    const libraryDb = openLibraryDb();
    try {
      const itemId = insertItem(libraryDb, {
        url: libraryUrl,
        title: parsed.title,
        summary: parsed.summary,
        key_concepts: parsed.key_concepts,
        tags: parsed.tags,
        content_type: parsed.content_type,
        source_quality: parsed.source_quality,
      });

      // Generate embedding from summary + key concepts
      try {
        const { generateEmbedding } = await import("../library/embeddings.js");
        const textToEmbed = `${parsed.title}. ${parsed.summary} ${parsed.key_concepts.join(". ")}`;
        const embedding = await generateEmbedding(textToEmbed);
        insertEmbedding(libraryDb, itemId, embedding);
      } catch (embErr) {
        params.log.warn(`[library] Embedding generation failed for item ${itemId}: ${embErr}`);
        // Item is stored without embedding — Phase 2 retrieval will skip it
        // Can be retried later
      }

      const tagStr = parsed.tags.slice(0, 5).join(", ");
      confirmationMessage = `📚 Stored: "${parsed.title}" — tags: [${tagStr}]`;
    } finally {
      libraryDb.close();
    }
  } catch (parseErr) {
    params.log.warn(`[library] Failed to parse Librarian result for ${libraryUrl}: ${parseErr}`);
    // Store as failed ingestion
    try {
      const { openLibraryDb, insertFailedItem } = await import("../library/db.js");
      const libraryDb = openLibraryDb();
      try {
        insertFailedItem(libraryDb, libraryUrl, `Parse error: ${parseErr}`);
      } finally {
        libraryDb.close();
      }
    } catch { /* best-effort */ }
    confirmationMessage = `📚 Library ingestion failed for ${libraryUrl}: could not parse executor result.`;
  }

  // Clean up pending task
  removeLibraryTaskMeta(instance.db, jobId);

  // Override the task result with the confirmation message
  // This is what the LLM and user will see — not the raw JSON
  job.result = confirmationMessage;
}

// For failed Library tasks, store the failure
if (libraryUrl && job.status !== "completed") {
  try {
    const { openLibraryDb, insertFailedItem } = await import("../library/db.js");
    const libraryDb = openLibraryDb();
    try {
      insertFailedItem(libraryDb, libraryUrl, job.error ?? "Unknown error");
    } finally {
      libraryDb.close();
    }
  } catch { /* best-effort */ }
  removeLibraryTaskMeta(instance.db, jobId);
}

// Continue with normal ops-trigger flow (appendTaskResult, enqueue trigger)
// The job.result has been overridden with the confirmation message for Library tasks
```

**Key points:**
- The handler detects Library tasks via `getLibraryTaskMeta` (checks `library_pending_tasks` table)
- Parses the JSON result from the executor (handles possible markdown wrapping)
- Writes to `library/library.sqlite` via the `db.ts` functions
- Generates embedding via Ollama
- Replaces `job.result` with a human-readable confirmation before the normal ops-trigger flow
- The LLM and user see "📚 Stored: 'title' — tags: [x, y, z]" not the raw JSON
- If parsing or embedding fails, stores a failed entry (URL tracked for retry)

---

## Task 6: System Prompt Update

**Modify file:** The Cortex system prompt (wherever CORTEX_SYSTEM_PROMPT or equivalent is defined).

Add to the system prompt:

```
## Library
When the user shares a URL, always call library_ingest(url) to store it in the Library.
Every link the user shares is domain knowledge worth retaining. Do not ask whether to ingest —
just do it. You will receive a confirmation when ingestion completes.
```

This ensures the LLM always calls `library_ingest` when a URL appears, per architecture §6.1 (all links get ingested).

---

## Files Summary

### New Files

| File | Description |
|------|-------------|
| `src/library/db.ts` | Library DB management — open, insert item, insert embedding, pending task tracking |
| `src/library/embeddings.ts` | Ollama embedding generation |
| `src/library/librarian-prompt.ts` | Librarian executor prompt builder |

### Modified Files

| File | Change |
|------|--------|
| `src/cortex/tools.ts` | Add `library_ingest` tool definition to CORTEX_TOOLS |
| `src/cortex/loop.ts` | Add `library_ingest` handler in async tool section |
| `src/cortex/gateway-bridge.ts` | Add Library task detection in ops-trigger handler |
| Cortex system prompt | Add Library section instructing LLM to ingest all URLs |

---

## Testing

### Manual Test 1: Database Creation
```bash
# After build, verify the library DB gets created on first use
node -e "
  const { openLibraryDb } = require('./dist/library/db.js');
  const db = openLibraryDb();
  console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all());
  db.close();
"
```

### Manual Test 2: Item Insertion
```bash
node -e "
  const { openLibraryDb, insertItem } = require('./dist/library/db.js');
  const db = openLibraryDb();
  const id = insertItem(db, {
    url: 'https://example.com/test',
    title: 'Test Article',
    summary: 'A test summary.',
    key_concepts: ['concept 1', 'concept 2'],
    tags: ['test', 'example'],
    content_type: 'article',
  });
  console.log('Inserted item ID:', id);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  console.log('Item:', item);
  db.close();
"
```

### Manual Test 3: Embedding Generation
```bash
# Requires Ollama running with nomic-embed-text
node -e "
  const { generateEmbedding } = require('./dist/library/embeddings.js');
  generateEmbedding('Test embedding for O-RAN rural deployment').then(e => {
    console.log('Embedding dimension:', e.length);
    console.log('First 5 values:', e.slice(0, 5));
  });
"
```

### End-to-End Test: Drop a Link in Chat
1. Send a URL to Cortex on webchat or WhatsApp
2. Verify: Cortex responds "Library ingestion started for: [url]"
3. Wait for executor to complete (~15-30 seconds)
4. Verify: Cortex delivers "📚 Stored: 'title' — tags: [x, y, z]"
5. Verify: `library/library.sqlite` has the item:
```bash
node -e "
  const { openLibraryDb } = require('./dist/library/db.js');
  const db = openLibraryDb();
  const items = db.prepare('SELECT id, title, tags, status FROM items ORDER BY id DESC LIMIT 5').all();
  console.log(items);
  db.close();
"
```

### Failure Test: Dead URL
1. Send an unreachable URL to Cortex
2. Verify: Cortex responds "Library ingestion failed for [url]: [error]. URL tracked for retry."
3. Verify: `library/library.sqlite` has the entry with `status = 'failed'`

---

## Dependencies

- **Ollama** must be running at `127.0.0.1:11434` with `nomic-embed-text` loaded
- **sqlite-vec** extension must be available for the `item_embeddings` virtual table
- **Router** must be running for task execution
- No dependencies on Phase 2 or Phase 3

---

## What This Phase Does NOT Do

- No retrieval (breadcrumbs, library_get, library_search) — that's Phase 2
- No PDF handling — that's Phase 3
- No duplicate detection beyond URL uniqueness — that's Phase 3
- No stats or monitoring — that's Phase 3
- Items are stored but not surfaced in Cortex context until Phase 2
