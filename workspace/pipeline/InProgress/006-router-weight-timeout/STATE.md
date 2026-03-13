# STATE — Task 006

## Status: COMPLETE

## Completed
1. [x] `src/router/types.ts` — Added `ExecutorOptions` interface (weight, signal)
2. [x] `src/router/worker.ts` — Updated `AgentExecutor` type to accept `ExecutorOptions`, `run()` accepts and passes `weight`
3. [x] `src/router/gateway-integration.ts` — Added `weightToTimeoutMs()` helper, dynamic `timeoutMs` in `createGatewayExecutor()`
4. [x] `src/router/dispatcher.ts` — Passes `weight` to `run()`
5. [x] `src/router/loop.ts` — Weight-aware watchdog: `hungThresholdForWeight()`, per-job threshold filtering
6. [x] `src/router/queue.ts` — Added `getInExecutionJobs()` for weight-aware watchdog
7. [x] Tests — All new and updated tests pass (218/218 passing, 8 pre-existing failures unrelated)

## Tests Added/Updated
- [x] New: `src/router/__tests__/weight-timeout.test.ts` — unit tests for `weightToTimeoutMs` and `hungThresholdForWeight`
- [x] Updated: `worker.test.ts` — tests for weight passthrough in options
- [x] Updated: `dispatcher.test.ts` — tests for weight passthrough to run()
- [x] Updated: `loop.test.ts` — weight-aware watchdog tests (light/medium/heavy)
- [x] Updated: `gateway-integration.test.ts` — timeout tests for different weight tiers

## Branch
`feat/router-weight-timeout` — 6 commits, ready for push/PR.

## Next Step
Push branch, create PR, merge.
