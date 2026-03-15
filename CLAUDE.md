# Claude Code Instructions — 020f

## Branch
`feat/020f-cortex-e2e-sharding`

## Task
Create `src/cortex/__tests__/e2e-webchat-sharding.test.ts` — E2E tests for foreground sharding through the Cortex webchat loop.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020f-cortex-e2e/SPEC.md`

~3 tests in category G (Foreground Sharding):
- G1: Messages assigned to shards (cortex_shards table populated)
- G2: Shard boundary on token overflow (new shard created when budget exceeded)
- G3: Ops trigger assigned to correct shard

## Key Architecture

Foreground sharding groups messages into topic-based shards in `cortex_shards` table. Read:
- `src/cortex/shards.ts` — shard assignment, boundary detection
- `src/cortex/loop.ts` — how messages are assigned to shards during processing
- `src/cortex/index.ts` — how sharding is configured in startCortex

Check if there's a `foregroundSharding` or similar config option in startCortex. If sharding is always-on or controlled differently, adapt accordingly.

## Patterns

Follow `src/cortex/__tests__/e2e-webchat-flow.test.ts` for the startCortex + adapter pattern.

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020f-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, shards.ts, loop.ts, index.ts
2. Create the test file
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-sharding.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020f — E2E webchat foreground sharding" --base main`
6. Signal: `openclaw system event --text "Done 020f"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic, no network
- Temp dirs + temp DBs, cleanup in afterEach
