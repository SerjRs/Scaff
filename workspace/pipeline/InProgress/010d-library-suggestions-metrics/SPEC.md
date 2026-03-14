---
id: "010d"
title: "Proactive Library suggestions + growth metrics"
created: "2026-03-14"
author: "scaff"
priority: "low"
status: "in_progress"
moved_at: "2026-03-14"
---

# 010d — Proactive Library Suggestions + Growth Metrics

## Problem

Cortex doesn't proactively suggest feeding the Library, and `library_stats` doesn't surface embedding health or coverage gaps.

## Fix (two parts)

### Part 1: Proactive suggestions (system prompt only)

Add to Cortex system prompt tool guidance:

> When you detect a knowledge gap during conversation — the user asks about a topic you can't answer well and Library search returns nothing — suggest they share relevant links:
> "I don't have deep context on X. If you have docs or articles, drop a link and I'll learn it."

**No code change** — purely prompt guidance in `llm-caller.ts`.

### Part 2: library_stats enhancements

Extend `executeLibraryStats()` in `src/cortex/tools.ts` to include:

1. **Embedding health**: `With embeddings: 4/21 (⚠️ 17 items invisible to search)`
2. **Coverage alert**: If <80% of items have embeddings, append warning
3. **Items/week trend**: Count items by `ingested_at` grouped by ISO week
4. **Tag clusters**: Group items by top tags to show domain coverage

Example output:
```
📚 Library Statistics
Total items: 21 (active: 21)
Embedding health: 4/21 ⚠️ (17 items invisible to breadcrumbs + search)
Items this week: 3 | Last week: 8 | 2 weeks ago: 10

Top tags: distributed-systems (8), ai-agents (6), security (4), ...

Domain coverage:
  AI/Agents: 11 items
  Security: 4 items
  Infrastructure: 3 items
  Other: 3 items
```

### Dependency

Part 2 is more useful after 010a (backfill) — the embedding health metric becomes actionable.

## Files

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | System prompt addition (proactive suggestions) |
| `src/cortex/tools.ts` | `executeLibraryStats()` enhancements |
