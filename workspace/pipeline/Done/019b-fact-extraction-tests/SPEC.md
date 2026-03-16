---
id: "019b"
title: "Hippocampus Tests — B. Fact Extraction from Conversations"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019b — Fact Extraction from Conversations Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category B (7 tests)

## Tests
- B1. Extract facts from simple conversation
- B2. Extract facts with all types (including outcome and correction)
- B3. Malformed LLM output — graceful fallback
- B4. LLM returns facts without edges
- B5. Dedup — exact duplicate rejected
- B6. Dedup — near-duplicate with longer text replaces
- B7. Dedup — different facts both kept

## LLM Usage
B1, B2, B3, B4 use `mockLLM` for fact extraction. B5–B7 use `mockEmbedFn` for dedup.

## Task
- Replace `mockLLM` / `mockExtractLLM` with real Sonnet via `complete()`:
  ```typescript
  import { complete } from '../../llm/simple-complete.js';
  const extractLLM = async (prompt: string) => complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });
  ```
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
- B3 tests malformed output — with real LLM this test needs rethinking (real LLM won't return garbage). Either test with an intentionally broken endpoint or verify the graceful fallback path differently.
- Increase timeouts for real API calls
