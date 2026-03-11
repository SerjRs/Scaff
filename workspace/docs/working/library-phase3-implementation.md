# Library Phase 3 — Polish, Edge Cases, and Validation

> **Status:** Not Started  
> **Date:** 2026-03-11  
> **Architecture:** `docs/library-architecture.md` (v2.3, §4, §9)  
> **Depends on:** Phase 1 (DB + ingestion) and Phase 2 (retrieval) must be complete  
> **Goal:** Handle edge cases (PDFs, dead links, duplicates), add stats, validate at scale with 20+ items.

---

## Overview

Phase 3 hardens the ingestion pipeline and validates retrieval quality at scale. After this phase:

- PDFs are handled automatically (pdf-parse extraction before sending to Librarian)
- Dead/unreachable URLs are tracked with retry logic
- Duplicate URL submissions update the existing entry instead of failing
- A `library_stats` tool gives Cortex visibility into Library health
- The system is validated with 20+ real items across different domains

---

## Task 1: PDF Handling

**Modify file:** `src/cortex/loop.ts` (in the `library_ingest` handler)

PDFs can't be fetched as HTML. The `library_ingest` handler needs to detect PDF URLs and use pdf-parse for extraction before sending to the Librarian executor.

In the `library_ingest` handler (Phase 1, Task 4), after the URL fetch but before building the Librarian prompt:

```typescript
// Detect PDF by Content-Type header or URL extension
const contentType = response.headers.get("content-type") ?? "";
const isPdf = contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");

if (isPdf) {
  // Save PDF to temp file, extract text via pdf-parse
  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `library-${taskId}.pdf`);
  fs.writeFileSync(tempPath, pdfBuffer);

  try {
    // Use npx pdf-parse (proven in our pipeline — see SAGE paper extraction)
    const { execSync } = await import("node:child_process");
    content = execSync(`npx -y pdf-parse text "${tempPath}"`, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,  // 10MB
    });

    // Truncate extracted text
    if (content.length > 50_000) {
      content = content.slice(0, 50_000) + "\n\n[TRUNCATED — PDF content exceeds 50K characters]";
    }
  } catch (pdfErr) {
    fetchError = `PDF extraction failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}
```

**Notes:**
- `npx -y pdf-parse text` is the same approach that successfully extracted the SAGE papers (51 pages, 205KB)
- Temp file is cleaned up after extraction
- If pdf-parse fails, the ingestion is marked as failed with the error
- Truncation at 50K chars matches the existing HTML truncation

---

## Task 2: Content Extraction Improvements

**Modify file:** `src/cortex/loop.ts` (in the `library_ingest` handler)

The current fetch uses raw `fetch()`. For better content extraction, use a more robust approach:

### 2.1 HTML-to-Text Extraction

After fetching HTML, strip tags and extract readable text. The raw HTML wastes tokens in the Librarian prompt.

```typescript
// After successful fetch of HTML content:
if (!isPdf && contentType.includes("text/html")) {
  // Basic HTML-to-text: strip tags, decode entities, collapse whitespace
  // A more robust approach would use a library like @mozilla/readability
  // but this is sufficient for v1
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")  // remove scripts
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")    // remove styles
    .replace(/<[^>]+>/g, " ")                           // strip tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")                               // collapse whitespace
    .trim();
}
```

**Alternative:** If the gateway already has a `web_fetch` utility with markdown extraction (used by the `web_fetch` tool), reuse that instead. Check `src/tools/web-fetch.ts` or similar for an existing extraction function.

### 2.2 Content-Type Handling

```typescript
// Unsupported content types
const unsupportedTypes = ["image/", "video/", "audio/", "application/zip", "application/octet-stream"];
if (unsupportedTypes.some(t => contentType.includes(t))) {
  fetchError = `Unsupported content type: ${contentType}. Library currently supports text/HTML and PDF.`;
}
```

---

## Task 3: Retry Logic for Failed Ingestions

**Create file:** `src/library/retry.ts`

A simple function that can be called periodically (e.g., during heartbeats or on explicit request) to retry failed ingestions.

```typescript
import { DatabaseSync } from "node:sqlite";

export interface FailedItem {
  id: number;
  url: string;
  error: string;
  created_at: string;
}

/**
 * Get items with status='failed' that are eligible for retry.
 * Only retry items less than 7 days old (after that, consider them permanently dead).
 */
