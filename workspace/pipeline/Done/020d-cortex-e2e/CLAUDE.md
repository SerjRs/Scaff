# CLAUDE.md — 020d: Fix Webchat Hippocampus E2E Tests

> **DO NOT ASK FOR CONFIRMATION. Execute all steps immediately. No brainstorming, no "shall I proceed" — just do it.**

## Task
Fix the 3 failing tests (E4, E5, E6) in `src/cortex/__tests__/e2e-webchat-hippo.test.ts`. 
They fail because they reference `mockEmbedFn` which was removed from `hippo-test-utils.ts` during 019 work.

## What Changed
The helpers file `src/cortex/__tests__/helpers/hippo-test-utils.ts` no longer exports `mockEmbedFn` or `mockEmbedding`.
It now exports:
- `embedFn` — real Ollama `nomic-embed-text` embeddings (async, returns Float32Array)
- `extractLLM` — real Sonnet via `src/llm/simple-complete.ts`

## Steps

### 1. Fix imports (line 38)
Replace:
```typescript
  mockEmbedFn,
  mockEmbedding,
```
With:
```typescript
  embedFn,
```

### 2. Replace ALL `mockEmbedFn` calls with `embedFn`
There are ~13 occurrences throughout the file. `embedFn` has the same signature: `(text: string) => Promise<Float32Array>`.

### 3. Replace `mockEmbedding` usages
`mockEmbedding` was a pre-computed constant. Replace any usage with an inline call: `await embedFn("the text")`.

### 4. Update header comment
Remove/update the line "All LLMs are mocked. All tests are deterministic." — embeddings now use real Ollama.

### 5. Run tests
```bash
npx vitest run src/cortex/__tests__/e2e-webchat-hippo.test.ts --reporter=verbose --timeout 30000
```

All 6 tests (E1-E6) must pass.

### 6. Write results
Update `STATE.md` in this directory with:
```
## Status: Done
## Test Results: 6/6 passing
```

### 7. Commit
```bash
git add src/cortex/__tests__/e2e-webchat-hippo.test.ts
git commit -m "test(020d): replace mockEmbedFn with real Ollama embeddings — 6/6 passing"
```

## Constraints
- Do NOT create new mock functions — use real `embedFn` from utils
- Do NOT modify `hippo-test-utils.ts` 
- Vitest timeout must be 30000ms (real embedding calls)
- Save state after each significant step
- If tests fail for reasons OTHER than the mock replacement, document the error and stop

## Environment
- Working dir: `C:\Users\Temp User\.openclaw`
- Ollama at `127.0.0.1:11434` with `nomic-embed-text` model
- Node v24.13.0, Windows
