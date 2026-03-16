---
id: "019j"
title: "Hippocampus Tests — J. End-to-End Lifecycle Scenarios"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019j — End-to-End Lifecycle Scenarios Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category J (5 tests)

## Tests
- J1. Extraction → graph → system floor (full pipeline)
- J2. Article ingest → cross-source graph
- J3. Fact lifecycle: birth → promotion → eviction → revival
- J4. Graph growth — 50 facts across 3 sources
- J5. Contradiction handling

## LLM Usage
J1 uses `mockLLM` for fact extraction + `mockEmbedFn`. J3 uses `mockEmbedFn`. J2, J4, J5 are pure DB.

## Task
- Replace `mockLLM` in J1 with real Sonnet via `complete()`:
  ```typescript
  import { complete } from '../../llm/simple-complete.js';
  const extractLLM = async (prompt: string) => complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });
  ```
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
- These are the most complex tests — full pipeline flows. Increase timeouts significantly (30s+ per test).
