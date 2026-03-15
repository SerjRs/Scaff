---
id: "017g"
title: "Consolidator — find cross-connections between facts daily"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a", "017d", "017e"]
parent: "017"
---

# 017g — Consolidator

## Depends on
- 017a (graph schema)
- 017d (conversation facts in graph)
- 017e (article facts in graph)

## Touches
- New file: `src/cortex/consolidator.ts`
- Cron configuration for scheduling

## What to Build

New module `consolidator.ts` with function `runConsolidation(db, embedFn, llmFn)`:

1. **Find recent facts** created since last consolidation:
   ```sql
   SELECT * FROM hippocampus_facts WHERE created_at > ? AND status = 'active'
   ```

2. **Find candidate connections** for each recent fact:
   - **Entity overlap:** extract key terms from fact_text, find existing facts with same terms (simple string matching, no LLM)
   - **Embedding similarity:** embed the fact, find top-5 similar existing facts via sqlite-vec

3. **Ask LLM for relationships:**
   ```
   Given these new facts: [...]
   And these existing facts: [...]
   Identify relationships. Output: { edges: [{ from, to, type, confidence }] }
   Only output relationships you're confident about. Do not invent connections.
   ```

4. **Insert discovered edges** into `hippocampus_edges` (skip duplicates)

5. **Log** the run: timestamp, facts scanned, edges discovered

### Scheduling
- Frequency: daily (configurable)
- Also triggered after article ingestion completes
- Model: Ollama llama3.2:3b (local, free)

## Tests
- Two unconnected facts about same topic → consolidation finds edge
- Facts from different sources (conversation + article) → cross-source edge
- Already-connected facts → no duplicate edges
- Empty recent facts → no-op, no errors

## Files
| File | Change |
|------|--------|
| `src/cortex/consolidator.ts` | New module — consolidation logic |
| Cron config | New daily job for consolidation |
