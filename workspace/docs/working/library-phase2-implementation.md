# Library Phase 2 — Retrieval Integration (Breadcrumbs + On-Demand Pull)

> **Status:** Not Started  
> **Date:** 2026-03-11  
> **Architecture:** `docs/library-architecture.md` (v2.3, §3.2, §5, §6.2-6.4)  
> **Depends on:** Phase 1 (Library DB + Librarian Executor must be complete)  
> **Goal:** On every Cortex turn, Library breadcrumbs appear in context. LLM can pull full items via `library_get` or search via `library_search`. Results persist as compressed references in the shard, not full content.

---

## Overview

Phase 2 is the critical phase — it makes Library knowledge available to the LLM. After this phase:

- Every Cortex turn includes breadcrumbs (~500 tokens): titles, tags, and teasers of the top-10 relevant Library items
- The LLM has two sync tools: `library_get(item_id)` for full details, `library_search(query)` for exploration
- Tool results are consumed in the current turn but persisted as compressed references only (~20 tokens each)
- The LLM decides how deep to go — from ignoring breadcrumbs entirely to pulling multiple items for deep analysis

---

## Task 1: Breadcrumb Generation

**Create file:** `src/library/retrieval.ts`

This module handles all Library retrieval queries — breadcrumbs, get, and search.

```typescript
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const LIBRARY_DB_PATH = path.join(process.cwd(), "library", "library.sqlite");

/**
 * Open the Library database in read-only mode.
 * Used by context assembly and sync tools (read path only).
 */
export function openLibraryDbReadonly(): DatabaseSync | null {
  try {
    return new DatabaseSync(LIBRARY_DB_PATH, { readOnly: true });
  } catch {
    return null; // Library doesn't exist yet — no items ingested
  }
}

export interface BreadcrumbItem {
  id: number;
  title: string;
  tags: string;   // JSON array string
  teaser: string;  // first 100 chars of summary
}

/**
 * Get breadcrumbs: top-K items by embedding similarity to the query.
 * Returns titles, tags, and teasers only — lightweight for context injection.
 *
 * @param queryEmbedding - 768-dim embedding of the user's current message
 * @param limit - max items to return (default 10)
 */
export function getBreadcrumbs(
  db: DatabaseSync,
  queryEmbedding: number[] | Float32Array,
  limit: number = 10,
): BreadcrumbItem[] {
  try {
    const rows = db.prepare(`
      SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
      FROM item_embeddings e
      JOIN items i ON i.id = e.item_id
      WHERE i.status = 'active'
      ORDER BY vec_distance_cosine(e.embedding, ?) ASC
      LIMIT ?
    `).all(new Float32Array(queryEmbedding), limit) as BreadcrumbItem[];
    return rows;
  } catch {
    return []; // sqlite-vec not available or no embeddings
  }
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

/**
 * Get full details of a Library item by ID.
 * Used by the library_get sync tool.
 */
export function getItemById(db: DatabaseSync, itemId: number): LibraryItem | null {
  const row = db.prepare(`
    SELECT id, url, title, summary, key_concepts, tags, content_type,
           source_quality, ingested_at
    FROM items
    WHERE id = ? AND status = 'active'
  `).get(itemId) as LibraryItem | undefined;
  return row ?? null;
}

export interface SearchResult {
  id: number;
  title: string;
  tags: string;   // JSON array string
  teaser: string;
}

/**
 * Semantic search across the Library.
 * Used by the library_search sync tool.
 * Returns breadcrumb-format results with teasers.
 */
export function searchItems(
  db: DatabaseSync,
  queryEmbedding: number[] | Float32Array,
  limit: number = 10,
): SearchResult[] {
  try {
    const rows = db.prepare(`
      SELECT i.id, i.title, i.tags, substr(i.summary, 1, 100) as teaser
      FROM item_embeddings e
      JOIN items i ON i.id = e.item_id
      WHERE i.status = 'active'
      ORDER BY vec_distance_cosine(e.embedding, ?) ASC
      LIMIT ?
    `).all(new Float32Array(queryEmbedding), Math.min(limit, 20)) as SearchResult[];
    return rows;
  } catch {
    return [];
  }
}

/**
 * Format breadcrumbs for context injection.
 * Produces the text block that goes into the system prompt.
 */
export function formatBreadcrumbs(items: BreadcrumbItem[]): string {
  if (items.length === 0) return "";

  const lines = items.map((item) => {
    let tags: string[];
    try { tags = JSON.parse(item.tags); } catch { tags = []; }
    return `  [id:${item.id}] "${item.title}" — ${tags.join(", ")}`;
  });

  return `📚 Library (${items.length} relevant items — use library_get(id) for details, library_search(query) to explore):\n${lines.join("\n")}`;
}

/**
 * Format a full Library item for tool response.
 */
export function formatItem(item: LibraryItem): string {
  let concepts: string[];
  let tags: string[];
  try { concepts = JSON.parse(item.key_concepts); } catch { concepts = []; }
  try { tags = JSON.parse(item.tags); } catch { tags = []; }

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

/**
 * Format search results for tool response.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matching items found in the Library.";

  const lines = results.map((r) => {
    let tags: string[];
    try { tags = JSON.parse(r.tags); } catch { tags = []; }
    return `  [id:${r.id}] "${r.title}" — ${tags.join(", ")}\n    ${r.teaser}...`;
  });

  return `📚 Library search results (${results.length} items — use library_get(id) for full details):\n${lines.join("\n")}`;
}

/**
 * Format a compressed reference for shard persistence.
 * This is what gets stored in cortex_session instead of the full tool result.
 */
export function formatCompressedReference(item: LibraryItem): string {
  let tags: string[];
  try { tags = JSON.parse(item.tags); } catch { tags = []; }
  return `📚 Referenced: [id:${item.id}] "${item.title}" — ${tags.slice(0, 4).join(", ")}`;
}

export function formatCompressedSearchRef(query: string, resultCount: number): string {
  return `📚 Searched: "${query}" — ${resultCount} results`;
}
```

