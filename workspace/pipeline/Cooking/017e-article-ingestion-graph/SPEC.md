---
id: "017e"
title: "Article ingestion to graph — extend Librarian + gateway-bridge"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a", "017d"]
parent: "017"
---

# 017e — Article Ingestion → Graph

## Depends on
- 017a (graph schema)
- 017d (same extraction JSON format)

## Touches
- `src/library/librarian-prompt.ts`
- `src/cortex/gateway-bridge.ts`

## What to Change

**`librarian-prompt.ts`** — extend Librarian output schema:

Add to the JSON output alongside existing title/summary/tags/key_concepts/full_text:
```
"facts": [
  { "id": "f1", "text": "O-RAN reduces TCO by 30%", "type": "fact", "confidence": "high" }
],
"edges": [
  { "from": "f1", "to": "f2", "type": "because" }
]
```

**`gateway-bridge.ts`** — Library task handler (~line 349):

After existing `insertItem()` call (which stores raw content in library.sqlite), add:
1. Parse `parsed.facts` and `parsed.edges` from executor output
2. Create article source node in `hippocampus_facts`:
   `{ fact_type: 'source', fact_text: 'Article: {title}', source_type: 'article', source_ref: 'library://item/{id}' }`
3. Insert each extracted fact into `hippocampus_facts` with `source_type='article'`, `source_ref='library://item/{id}'`
4. Insert edges from extraction output into `hippocampus_edges`
5. Add `sourced_from` edge from each fact to the article source node

**Graceful fallback:** If executor output lacks facts/edges (old Librarian prompt), skip graph insertion — Library storage still works.

## What NOT to Change
- `insertItem()` in library/db.ts — still stores raw content
- Library tools — all stay
- Library breadcrumbs — removed in 017f, not here

## Tests
- Ingest article → facts + edges appear in hippocampus tables
- `sourced_from` edge links each fact to article source node
- Article source node has `source_ref = 'library://item/{id}'`
- Old executor output (no facts/edges) → graceful skip, Library storage works

## Files
| File | Change |
|------|--------|
| `src/library/librarian-prompt.ts` | Add facts + edges to output schema |
| `src/cortex/gateway-bridge.ts` | Parse facts/edges, write to hippocampus tables |
