# Claude Code Instructions — 020d

## Branch
`feat/020d-cortex-e2e-hippo`

## Task
Create `src/cortex/__tests__/e2e-webchat-hippo.test.ts` — E2E tests for Hippocampus knowledge graph integration through the full Cortex webchat loop.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020d-cortex-e2e/SPEC.md`

~6 tests in category E (Hippocampus Integration):
- E1: Hot memory facts appear in system floor
- E2: Graph facts with edges show breadcrumbs in system floor
- E3: Fact extraction after conversation (Gardener)
- E4: Memory query searches both hot and cold
- E5: Eviction preserves edge stubs
- E6: Revival on cold search hit

## Key Setup

These tests need hippocampus enabled:

```typescript
const instance = await startCortex({
  // ... base config ...
  hippocampusEnabled: true,
  embedFn: mockEmbedFn,
  gardenerExtractLLM: mockExtractLLM,
  gardenerSummarizeLLM: mockSummarizeLLM,
});
```

For inserting test data, use the hippocampus functions directly on `instance.db`:
```typescript
import { insertFact, insertEdge, getTopFactsWithEdges } from "../hippocampus.js";
insertFact(instance.db, { factText: "test fact", ... });
```

## Patterns

Follow the pattern from existing test files:
- `src/cortex/__tests__/e2e-webchat-flow.test.ts` — startCortex + adapter pattern
- `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — hippocampus functions + mockEmbedFn
- `src/cortex/__tests__/helpers/hippo-test-utils.ts` — TestReporter, dump helpers, mockEmbedFn

## Test Results

Write to: `workspace/pipeline/InProgress/020d-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, existing test files, hippocampus.ts, context.ts
2. Create the test file
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-hippo.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020d — E2E webchat hippocampus integration" --base main`
6. Signal: `openclaw system event --text "Done 020d"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic (mock LLMs, mock embeddings, no network)
- Temp dirs + temp DBs, cleanup in afterEach
