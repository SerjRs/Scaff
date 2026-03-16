# 019i — Memory Query Integration Tests — STATE

## Status: COMPLETE

## Date: 2026-03-16

## Findings

### No mocks to replace
The SPEC said to replace `mockEmbedFn` with real Ollama `nomic-embed-text`, but `mockEmbedFn` does not exist in the codebase. The test file already uses `embedFn` from `hippo-test-utils.ts` (line 173-181), which calls real Ollama at `http://127.0.0.1:11434/api/embeddings` with `nomic-embed-text`.

### 023 dependency already satisfied
Task 023 (memory_query must search graph facts) is complete with its own dedicated test files:
- `src/cortex/__tests__/unit-memory-query.test.ts` — 6 unit tests (all pass)
- `src/cortex/__tests__/e2e-memory-query-graph.test.ts` — 2 E2E tests (all pass)

Category I tests validate the lower-level building blocks (`getTopFactsWithEdges`, `searchColdFacts`, `reviveFact`, `touchGraphFact`) — no assertions contradict the 023 fix.

### All 4 tests pass

```
✓ I1. Hot graph facts found via getTopFactsWithEdges (17ms)
✓ I2. Cold facts found via searchColdFacts (115ms)
✓ I3. Revival restores status after cold hit (114ms)
✓ I4. touchGraphFact increments on access (16ms)
```

## Actions Taken
1. Read SPEC.md — identified 4 tests, dependency on 023
2. Searched for `mockEmbedFn` — not found anywhere in codebase
3. Verified `embedFn` already uses real Ollama nomic-embed-text
4. Confirmed 023 is done with 8/8 tests passing
5. Ran Category I tests — all 4 pass
6. No code changes needed
