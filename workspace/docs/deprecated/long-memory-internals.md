# Long Memory — Implementation Internals

> Last updated: 2026-02-23

## Storage

Long Memory stores extracted facts as **plain markdown files** on disk.

- **Location:** `~/.openclaw/agents/{agentId}/memory/long-term/`
- **File naming:** `facts-YYYY-MM-DD.md` (one shard per day)
- **Format:** One fact per line, appended via `fs.appendFile()`:
  ```
  - [preference] (2026-02-23 14:30:12) User prefers dark mode
  - [decision] (2026-02-23 14:31:05) Decided to use PostgreSQL for the project
  - [fact] (2026-02-23 15:00:00) Project deadline is March 15
  ```
- **Categories:** `decision`, `preference`, `fact`, `action_item`, `context`
- **No vector database** — Long Memory does not use embeddings or vector search.

## Extraction Pipeline

```
Cron (every 10 min)
  → enqueue "long_memory_extraction" Router job
    → Router worker calls longMemoryWorker.runExtractionCycle()
      → reads backup JSONL files (byte-offset watermark skips already-processed content)
        → sends message batches to Haiku (claude-haiku-4-5)
          → Haiku returns JSON array of extracted facts
            → persistFacts() appends to daily markdown shard
```

**Key files:**
| File | Role |
|------|------|
| `src/cron/long-memory-cron.ts` | Cron scheduler (10 min interval) |
| `src/agents/long-memory-worker.ts` | Worker that iterates inactive sessions |
| `src/memory/long-memory-extractor.ts` | AI extraction (Haiku) + storage + search |
| `src/router/worker.ts` | Routes `long_memory_extraction` jobs to the worker |

**Watermark deduplication:** Each backup file has a `.watermark_{sessionId}_backup` file that stores the byte offset of the last processed position. On each cycle, only new content past the watermark is sent to Haiku.

## Search / Retrieval

`searchLongMemory(agentId, query, limit)` in `long-memory-extractor.ts`:

1. Lists all `facts-*.md` files (newest first)
2. Splits query into words (length > 2 chars)
3. Reads each file line-by-line
4. Scores each line by counting matching query words
5. Parses matching lines back into `ExtractedFact` objects
6. Returns top results up to `limit`

**This is naive keyword matching, not vector/semantic search.**

The code itself notes (line 272):
> "Simple keyword matching — for full vector search, use MemoryIndexManager."

The vector path (`MemoryIndexManager`) is not wired to Long Memory.

## Two Access Paths

1. **Automatic fallback** — `src/memory/hot-memory-inject.ts` queries Long Memory when Hot Memory returns fewer than 3 results for a query. Silent, no tool call needed.

2. **Explicit tool** — `long_memory_search` tool (`src/agents/tools/long-memory-search-tool.ts`) lets Cortex search Long Memory directly when the user asks about older context.

## Known Limitations

- **No semantic search** — keyword matching misses synonyms, paraphrases, and related concepts. A query for "database choice" won't find a fact about "decided to use PostgreSQL" unless the exact words overlap.
- **No ranking by relevance** — results are ordered by file (newest first) then by position in file, not by semantic similarity.
- **No deduplication** — if the same fact is extracted across multiple cycles, it appears multiple times in the shard files.
- **No pruning** — shard files grow indefinitely. Old facts are never removed or consolidated.
- **Hot Memory (24h) uses vector search; Long Memory does not** — there's an architectural inconsistency where the shorter-term memory has better search quality than the long-term one.
