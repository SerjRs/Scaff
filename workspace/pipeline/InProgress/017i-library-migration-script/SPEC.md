---
id: "017i"
title: "Migration script — existing Library items to graph"
created: "2026-03-14"
author: "scaff"
priority: "low"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a", "017d", "017e", "017g"]
parent: "017"
---

# 017i — Migration Script: Library Items → Graph

> Last task. Run after everything else is deployed.

## Depends on
All previous tasks (017a through 017h).

## Touches
- New script: `scripts/library-to-graph.mjs`

## What to Build

One-time migration script that processes all existing Library items (currently 21):

1. For each active item in `library.sqlite`:
   - Read title, summary, key_concepts, tags
   - Call Ollama (or Sonnet for better quality) with the fact extraction prompt from 017e
   - Create article source node in `hippocampus_facts`
   - Insert extracted facts with `source_type='article'`, `source_ref='library://item/{id}'`
   - Insert edges + `sourced_from` edges to article source node

2. After all items processed:
   - Run the Consolidator (017g) to find cross-article connections
   - Log summary: items processed, facts extracted, edges created

## Constraints
- **Idempotent:** check for existing `source_ref` before inserting — safe to run multiple times
- **Timeout:** 30s per item for LLM extraction
- **Sequential:** process one at a time (don't overload Ollama)
- **Model:** Use Sonnet for better extraction quality on the initial migration (one-time cost is acceptable)

## Run command
```
node scripts/library-to-graph.mjs
```

## Tests
- Run on existing 21 items → all produce facts + edges
- Run twice → no duplicates (idempotent)
- Consolidator finds cross-article connections after migration

## Files
| File | Change |
|------|--------|
| `scripts/library-to-graph.mjs` | New — one-time migration script |
