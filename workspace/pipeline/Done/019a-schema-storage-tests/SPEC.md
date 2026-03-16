---
id: "019a"
title: "Hippocampus Tests — A. Schema & Storage Foundation"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019a — Schema & Storage Foundation Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category A (6 tests)

## Tests
- A1. Graph tables created on init
- A2. Insert a fact and verify storage
- A3. Insert an edge and verify storage
- A4. All fact types stored correctly
- A5. All edge types stored correctly
- A6. Migration from legacy hot memory

## Current Problem
Tests use `mockEmbedFn` and `mockEmbedding` from `helpers/hippo-test-utils.ts`. These must be replaced with real calls.

## What to Change

### 1. Replace mock embedding with real Ollama
Everywhere `mockEmbedFn` or `mockEmbedding` is used, replace with:

```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json() as { embedding: number[] };
  return new Float32Array(data.embedding);
}
```

Ollama is running locally at `127.0.0.1:11434` with `nomic-embed-text` model (768 dimensions).

### 2. Replace mock LLM with real Sonnet (for future categories, establish pattern here)
The project has a reusable LLM client at `src/llm/simple-complete.ts`:

```typescript
import { complete } from '../../llm/simple-complete.js';
const extractLLM = async (prompt: string) => 
  complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });
```

Auth is handled automatically via `src/llm/resolve-auth.ts` which reads OAuth tokens from `~/.openclaw/agents/main/agent/auth-profiles.json`.

Category A may not need LLM calls, but set up the pattern in the shared helpers so subsequent categories can reuse it.

### 3. Update helpers file
`src/cortex/__tests__/helpers/hippo-test-utils.ts` — replace `mockEmbedFn` and `mockEmbedding` exports with real `embedFn`. Remove mock-related exports. Add `extractLLM` export using `complete()`.

### 4. Increase timeouts
Real Ollama embedding calls take ~100-300ms each. Set vitest timeout to 30000ms for this category.

## Steps
1. Read the current test file and helpers
2. Update `hippo-test-utils.ts` — replace mocks with real calls
3. Update Category A tests to use real embedding function
4. Run ONLY Category A: `npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts -t "A\."  --reporter=verbose`
5. Write results to `STATE.md` in this task folder
6. Commit changes

## Constraints
- NO mocks
- Do NOT touch tests outside Category A
- Real Ollama embeddings, real Sonnet LLM
