---
id: "019i"
title: "Hippocampus Tests — I. Memory Query Integration"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019i — Memory Query Integration Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category I (4 tests)

## Tests
- I1. Hot graph facts found via getTopFactsWithEdges
- I2. Cold facts found via searchColdFacts
- I3. Revival restores status after cold hit
- I4. touchGraphFact increments on access

## LLM Usage
Uses `mockEmbedFn` for cold storage operations (I2, I3). No LLM calls.

## Task
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
- After 023 fix, these tests should also verify graph facts appear in memory_query results (not just cold facts)
- If any tests contradict the 023 fix (e.g. assert only cold results), update assertions to match new behavior

## Dependency
Depends on 023 (memory_query now searches graph facts too)
