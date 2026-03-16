---
id: "019h"
title: "Hippocampus Tests — H. Full Vector Evictor Integration"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019h — Full Vector Evictor Integration Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category H (3 tests)

## Tests
- H1. Stale graph facts are eviction candidates
- H2. Legacy hot memory co-exists with graph facts
- H3. pruneOldStubs cleans bilateral old stubs

## LLM Usage
Uses `mockEmbedFn` for eviction in H1, H3. No LLM calls.

## Task
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
