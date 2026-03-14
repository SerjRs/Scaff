# Claude Code — 008 Spread replyContext

## Branch
`feat/007-task-dispatch-context` (same branch as 007 — this is a follow-up fix on the same PR #6)

## What to do
Read `SPEC.md`. Small targeted change:

1. In `src/cortex/loop.ts`, find the two `channelContext: { threadId:..., accountId:..., messageId:... }` blocks (~lines 511 and 560)
2. Replace each with a spread of the full replyContext minus `channel`:
   ```typescript
   const { channel: _ch, ...channelAttrs } = msg.envelope.replyContext ?? { channel: msg.envelope.channel };
   ```
   Then use `channelAttrs` as `channelContext`.
3. Add the unit test to `src/cortex/__tests__/e2e-op-lifecycle.test.ts`
4. Create `src/cortex/__tests__/dispatch-context-spread.test.ts` with integration tests
5. Run `pnpm build` — must pass
6. Run `pnpm vitest run src/cortex/__tests__/dispatch-context-spread.test.ts` — must pass
7. Commit, push to `feat/007-task-dispatch-context`

## Constraints
- Only touch the files listed in SPEC.md
- Do NOT modify session.ts, gateway-bridge.ts, output.ts, or adapters
- TypeScript strict mode — `pnpm build` must pass

## Notify on completion
```
openclaw system event --text "Done: 008 replyContext spread fix" --mode now
```