---

## Task 2: Context Assembly — Inject Breadcrumbs

**Modify file:** `src/cortex/context.ts`

In the context assembly function (where the system prompt is built), add Library breadcrumbs after Hippocampus hot facts.

Find the section where hot facts are injected into the system prompt. After that section, add:

```typescript
// Library breadcrumbs — top 10 relevant items by embedding similarity
// Only if Library DB exists and has items
try {
  const { openLibraryDbReadonly, getBreadcrumbs, formatBreadcrumbs } = await import("../library/retrieval.js");
  const libraryDb = openLibraryDbReadonly();
  if (libraryDb) {
    try {
      // Get the user's latest message for embedding
      const userMessage = getLatestUserMessage(messages); // extract from the current turn
      if (userMessage) {
        const { generateEmbedding } = await import("../library/embeddings.js");
        const queryEmbedding = await generateEmbedding(userMessage);
        const breadcrumbs = getBreadcrumbs(libraryDb, queryEmbedding, 10);
        if (breadcrumbs.length > 0) {
          const breadcrumbText = formatBreadcrumbs(breadcrumbs);
          // Append to system prompt after hot facts
          systemPromptSections.push(breadcrumbText);
        }
      }
    } finally {
      libraryDb.close();
    }
  }
} catch {
  // Library not available — skip breadcrumbs silently
}
```

**Key implementation notes:**

1. **`getLatestUserMessage()`** — extract the text of the user's current message from the conversation. This is what we embed for similarity search. If the message is very short ("yes", "ok"), breadcrumbs may not be useful — but that's fine, the LLM will ignore them.

2. **Embedding latency** — calling Ollama adds ~50-100ms per turn. This is acceptable. The same model is already used for code_search. If Ollama is down, breadcrumbs are skipped silently.

3. **The Library DB is opened read-only** — no contention with ingestion writes.

4. **Breadcrumbs are appended to the system prompt**, not injected into conversation history. They're ephemeral — recalculated every turn based on the current message.

**IMPORTANT:** The exact integration point depends on how `context.ts` currently builds the system prompt. The implementor should:
1. Find where `getTopHotFacts()` results are injected
2. Add breadcrumbs immediately after that section
3. Ensure the breadcrumb text is inside the system prompt, not a separate message

---

## Task 3: Library Sync Tools

**Modify file:** `src/cortex/tools.ts`

Add two sync tools to CORTEX_TOOLS.

### 3.1 Tool Definitions

