# 019c — Shard-Aware Fact Extraction Tests: State

## Status: COMPLETE

## Changes Made
- **C5 test**: Replaced `mockLLM` with real Sonnet via `extractLLM` from `hippo-test-utils.ts`
- **C5 test**: Changed assertion from exact `toHaveLength(1)` to `toBeGreaterThanOrEqual(1)` (real LLM may extract multiple facts)
- **C5 test**: Added 30s timeout for real API call
- **C5 test**: Updated reporter name/expected/actual to reflect real Sonnet usage
- No `mockEmbedFn` was used in Category C — no embedding changes needed (C1–C4 are pure DB ops)

## Test Results
- **5/5 passing** — C1, C2, C3, C4, C5
- C5 ran with real Sonnet in ~3.5s
- All tests ran in 4.17s total

## Files Modified
- `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category C, test C5 only
