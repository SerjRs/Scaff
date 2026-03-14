## What

Cortex now owns its dispatch context. The execution pipeline is stateless. Results correlate back by taskId.

## Why

Async task results were silently dropped on WhatsApp — the `threadId` (chatId) was lost as metadata was threaded through the execution pipeline (`loop → onSpawn → Router → ops-trigger → adapter`). The real problem was architectural: the pipeline carried conversation context that belongs to Cortex.

## Changes

- **New table:** `cortex_task_dispatch` replaces dead `cortex_pending_ops`
- **`channel_context` JSON blob:** stores channel-specific addressing attributes (threadId, accountId, etc.) — adding new channels requires zero schema changes
- **Store at spawn:** `storeDispatch()` captures full origin context (channel, addressing, counterpart, shard) when Cortex delegates work
- **Restore at result:** `getDispatch()` retrieves context when task completes, restoring the reply target
- **Stateless pipeline:** Router payload no longer carries `replyChannel` or addressing metadata
- **Fallback:** in-flight tasks (spawned before upgrade) fall back to legacy trigger metadata

## Files

- `src/cortex/session.ts` — schema, `storeDispatch`/`getDispatch`/`completeDispatch`
- `src/cortex/loop.ts` — dispatch at spawn, restore at ops-trigger
- `src/cortex/gateway-bridge.ts` — stripped pipeline metadata, lifecycle completion
- `src/cortex/__tests__/e2e-op-lifecycle.test.ts` — full lifecycle test suite

## Pipeline

`007-cortex-task-context-ownership` — spec + implementation docs in `workspace/pipeline/InProgress/`