```typescript
const LIBRARY_GET_TOOL = {
  name: "library_get",
  description: `Get the full summary, key concepts, and metadata of a Library item by ID. 
Use when you see a relevant item in the Library breadcrumbs and need its full details 
to answer the user's question. The result is used for this turn only — a compressed 
reference is stored in conversation history.`,
  input_schema: {
    type: "object" as const,
    properties: {
      item_id: {
        type: "number",
        description: "Item ID from the Library breadcrumbs (e.g., 7)",
      },
    },
    required: ["item_id"],
  },
};

const LIBRARY_SEARCH_TOOL = {
  name: "library_search",
  description: `Search the Library for items matching a query. Use when you need knowledge 
that the breadcrumbs don't show, or when you want to explore a specific angle that differs 
from the user's original question. Returns titles, tags, and teasers — use library_get(id) 
to read the full item.`,
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      limit: {
        type: "number",
        description: "Max results (default 10, max 20)",
      },
    },
    required: ["query"],
  },
};
```

### 3.2 Tool Execution

Add to the sync tool execution section (where `code_search`, `get_task_status` are handled):

```typescript
if (tc.name === "library_get") {
  const itemId = tc.input?.item_id as number;
  if (!itemId) {
    return { content: "Error: item_id is required." };
  }

  const { openLibraryDbReadonly, getItemById, formatItem, formatCompressedReference } =
    await import("../library/retrieval.js");
  const libraryDb = openLibraryDbReadonly();
  if (!libraryDb) {
    return { content: "Library not available." };
  }

  try {
    const item = getItemById(libraryDb, itemId);
    if (!item) {
      return { content: `Library item [id:${itemId}] not found.` };
    }

    // Full content for the LLM to use this turn
    const fullContent = formatItem(item);

    // Compressed reference for shard persistence
    const compressedRef = formatCompressedReference(item);

    return {
      content: fullContent,
      shardContent: compressedRef,  // see Task 4 for how this is used
    };
  } finally {
    libraryDb.close();
  }
}

if (tc.name === "library_search") {
  const query = tc.input?.query as string;
  const limit = Math.min((tc.input?.limit as number) ?? 10, 20);
  if (!query) {
    return { content: "Error: query is required." };
  }

  const { openLibraryDbReadonly, searchItems, formatSearchResults, formatCompressedSearchRef } =
    await import("../library/retrieval.js");
  const { generateEmbedding } = await import("../library/embeddings.js");
  const libraryDb = openLibraryDbReadonly();
  if (!libraryDb) {
    return { content: "Library not available." };
  }

  try {
    const queryEmbedding = await generateEmbedding(query);
    const results = searchItems(libraryDb, queryEmbedding, limit);
    const fullContent = formatSearchResults(results);
    const compressedRef = formatCompressedSearchRef(query, results.length);

    return {
      content: fullContent,
      shardContent: compressedRef,
    };
  } finally {
    libraryDb.close();
  }
}
```

---

## Task 4: Reference-Only Shard Persistence

**Modify file:** `src/cortex/loop.ts` (or `session.ts` — wherever tool results are stored to `cortex_session`)

When a sync tool returns a result with `shardContent`, the shard stores the `shardContent` (compressed reference) instead of the full `content`.

The LLM still sees the full `content` in the current turn — it's in the API response. But what gets written to `cortex_session` for future turns is the compressed version.

Find the section where tool_result messages are appended to the session. Currently it stores the full tool result content. Add a check:

```typescript
// When storing tool results to cortex_session:
const contentToStore = toolResult.shardContent ?? toolResult.content;

// The LLM API response includes the full content (toolResult.content)
// But cortex_session stores the compressed reference (toolResult.shardContent)
// This prevents shard pollution — library summaries don't persist across turns
appendStructuredContent(db, envelopeId, "user", "internal",
  [{ type: "tool_result", tool_use_id: tc.id, content: contentToStore }],
  issuer, assignedShardId);
```

**IMPORTANT:** The full `content` must still be sent to the LLM API in the current turn's messages. Only the session storage uses `shardContent`. The LLM needs the full summary to reason about — it just doesn't persist.

**How this works in practice:**

