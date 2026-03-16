---
id: "019c"
title: "Hippocampus Tests — C. Shard-Aware Fact Extraction"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019c — Shard-Aware Fact Extraction Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category C (5 tests)

## Tests
- C1. Shard table exists after init
- C2. Fact extraction writes to graph with source_type=conversation
- C3. Multiple sources tracked independently
- C4. Already-extracted shard marker prevents re-extraction
- C5. Fallback extraction from raw session (no shards)

## LLM Usage
C5 uses `mockLLM` for extraction. C1–C4 are pure DB operations.

## Task
- Replace `mockLLM` in C5 with real Sonnet via `complete()`
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text` where used
- Increase timeouts for real API calls
