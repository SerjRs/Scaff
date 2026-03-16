# 019b State

## Status: done
## Last Action: All 7 Category B tests passing with real Sonnet + Ollama
## Files Changed:
- `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — replaced mocks with real LLM/embeddings
## Tests Run: 7/7 passing (B1–B7)
## Next Step: Commit
## Errors: None

## Test Results
- **B1** Extract facts from simple conversation — PASS (3.9s, real Sonnet)
- **B2** Extract facts with all types — PASS (5.4s, real Sonnet)
- **B3** Malformed LLM output — graceful fallback — PASS (kept intentionally broken LLM for parser test)
- **B4** LLM extracts facts from minimal transcript — PASS (2.4s, real Sonnet)
- **B5** Dedup — exact duplicate rejected — PASS (real Ollama embeddings)
- **B6** Dedup — near-duplicate replaces — PASS (real Ollama embeddings)
- **B7** Dedup — different facts both kept — PASS (real Ollama embeddings)

## Changes Made
1. Added `extractLLM` import from helpers (already defined with real Sonnet)
2. B1: Replaced mockLLM with `extractLLM`, relaxed assertions to `>= 1 facts with valid types`
3. B2: Replaced mockLLM with `extractLLM`, enriched transcript to elicit multiple fact types
4. B3: Kept intentionally broken LLM (`brokenLLM`) — tests parser fallback, not LLM quality
5. B4: Replaced mockLLM with `extractLLM`, relaxed to `>= 1 fact`
6. B5–B7: Already used real `embedFn` from helpers (Ollama nomic-embed-text)
7. Added 30s timeouts to all tests using real API calls
