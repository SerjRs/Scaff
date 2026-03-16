# 019h — Vector Evictor Tests — STATE

## Status: COMPLETE ✓

## Date: 2026-03-16

## Tests Run: 3/3 passing (H1, H2, H3)

## Files Changed: none

## Findings

Category H tests already use real embeddings — no `mockEmbedFn` present:

- **H1. Stale graph facts are eviction candidates** — No embed function used (tests `getStaleGraphFacts` only). ✓ PASS
- **H2. Legacy hot memory co-exists with graph facts** — No embed function used (tests table co-existence). ✓ PASS
- **H3. pruneOldStubs cleans bilateral old stubs** — Uses real `embedFn` from `hippo-test-utils.ts` (Ollama `nomic-embed-text`). ✓ PASS

## Verification

```
npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts -t "H. Full Vector Evictor"
→ 3 passed, 58 skipped, Duration 768ms
```

## Summary

The SPEC described replacing `mockEmbedFn` with real Ollama embeddings, but the tests were already migrated to use the real `embedFn` from `helpers/hippo-test-utils.ts`. No code changes needed.
