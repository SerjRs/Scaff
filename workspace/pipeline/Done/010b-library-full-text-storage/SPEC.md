---
id: "010b"
title: "Store full_text on Library ingestion"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "done"
moved_at: "2026-03-14"
---

# 010b — Store full_text on Library Ingestion

## Problem

The `items.full_text` column exists in the schema but is never populated. All 21 items have `full_text = NULL`. This means:

- Can't re-process items when the Librarian prompt improves
- Can't re-generate summaries without re-fetching (links die, paywalls change)
- Can't do full-text search as a fallback when embeddings miss

## How Ingestion Works Today

1. Cortex calls `library_ingest(url)` → dispatched as async task via Router
2. Router executor (Librarian) fetches URL content, reads it, produces JSON:
   `{ title, summary, key_concepts, tags, content_type, source_quality }`
3. `gateway-bridge.ts` receives executor result, parses JSON, calls `insertItem()`
4. `insertItem()` stores everything — but `full_text` is never in the parsed JSON

## Root Cause

The Librarian executor prompt (in `src/library/librarian-prompt.ts`) tells the executor to return structured JSON with title, summary, key_concepts, tags, etc. It does NOT ask for the raw content to be passed through. The raw content is available to the executor (it reads the URL) but it's not included in the output.

## Fix

### Option A: Executor returns raw content alongside JSON (preferred)

Modify the Librarian prompt to include a `full_text` field in its JSON output. The executor already has the raw content — just needs to echo it back.

**Concern:** Token cost. Full text of articles can be 10-50KB. This doubles the executor output size.

**Mitigation:** Cap `full_text` at 50KB in the prompt. Most articles are under 20KB.

### Option B: Pre-fetch content in gateway-bridge before dispatching

Before spawning the Librarian executor, fetch the URL content in the gateway and store it directly. The executor still produces the summary/tags/concepts from its own fetch.

**Concern:** Double-fetch (gateway + executor both fetch). But simpler — no executor prompt change needed.

### Recommendation: Option A

Simpler, single fetch. The executor already has the content. Just echo it back.

## Files

| File | Change |
|------|--------|
| `src/library/librarian-prompt.ts` | Add `full_text` field to executor output schema |
| `src/cortex/gateway-bridge.ts` | Pass `parsed.full_text` to `insertItem()` call |

## Verification

After fix:
- Ingest a new URL → check `SELECT LENGTH(full_text) FROM items WHERE id = <new>`
- full_text should contain the raw article content (non-NULL, >0 length)
