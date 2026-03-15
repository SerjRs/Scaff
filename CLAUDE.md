# Claude Code Instructions — 020g

## Branch
`feat/020g-cortex-e2e-recovery`

## Task
Create `src/cortex/__tests__/e2e-webchat-recovery.test.ts` — E2E tests for Cortex recovery and error handling through webchat.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020g-cortex-e2e/SPEC.md`

~4 tests in category H (Recovery & Error Handling):
- H1: LLM call failure → message marked failed
- H2: Adapter send failure → error logged, loop continues
- H3: Queue ordering preserved on failure
- H4: Idempotent message processing (same envelope_id not processed twice)

## Key Approach

- **H1**: Mock `callLLM` that throws → check message status in bus DB
- **H2**: Adapter with `send()` that throws → send another message after, verify it still processes
- **H3**: First message's LLM throws, messages 2+3 should still process normally
- **H4**: Enqueue same envelope twice (same ID) → verify only 1 processed

Read `src/cortex/loop.ts` and `src/cortex/bus.ts` to understand error handling flow and message status tracking.

## Patterns

Follow `src/cortex/__tests__/e2e-webchat-flow.test.ts` for the startCortex + adapter pattern.
Also check `src/cortex/__tests__/e2e-recovery.test.ts` if it exists for additional patterns.

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020g-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, loop.ts, bus.ts, existing recovery tests
2. Create the test file
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-recovery.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020g — E2E webchat recovery & error handling" --base main`
6. Signal: `openclaw system event --text "Done 020g"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic, no network
