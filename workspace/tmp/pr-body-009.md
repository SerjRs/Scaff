## What

Two fixes for Cortex operational awareness:

1. **Sync vs async tool guidance** — system prompt now explicitly distinguishes sync tools (instant, local) from `sessions_spawn` (async, expensive). Prevents Cortex from dispatching executors for file moves.

2. **Pipeline review checklist injection** — when a pipeline task completes, a `[PIPELINE REVIEW REQUIRED]` checklist is appended to the result. Cortex must merge PR, move to Done, update STATE.md before replying.

## Why

- Cortex used `sessions_spawn` to `mv` a folder (30s executor dispatch for a sync tool operation)
- Cortex completed a pipeline task but never merged the PR or moved to Done

## Files

- `src/cortex/llm-caller.ts` — sync/async tool guidance + pipeline awareness in system prompt
- `src/cortex/gateway-bridge.ts` — pipeline task detection + review checklist injection on completion
