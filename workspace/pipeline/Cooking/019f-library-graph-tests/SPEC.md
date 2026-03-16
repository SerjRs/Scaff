---
id: "019f"
title: "Hippocampus Tests — F. Library → Graph Enrichment"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019f — Library → Graph Enrichment Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category F (6 tests)

## Tests
- F1. Article ingestion creates source node + facts + edges
- F2. Multiple articles create separate subgraphs
- F3. Cross-article connections via consolidation edge
- F4. Consolidator skips already-connected facts
- F5. Empty recent facts → consolidation no-op
- F6. Source ref enables idempotent article ingestion

## LLM Usage
None — pure DB operations (facts and edges inserted directly, not via LLM extraction).

## Task
- Remove mock imports if referenced
- Pure graph structure tests, should pass once mock imports are cleaned up
