# Claude Code — 009 Sync Tool Awareness + Pipeline Completion

## Branch
`feat/009-cortex-sync-tools-pipeline`

## What to do
Read `SPEC.md` for the full context. Two changes:

### Change 1: Sync tool guidance in system prompt (llm-caller.ts)

Find where the system message is built in `src/cortex/llm-caller.ts`. Add a "Tool Usage" section that clearly distinguishes sync tools (instant, local) from async tools (sessions_spawn, executor). Use the exact text from SPEC.md Issue #39.

### Change 2: Pipeline review checklist injection

When a completed task result arrives via ops-trigger, detect if it's a pipeline task and append a review checklist to the content.

**Where to inject:** In `src/cortex/gateway-bridge.ts` inside the `appendTaskResult` call (or nearby), OR in `src/cortex/loop.ts` where `appendedContent` is built for ops-triggers.

**Detection:** Check if the task description/summary contains `pipeline/InProgress/` or references `CLAUDE.md`/`SPEC.md`/`STATE.md`.

**What to append:**
```
[PIPELINE REVIEW REQUIRED]
The executor reports success. Before replying to the user, complete each step:
1. Review: did the build pass? Check result for errors.
2. Merge: if PR was created, merge it (gh pr merge <number> --squash)
3. Move: move task folder from InProgress → Done (use move_file)
4. Update STATE.md with final status
5. Inform the user: what was done, PR link, merged status
```

Also add a brief note in the system prompt: "When a pipeline task completes, a review checklist will be injected with the result. Follow it before replying to the user."

## Constraints
- Only modify: `src/cortex/llm-caller.ts`, `src/cortex/gateway-bridge.ts` or `src/cortex/loop.ts`
- Do NOT change session.ts, output.ts, adapters, or router code
- `pnpm build` must pass
- Commit incrementally, push to branch

## Notify on completion
```
openclaw system event --text "Done: 009 sync tool awareness + pipeline completion" --mode now
```
