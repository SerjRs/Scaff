---
id: "017c"
title: "graph_traverse sync tool — walk the knowledge graph N hops"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "in_progress"
moved_at: "2026-03-14"
depends_on: ["017a"]
parent: "017"
---

# 017c — graph_traverse Sync Tool

## Depends on
017a (graph schema + CRUD)

## Touches
- `src/cortex/hippocampus.ts` (traversal function)
- `src/cortex/tools.ts` (tool definition + SYNC_TOOL_NAMES)
- `src/cortex/llm-caller.ts` (register tool + prompt guidance)
- `src/cortex/loop.ts` (execution handler)

## What to Build

New sync tool: `graph_traverse`

**Parameters:**
- `fact_id` (string, required) — starting node ID (from hot memory breadcrumbs)
- `depth` (number, optional, default 2, max 4) — hops to traverse
- `direction` (string, optional, default "both") — "outgoing" | "incoming" | "both"

**Executor** in `hippocampus.ts` — `traverseGraph(db, factId, depth, direction)`:
- Recursive CTE to walk edges N hops
- Returns structured subgraph as readable text
- Shows stub indicators for evicted facts: `[evicted: topic hint]`
- Caps at 50 nodes to prevent context explosion

**Output format:**
```
Subgraph from "Budget is 2.4M" (depth=2):

Budget is 2.4M
  → constrains: O-RAN deployment North
    → deadline: Q3
    → informed_by: O-RAN TCO article (lib:25)
  → part: hardware 1.8M
  → part: integration 500K
    → corrects: article estimate [SUPERSEDED]
```

**Registration:**
- Add `graph_traverse` to `SYNC_TOOL_NAMES` set
- Add tool definition to `FILE_IO_TOOLS` array in llm-caller.ts
- Add handler in loop.ts sync tool switch
- Add to system prompt: "Use graph_traverse to explore connections from hot memory breadcrumbs."

## What NOT to Change
- `memory_query` — stays as semantic search
- `fetch_chat_history` — stays as chronological replay

## Tests
- 1-hop returns immediate edges only
- 2-hop returns edges of edges
- Direction filtering works
- Stubs show as `[evicted: topic]`
- Depth capped at 4, nodes capped at 50
- Unknown fact_id returns clear error

## Files
| File | Change |
|------|--------|
| `src/cortex/hippocampus.ts` | New `traverseGraph()` function with recursive CTE |
| `src/cortex/tools.ts` | Tool definition, add to SYNC_TOOL_NAMES |
| `src/cortex/llm-caller.ts` | Register tool, prompt guidance |
| `src/cortex/loop.ts` | Execution handler |
