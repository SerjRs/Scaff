# Claude Code — 007 Task Dispatch Context

## Branch
`feat/007-task-dispatch-context`

## What to do
Read `SPEC.md` for architecture, `IMPLEMENTATION.md` for exact code changes. Check `STATE.md` for current progress — resume from where it left off.

## Constraints
- Do NOT modify `src/cortex/output.ts`, `src/cortex/adapters/`, or `src/router/`
- Keep `taskResult`/`taskDescription`/`taskStatus` in ops-trigger metadata (loop still uses them)
- Keep `replyChannel` in trigger metadata as fallback for in-flight tasks
- TypeScript strict mode — `pnpm build` must pass with zero errors

## Workflow
1. Read STATE.md to know where you are
2. Implement changes per IMPLEMENTATION.md
3. Run `pnpm build` — fix any errors
4. Commit incrementally after each file/phase
5. Update STATE.md after each milestone
6. When done: push branch, update STATE.md to "complete"

## Notify on completion
```
openclaw system event --text "Done: 007 task dispatch context implemented" --mode now
```