export function getRetryableItems(db: DatabaseSync, limit: number = 5): FailedItem[] {
  return db.prepare(`
    SELECT id, url, error, created_at
    FROM items
    WHERE status = 'failed'
      AND created_at > datetime('now', '-7 days')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as FailedItem[];
}

/**
 * Mark a failed item as 'dead' (permanently unreachable).
 * Called when retry also fails, or when item is older than 7 days.
 */
export function markDead(db: DatabaseSync, itemId: number, error: string): void {
  db.prepare("UPDATE items SET status = 'dead', error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(error, itemId);
}

/**
 * Reset a failed item to be re-processed.
 * Called when the URL becomes reachable on retry.
 * The library_ingest handler will update it with real content.
 */
export function resetForReprocessing(db: DatabaseSync, itemId: number): void {
  db.prepare("UPDATE items SET status = 'active', error = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(itemId);
}
```

**Integration:** The retry logic is not automated in Phase 3. It provides the functions. Automation (e.g., a cron that calls `getRetryableItems` and re-runs ingestion) is deferred. The LLM could call a `library_retry` tool manually if the user asks.

---

## Task 4: Duplicate URL Handling

**Already handled in Phase 1:** The `insertItem` function in `src/library/db.ts` checks for existing URLs and updates the entry (incrementing `version`) instead of inserting a duplicate.

**Phase 3 addition:** Surface this to the user.

**Modify file:** `src/cortex/gateway-bridge.ts` (in the Library ops-trigger handler)

After `insertItem` returns, check if the item was updated (version > 1):

```typescript
const itemId = insertItem(libraryDb, { ...parsed, url: libraryUrl });

// Check if this was an update
const item = libraryDb.prepare("SELECT version FROM items WHERE id = ?").get(itemId) as { version: number };
if (item.version > 1) {
  confirmationMessage = `📚 Updated: "${parsed.title}" (v${item.version}) — tags: [${tagStr}]`;
} else {
  confirmationMessage = `📚 Stored: "${parsed.title}" — tags: [${tagStr}]`;
}
```

---

## Task 5: Library Stats Tool

**Modify file:** `src/cortex/tools.ts`

Add a sync tool for Library health visibility.

### 5.1 Tool Definition

```typescript
const LIBRARY_STATS_TOOL = {
  name: "library_stats",
  description: `Get Library statistics: total items, items by status, recent ingestions, 
tag distribution. Use when the user asks about Library health or what knowledge is stored.`,
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};
```

### 5.2 Tool Execution

```typescript
if (tc.name === "library_stats") {
  const { openLibraryDbReadonly } = await import("../library/retrieval.js");
  const libraryDb = openLibraryDbReadonly();
  if (!libraryDb) {
    return { content: "Library not initialized (no items ingested yet)." };
  }

  try {
    const total = libraryDb.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number };
    const byStatus = libraryDb.prepare(
      "SELECT status, COUNT(*) as c FROM items GROUP BY status ORDER BY c DESC"
    ).all() as { status: string; c: number }[];
    const recent = libraryDb.prepare(
      "SELECT id, title, tags, ingested_at FROM items WHERE status = 'active' ORDER BY ingested_at DESC LIMIT 5"
    ).all() as { id: number; title: string; tags: string; ingested_at: string }[];
    const withEmbeddings = libraryDb.prepare(
      "SELECT COUNT(*) as c FROM item_embeddings"
    ).get() as { c: number };

    // Tag frequency analysis
    const allTags = libraryDb.prepare(
      "SELECT tags FROM items WHERE status = 'active'"
    ).all() as { tags: string }[];
    const tagCounts = new Map<string, number>();
    for (const row of allTags) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      } catch { /* skip malformed */ }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => `${tag} (${count})`);

    const lines = [
      `📚 Library Statistics`,
      `Total items: ${total.c}`,
      `By status: ${byStatus.map(s => `${s.status}: ${s.c}`).join(", ")}`,
      `With embeddings: ${withEmbeddings.c}`,
      ``,
      `Recent ingestions:`,
      ...recent.map(r => {
        let tags: string[];
        try { tags = JSON.parse(r.tags); } catch { tags = []; }
        return `  [id:${r.id}] "${r.title}" — ${tags.slice(0, 3).join(", ")} (${r.ingested_at.slice(0, 10)})`;
      }),
      ``,
      `Top tags: ${topTags.join(", ")}`,
    ];

    return { content: lines.join("\n") };
  } finally {
    libraryDb.close();
  }
}
```

---

## Task 6: Scale Validation (20+ Items)

This is a manual validation task, not a code task. After Tasks 1-5 are complete:

### 6.1 Ingest 20+ Items

Feed Cortex 20+ URLs across different topics. Example mix for a software architecture domain:

```
# Architecture (5)
- Erlang supervisor patterns article
- Actor model overview
- Event sourcing primer
- CQRS pattern
- Microservices communication

# Tooling (5)
- sqlite-vec documentation
- Ollama API reference
- Node.js child_process docs
- pnpm workspace guide
- TypeScript strict mode guide

# Research (5)
- SAGE Paper 2
- SAGE Paper 3
- SAGE Paper 4
- RAG survey paper
- Multi-agent systems survey

# Operations (3)
- Linux systemd service management
- SSL/TLS certificate automation
- Log aggregation best practices

# Other (2-5)
- Mix of whatever is relevant to current work
```

### 6.2 Validate Breadcrumbs

Ask questions across different topics and verify:

| Question | Expected breadcrumbs |
|----------|---------------------|
| "How should we handle executor crashes?" | Erlang supervisors, actor model, SAGE papers |
| "What's the best way to manage dependencies?" | pnpm workspace, microservices |
| "Tell me about embedding search" | sqlite-vec, RAG survey |
| "What time is it?" | Breadcrumbs present but irrelevant — LLM ignores them |

### 6.3 Validate library_get Quality

For each topic, trigger a deep question that forces library_get:
- Verify the LLM pulls the right item
- Verify the response uses specific details from the summary
- Verify the shard contains compressed reference, not full summary

### 6.4 Validate library_search Refinement

Ask questions from angles not matching any title:
- "What about fault tolerance in distributed systems?" → should find Erlang + actor model + SAGE papers
- "How do I optimize token usage?" → should find RAG survey + context management articles

### 6.5 Validate Compressed References

After 10+ turns with library_get calls:
```bash
# Count compressed references vs full summaries in shard
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('cortex/bus.sqlite', { readOnly: true });
  const refs = db.prepare(\"SELECT COUNT(*) as c FROM cortex_session WHERE content LIKE '%📚 Referenced:%'\").get();
  const fulls = db.prepare(\"SELECT COUNT(*) as c FROM cortex_session WHERE content LIKE '%Summary:%' AND content LIKE '%Key Concepts:%'\").get();
  console.log('Compressed references:', refs.c);
  console.log('Full summaries in shard (should be 0):', fulls.c);
  db.close();
"
```

---

## Files Summary

### New Files

| File | Description |
|------|-------------|
| `src/library/retry.ts` | Retry logic for failed ingestions |

### Modified Files

| File | Change |
|------|--------|
| `src/cortex/loop.ts` | PDF detection + pdf-parse extraction; HTML-to-text extraction; content-type handling |
| `src/cortex/gateway-bridge.ts` | Duplicate URL feedback ("Updated" vs "Stored") |
| `src/cortex/tools.ts` | Add `library_stats` tool definition + execution |

---

## Testing

### Test 1: PDF Ingestion
1. Drop a PDF URL (e.g., a SAGE paper from GitHub)
2. Verify: Cortex confirms "📚 Stored: 'paper title' — tags: [...]"
3. Verify: Library DB has the item with extracted content

### Test 2: Dead URL
1. Drop an unreachable URL (e.g., `https://example.com/nonexistent-page-12345`)
2. Verify: Cortex reports failure, item stored with `status: 'failed'`

### Test 3: Duplicate URL
1. Drop a URL that was already ingested
2. Verify: Cortex confirms "📚 Updated: 'title' (v2) — tags: [...]"
3. Verify: DB shows `version = 2` for that item, not a duplicate row

### Test 4: Library Stats
1. Ask Cortex "What's in the Library?" or "Library stats"
2. Verify: Cortex calls library_stats, returns total items, status breakdown, recent items, top tags

### Test 5: Scale Validation
1. Complete the 20+ item ingestion from §6.1
2. Run through all validation checks from §6.2–6.5
3. Document any issues found

---

## Dependencies

- **Phase 1 and Phase 2 must be complete**
- **pdf-parse** must be installable via npx (already proven)
- **20+ real URLs** needed for scale validation

---

## What This Phase Completes

After Phase 3, the Library is production-ready for daily use:
- ✅ Any URL (HTML or PDF) can be ingested
- ✅ Failed ingestions are tracked with error details
- ✅ Duplicate URLs update existing entries
- ✅ Breadcrumbs appear on every turn
- ✅ LLM pulls details on demand via library_get
- ✅ LLM explores via library_search
- ✅ Tool results persist as compressed references
- ✅ Stats provide visibility into Library health
- ✅ Validated at scale with 20+ items

The Library is now the domain knowledge layer that makes Cortex deployable for any role.
