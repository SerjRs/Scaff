---
id: "017d"
title: "Conversation fact extraction with edges"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a"]
parent: "017"
---

# 017d — Conversation Fact Extraction with Edges

## Depends on
017a (graph schema + CRUD)

## Current State
The `scaff-hot-memory` plugin handles fact extraction externally — hooks into the gateway, reads conversation turns, extracts flat facts via LLM, inserts into `cortex_hot_memory` with embedding dedup (cosine 0.85).

## Touches
- The `scaff-hot-memory` plugin (external, in extensions or plugins directory)
- OR new extraction function in `src/cortex/hippocampus.ts` if plugin modification is too complex

## What to Change

Extend extraction to output facts + relationships:

**Modified extraction prompt:**
```
From this conversation, extract:
1. Facts: specific claims, observations (not greetings or filler)
2. Decisions: explicit choices ("we decided...", "let's go with...")
3. Outcomes: results ("it worked", "it failed", "we learned...")
4. Corrections: things wrong ("actually...", "that was incorrect...")

For each, identify relationships to OTHER extracted facts:
- because: A happened because of B
- informed_by: A was informed by B
- contradicts: A contradicts B
- updated_by: A is superseded by B
- resulted_in: A led to B

Output JSON:
{
  "facts": [{ "id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low" }],
  "edges": [{ "from": "f1", "to": "f2", "type": "because" }]
}
```

**Write targets:** Insert into `hippocampus_facts` + `hippocampus_edges` instead of `cortex_hot_memory`.

**Dedup:** Keep the cosine 0.85 dedup but apply it against `hippocampus_facts` embeddings.

## What to Delete (after verified)
- Writes to `cortex_hot_memory` from the plugin (redirect to new tables)
- `cortex_hot_memory` table stays readable for backward compat

## Tests
- Sample conversation → facts + edges extracted
- Decision and correction types correctly tagged
- Dedup: similar fact updates existing, doesn't duplicate
- Edges reference valid fact IDs

## Files
| File | Change |
|------|--------|
| `scaff-hot-memory` plugin | Modify extraction prompt, write to new tables |
| `src/cortex/hippocampus.ts` | Possibly new `extractFactsAndEdges()` if plugin approach doesn't work |
