# Claude Code Instructions — 019b

## How to Find Your Task
1. You are on branch `feat/019b-fact-extraction-tests`
2. Read `workspace/pipeline/InProgress/019b-fact-extraction-tests/SPEC.md`

## State Saving — MANDATORY
After EVERY significant action, update:
`workspace/pipeline/InProgress/019b-fact-extraction-tests/STATE.md`

Format:
```markdown
# 019b State

## Status: [working|blocked|done]
## Last Action: [what you just did]
## Files Changed: [list]
## Tests Run: [pass/fail count]
## Next Step: [what to do next]
## Errors: [any errors encountered]
```

## Steps
1. Read SPEC.md for full details
2. Read Category B tests in `src/cortex/__tests__/e2e-hippocampus-full.test.ts` (lines ~315-568)
3. Replace mockLLM/mockExtractLLM with real Sonnet via `complete()` from `src/llm/simple-complete.ts`
4. Replace any remaining mockEmbedFn with real Ollama (check helpers/hippo-test-utils.ts — may already be updated from 019a)
5. Handle B3 (malformed LLM output) — real LLM won't return garbage, rethink this test
6. Run ONLY Category B: `npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts -t "B\." --reporter=verbose`
7. Write results to STATE.md
8. If all pass: `git add -A && git commit -m "test(019b): replace mocks with real Sonnet + Ollama — Category B"`
9. If any fail: write failures to STATE.md, try to fix, re-run

## Constraints
- NO mocks — real Sonnet (via complete()), real Ollama embeddings
- Only touch Category B tests + helpers if needed
- You have FULL APPROVAL — do not ask for permission
- Increase test timeouts to 30000ms+ for real API calls
