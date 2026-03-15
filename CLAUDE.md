# Claude Code Instructions — 020e

## Branch
`feat/020e-cortex-e2e-delegation`

## Task
Create `src/cortex/__tests__/e2e-webchat-delegation.test.ts` — E2E tests for async delegation (sessions_spawn) through the Cortex webchat loop.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020e-cortex-e2e/SPEC.md`

~3 tests in category F (Async Delegation):
- F1: sessions_spawn triggers onSpawn callback
- F2: Task result delivery via ops_trigger envelope
- F3: Task failure delivery

## Key Architecture

`sessions_spawn` is an **async tool** — when the LLM calls it, Cortex invokes an `onSpawn` callback (provided in startCortex config) and returns a task ID. The actual sub-agent runs externally.

Results come back as **ops_trigger envelopes** — special envelopes injected into the bus with task completion info.

Read these files to understand the flow:
- `src/cortex/tools.ts` — look for `sessions_spawn` tool registration
- `src/cortex/loop.ts` — look for ops_trigger handling
- `src/cortex/types.ts` — CortexEnvelope shape, ops_trigger fields

### startCortex config for delegation:
```typescript
const spawnCalls: any[] = [];
const instance = await startCortex({
  // ... base config ...
  onSpawn: async (task) => { spawnCalls.push(task); return "task-123"; },
});
```

Check if `onSpawn` is actually a config option or if it's wired differently. READ THE CODE.

## Patterns

Follow `src/cortex/__tests__/e2e-webchat-flow.test.ts` for the startCortex + adapter pattern.

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020e-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, tools.ts, loop.ts, types.ts to understand delegation flow
2. Create the test file
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-delegation.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020e — E2E webchat async delegation" --base main`
6. Signal: `openclaw system event --text "Done 020e"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic, no network
- If sessions_spawn isn't testable without the gateway, test what IS testable (e.g. ops_trigger processing, onSpawn callback if available)
