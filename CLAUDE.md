# Claude Code Instructions — 023

## Branch
`feat/023-memory-query-graph`

## Task
Fix `executeMemoryQuery` in `src/cortex/tools.ts` so it also searches `hippocampus_facts_vec` (graph facts), not just `cortex_cold_memory`. Then write unit tests and E2E tests.

Read the full spec: `workspace/pipeline/Cooking/023-memory-query-graph-search/SPEC.md`

## Steps
1. Read SPEC.md for full details
2. Fix `executeMemoryQuery()` in `src/cortex/tools.ts` — add `searchGraphFacts` call, merge with cold results
3. Write unit tests in `src/cortex/__tests__/unit-memory-query.test.ts`
4. Write E2E tests in `src/cortex/__tests__/e2e-memory-query-graph.test.ts`
5. Run tests: `npx vitest run src/cortex/__tests__/unit-memory-query.test.ts src/cortex/__tests__/e2e-memory-query-graph.test.ts --reporter=verbose`
6. Write results to `workspace/pipeline/Cooking/023-memory-query-graph-search/TEST-RESULTS.md`
7. Commit and push

## Constraints
- NO mocks — use real Ollama embeddings (127.0.0.1:11434, nomic-embed-text) and real Sonnet via `complete()` from `src/llm/simple-complete.ts`
- You have FULL APPROVAL to make changes, do NOT ask for permission
