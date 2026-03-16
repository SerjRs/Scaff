---
id: "019d"
title: "Hippocampus Tests — D. System Floor Knowledge Graph Injection"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019d — System Floor Knowledge Graph Injection Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category D (6 tests)

## Tests
- D1. Empty graph → no Knowledge Graph section
- D2. Facts without edges → flat list
- D3. Facts with edges → edge breadcrumbs shown
- D4. Evicted fact excluded from top facts
- D5. Top-30 ranking — hit_count + recency
- D6. System floor token count is reasonable

## LLM Usage
Uses `mockEmbedFn` for eviction in D4. No LLM calls.

## Task
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
- These are mostly pure DB + context assembly tests, should be straightforward
