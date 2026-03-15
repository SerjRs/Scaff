---
id: "017f"
title: "Replace Library breadcrumbs with graph breadcrumbs"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017b", "017e"]
parent: "017"
---

# 017f — Replace Library Breadcrumbs with Graph Breadcrumbs

## Depends on
- 017b (graph injection in System Floor working)
- 017e (articles in graph with sourced_from edges)

## Touches
- `src/cortex/llm-caller.ts`
- `src/cortex/context.ts` (if Library retrieval is called here)

## What to Change

**`llm-caller.ts`** — remove Library breadcrumb injection from system prompt. Currently injects top-10 Library item titles + tags. Replace with:

```
Library items are indexed in the Knowledge Graph. Article-derived facts appear in Hot Memory
with sourced_from edges. Use graph_traverse to explore domain knowledge.
Use library_get(id) to read the full article source text when needed.
```

**`context.ts`** — remove Library retrieval call in `assembleContext()` if breadcrumbs are fetched there.

## What to Delete
- Library breadcrumb injection code in system prompt builder
- Library retrieval call for breadcrumb generation in context assembly

## What NOT to Delete
- `library.sqlite` — stays as content store
- `library_get` tool — Cortex can still pull full article text
- `library_search` tool — Cortex can still explicitly search Library
- `library_stats` tool — stays
- `library_ingest` tool — stays (feeds graph via 017e)
- Library embedding infrastructure — stays (used by library_search)

## Tests
- System prompt no longer contains Library breadcrumb section
- Article-derived facts visible in hot memory graph with `sourced_from` edges
- `library_get(id)` still works
- `library_search(query)` still works

## Files
| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | Remove breadcrumb injection, add graph guidance |
| `src/cortex/context.ts` | Remove Library retrieval call if present |