1. LLM calls `library_get(7)` → tool returns `{ content: "📚 [id:7] full 500-word summary...", shardContent: "📚 Referenced: [id:7] Ericsson O-RAN..." }`
2. LLM API receives the full 500-word summary in the tool_result message → uses it for reasoning
3. `cortex_session` stores: `"📚 Referenced: [id:7] Ericsson O-RAN..."` (~20 tokens)
4. Next turn: conversation history includes the compressed reference, not the full summary
5. If the LLM needs the full summary again, it calls `library_get(7)` again (free local query)

---

## Task 5: System Prompt Update

**Modify:** The system prompt section added in Phase 1.

Update from:
```
## Library
When the user shares a URL, always call library_ingest(url) to store it in the Library.
Every link the user shares is domain knowledge worth retaining. Do not ask whether to ingest —
just do it. You will receive a confirmation when ingestion completes.
```

To:
```
## Library
When the user shares a URL, always call library_ingest(url) to store it in the Library.
Every link the user shares is domain knowledge worth retaining.

Your context includes Library breadcrumbs — titles and tags of relevant items. 
Use library_get(id) to pull full details when you need them for answering.
Use library_search(query) to explore different angles or find items the breadcrumbs don't show.
You decide how deep to go — skip the Library for casual questions, pull multiple items for deep analysis.
```

---

## Files Summary

### New Files

| File | Description |
|------|-------------|
| `src/library/retrieval.ts` | All retrieval functions: breadcrumbs, getById, search, formatting, compressed references |

### Modified Files

| File | Change |
|------|--------|
| `src/cortex/context.ts` | Inject Library breadcrumbs into system prompt after hot facts |
| `src/cortex/tools.ts` | Add `library_get` and `library_search` tool definitions |
| `src/cortex/loop.ts` | Add sync tool handlers for library_get/library_search; implement shardContent persistence |
| Cortex system prompt | Update Library section with retrieval guidance |

---

## Testing

### Test 1: Breadcrumbs Appear in Context
1. Ingest 3-5 items via Phase 1 (drop URLs in chat)
2. Ask a question related to the ingested content
3. Verify: Cortex's response references Library knowledge
4. Check system prompt construction: breadcrumbs section present with relevant items

### Test 2: library_get Returns Full Details
1. Note an item ID from breadcrumbs (visible in Cortex context logs)
2. Ask Cortex a question that requires deep Library knowledge
3. Verify: Cortex calls library_get, response includes specific details from the item's summary

### Test 3: library_search Finds Different Items
1. Ingest 10+ items across different topics
2. Ask a question from a specific angle not directly matching any title
3. Verify: Cortex calls library_search with a refined query
4. Verify: Results differ from the breadcrumbs

### Test 4: Compressed References in Shard
1. After a turn where Cortex called library_get:
```bash
# Check cortex_session — the tool_result should contain compressed reference, not full summary
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('cortex/bus.sqlite', { readOnly: true });
  const rows = db.prepare(\"SELECT id, content FROM cortex_session WHERE content LIKE '%📚 Referenced%' ORDER BY id DESC LIMIT 5\").all();
  rows.forEach(r => console.log(r.id, r.content.slice(0, 120)));
  db.close();
"
```
2. Verify: stored content is ~20 tokens (compressed reference), not ~500 tokens (full summary)

### Test 5: Re-Pull After Compressed Reference
1. In turn 1, ask about a topic → Cortex pulls library_get(7)
2. In turn 2, ask for more details on the same topic
3. Verify: Cortex calls library_get(7) again (sees the compressed reference, knows it needs to re-pull)

### Test 6: Casual Question — No Library Pull
1. Ask something unrelated to any Library items ("what time is it?")
2. Verify: breadcrumbs present in context but Cortex does NOT call library_get or library_search
3. Token cost is only ~500 (breadcrumbs) not ~3000 (full summaries)

---

## Dependencies

- **Phase 1 must be complete** — Library DB must exist with items and embeddings
- **Ollama** must be running for embedding generation (breadcrumbs + library_search)
- **sqlite-vec** must be loaded for vector similarity queries

---

## What This Phase Does NOT Do

- No PDF handling — that's Phase 3
- No duplicate detection beyond URL uniqueness — that's Phase 3
- No stats or monitoring — that's Phase 3
- No Night Scholar, no diversity monitoring — that's deferred (architecture §10)
