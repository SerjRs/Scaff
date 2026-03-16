# Claude Code Instructions — 019a

## Branch
`feat/019a-schema-storage-tests`

## Task
Read `workspace/pipeline/InProgress/019a-schema-storage-tests/SPEC.md` and implement everything.

## State Saving — MANDATORY
After EVERY significant action (file read, edit, test run), update your state in:
`workspace/pipeline/InProgress/019a-schema-storage-tests/STATE.md`

Format:
```markdown
# 019a State

## Status: [working|blocked|done]
## Last Action: [what you just did]
## Files Changed: [list]
## Tests Run: [pass/fail count]
## Next Step: [what to do next]
## Errors: [any errors encountered]
```

This is critical — if you crash, the next spawn reads STATE.md to continue from where you left off.

## Steps
1. Read SPEC.md
2. Read current `src/cortex/__tests__/helpers/hippo-test-utils.ts`
3. Read Category A tests in `src/cortex/__tests__/e2e-hippocampus-full.test.ts` (lines ~145-310)
4. Update `hippo-test-utils.ts` — replace mock exports with real embedFn + extractLLM
5. Update Category A tests — use real embeddings
6. Run: `npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts -t "A\." --reporter=verbose`
7. Write results to STATE.md
8. If all pass: `git add -A && git commit -m "test(019a): replace mocks with real Ollama embeddings — Category A"`
9. If any fail: write failures to STATE.md, do NOT commit

## Constraints
- NO mocks — real Ollama (127.0.0.1:11434) + real Sonnet (via complete())
- Only touch Category A tests + helpers
- You have FULL APPROVAL — do not ask for permission
- Save state to STATE.md after every action
