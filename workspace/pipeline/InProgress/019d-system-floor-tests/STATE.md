# 019d — System Floor Knowledge Graph Injection Tests

## Status: COMPLETE

## Date: 2026-03-16

## Summary

All 6 Category D tests (D1–D6) already pass. No changes needed.

### What was found

- **No mocks to replace**: The spec mentioned replacing `mockEmbedFn` with real Ollama, but the test file already uses `embedFn` from `hippo-test-utils.ts`, which calls real Ollama `nomic-embed-text` at `http://127.0.0.1:11434/api/embeddings`.
- **D4 (the only test using embeddings)**: Uses `embedFn` (real Ollama) via `tryInitVec()` + `evictFact()`. Falls back to `updateFactStatus()` if sqlite-vec is unavailable.
- **All other D tests (D1-D3, D5, D6)**: Pure DB + context assembly tests with no embedding calls at all.

### Test Results

```
✓ D1. Empty graph → no Knowledge Graph section (20ms)
✓ D2. Facts without edges → flat list (18ms)
✓ D3. Facts with edges → edge breadcrumbs shown (20ms)
✓ D4. Evicted fact excluded from top facts (23ms)
✓ D5. Top-30 ranking — hit_count + recency (76ms)
✓ D6. System floor token count is reasonable (42ms)
```

All 6/6 passing. No code changes required.
