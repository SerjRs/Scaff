# STATE — Task 006

## Status: NOT STARTED

## Completed
(none)

## Next Step
1. Read SPEC.md
2. Create branch `feat/router-weight-timeout`
3. Start with `src/router/types.ts` — add ExecutorOptions interface

## Files to Modify
- [ ] `src/router/types.ts` — ExecutorOptions interface, update AgentExecutor type
- [ ] `src/router/gateway-integration.ts` — weightToTimeoutMs(), dynamic timeoutMs
- [ ] `src/router/worker.ts` — accept weight param, pass to executor
- [ ] `src/router/dispatcher.ts` — pass weight to run()
- [ ] `src/router/loop.ts` — weight-aware hung thresholds
- [ ] `src/router/queue.ts` — getInExecutionJobs() or update getHungJobs()

## Tests
- [ ] New: `src/router/__tests__/weight-timeout.test.ts`
- [ ] Update: `worker.test.ts`
- [ ] Update: `dispatcher.test.ts`
- [ ] Update: `loop.test.ts`
- [ ] Update: `gateway-integration.test.ts`

## Branch
Not yet created.
