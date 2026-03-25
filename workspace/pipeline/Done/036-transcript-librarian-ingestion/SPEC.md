---
id: "036"
title: "Route audio transcripts through the Librarian for ingestion"
priority: high
created: 2026-03-19
author: scaff
type: feature
branch: feat/036-transcript-librarian-ingestion
tech: typescript
---

# 036 — Transcript Librarian Ingestion

## Problem

After audio transcription completes, the transcript JSON is saved to disk but never ingested into Library or Hippocampus. The existing `ingest-transcript.ts` tried to do this directly by wiring up DB refs and calling `insertItem()` / `insertFact()`, but:

1. The gateway never passed `ingestionDeps` — so ingestion was silently skipped
2. Direct DB insertion couples the audio pipeline to the current Hippocampus schema
3. If we evolve the Hippocampus architecture, we'd need to fix it in the audio code too

## Solution

Route transcripts through the **existing Librarian pipeline** — the same path used when a user sends a URL to Cortex. The Librarian executor (cheap model via Router) handles summarization, fact extraction, and storage. The audio pipeline doesn't need to know about Library/Hippocampus internals.

## Architecture

### Current Librarian flow (URL ingestion via `library_ingest` tool):

```
1. LLM calls library_ingest(url)
2. loop.ts fetches content from URL
3. buildLibrarianPrompt(url, content) → structured prompt
4. storeDispatch() — saves channel/shard/envelope context for result delivery
5. storeLibraryTaskMeta() — links taskId to URL
6. Spawn Router executor with prompt
7. Executor returns JSON (title, summary, facts, edges, etc.)
8. Cortex ops-trigger receives result → looks up dispatch + library meta
9. Ops-trigger parses JSON → insertItem() + insertEmbedding() + insertFact() + insertEdge()
10. Notification appended to conversation shard
```

**Critical detail:** Steps 4-5 are what enable step 8-10. Without dispatch context and library task metadata, the ops-trigger handler doesn't know the result is a Library task and can't process it.

### New flow (audio transcript ingestion):

```
1. transcribeSession() completes → transcript JSON on disk
2. Worker truncates fullText to 50K chars (same limit as URL ingestion)
3. Worker calls onIngest(prompt, sessionId) callback
4. Gateway callback:
   a. Generates taskId
   b. storeDispatch() with channel=null (no user conversation to notify)
   c. storeLibraryTaskMeta(taskId, "audio-capture://{sessionId}")
   d. Spawns Router executor with Librarian prompt
5. Executor returns JSON → Router pushes to Cortex
6. Ops-trigger receives result → finds library meta → parses JSON → writes to Library + Hippocampus
7. channel=null → skip user notification (just log success)
```

The transcript feeds into the **same front door** as URLs. The Librarian doesn't know or care that it came from audio.

### Result delivery (ops-trigger)

The ops-trigger handler in `loop.ts` processes executor results. It currently requires dispatch context with a valid channel to deliver notifications. For audio ingestion:

- `storeDispatch()` is called with `channel: null` — marks this as a system-initiated task
- The ops-trigger handler must check for `channel === null` and skip the shard append / user notification step
- The Library DB writes (parse JSON → `insertItem()` etc.) proceed normally regardless of channel

This is the smallest change to the existing pipeline — one null check in the ops-trigger handler.

### Dedup

`audio-capture://{sessionId}` URLs are naturally unique per session. The Library's `UNIQUE(url)` constraint handles re-ingestion via upsert with version increment. No additional dedup logic needed.

## Implementation

### Change 1: `src/audio/worker.ts` — WorkerDeps + onIngest

Update `WorkerDeps`:

```typescript
export interface WorkerDeps {
  sessionDb: DatabaseSync;
  /** Called after transcription to trigger Librarian ingestion via Router. */
  onIngest?: (librarianPrompt: string, sessionId: string) => void | Promise<void>;
}
```

Remove the `ingestion?: IngestionDeps` field entirely.

After successful transcription (step 9), before returning `WorkerResult`:

1. Skip if `fullText` is empty (silence-only recording)
2. Truncate `fullText` to 50K chars if needed
3. Build the prompt: `buildLibrarianPrompt("audio-capture://{sessionId}", fullText)`
4. `await onIngest?.(prompt, sessionId)`

Import `buildLibrarianPrompt` from `../library/librarian-prompt.js`.

### Change 2: `src/library/librarian-prompt.ts` — transcript awareness

Add `"transcript"` to the `content_type` enum in the prompt. Add a paragraph that detects `audio-capture://` URLs and instructs the Librarian to focus on:
- Action items and decisions
- Key quotes and statements
- Participants mentioned
- Deadlines and commitments

Rather than the default "article insights" guidance. This keeps one prompt file but adapts behavior based on source type.

### Change 3: `src/gateway/server-audio.ts` — wire the callback

Add a new option to `initGatewayAudioCapture()`:

```typescript
export function initGatewayAudioCapture(opts: {
  audioCaptureConfig?: Partial<AudioCaptureConfig>;
  stateDir: string;
  cortexDb?: DatabaseSync;  // for storeDispatch + storeLibraryTaskMeta
  onSpawn?: (params: { task: string; taskId: string; resultPriority: string }) => string | undefined;
  log: { ... };
}): AudioCaptureHandle | null
```

Build the `onIngest` callback that:
1. Generates a `taskId` via `crypto.randomUUID()`
2. Calls `storeDispatch(cortexDb, { taskId, channel: null, ... })` — no channel, no shard, no envelope
3. Calls `storeLibraryTaskMeta(cortexDb, taskId, "audio-capture://{sessionId}")`
4. Calls `onSpawn({ task: prompt, taskId, resultPriority: "normal" })`
5. If spawn returns undefined, logs a warning but doesn't fail

Remove all `ingestionDeps` related code:
- Remove `IngestionDeps` import
- Remove `ingestionDeps` from opts interface
- Remove conditional `workerDeps.ingestion` wiring
- Remove `complete()` import

### Change 4: `src/gateway/server.impl.ts` — pass cortexDb + onSpawn

Pass the Cortex bus database and Router spawn function:

```typescript
audioCaptureHandle = initGatewayAudioCapture({
  audioCaptureConfig: cfgAtStart.audioCapture,
  stateDir: defaultWorkspaceDir,
  cortexDb: cortexBusDb,    // the bus.sqlite database ref
  onSpawn: (params) => {    // same Router spawn used by Cortex
    return router.spawn(params);
  },
  log,
});
```

The exact references (`cortexBusDb`, `router.spawn`) need to be discovered from `server.impl.ts` — look for how the Cortex loop and Router are initialized and use the same refs.

### Change 5: `src/cortex/loop.ts` — handle channel=null in ops-trigger

In the ops-trigger handler that processes Library task results:
- After parsing JSON and writing to Library DB (insertItem, insertFact, insertEdge)
- Check if dispatch context has `channel === null`
- If null: log success to gateway logger, skip shard append and user notification
- If non-null: existing behavior (append to shard, notify user)

### Change 6: Clean up dead code

- Move `Transcript` type from `ingest-transcript.ts` to `src/audio/types.ts`
- Delete `src/audio/ingest-transcript.ts`
- Remove `WorkerResult.ingestion` field (no longer relevant)
- Update any imports

## Edge Cases

- **Router not available:** If `onSpawn` returns `undefined`, log a warning but don't fail the transcription. The transcript JSON is on disk — can be manually ingested later.
- **Empty transcript:** If `fullText` is empty (silence only), skip `onIngest` entirely. Don't create a Library item for silence.
- **Transcript > 50K chars:** Truncate to 50K with `[TRUNCATED]` marker before building the Librarian prompt. Same limit as URL ingestion. A 60-min meeting at ~150 wpm ≈ 45K chars, so most meetings fit.
- **Cortex DB not available:** If `cortexDb` is not passed (optional), `onIngest` is not wired. Transcription still works — just no ingestion. Same graceful degradation as current behavior.
- **Executor fails:** Router handles retries. If the executor ultimately fails, the Library task is marked failed. The transcript JSON on disk is unaffected — can be retried.

## Tests

1. Unit: `onIngest` callback is called after successful transcription with correct prompt and sessionId
2. Unit: `onIngest` is NOT called when transcription fails
3. Unit: `onIngest` is NOT called when transcript `fullText` is empty
4. Unit: `fullText` is truncated to 50K chars before building prompt
5. Unit: `buildLibrarianPrompt` with `audio-capture://` URL includes transcript-specific extraction guidance
6. Integration: worker completes → `storeDispatch()` called with `channel: null` → `storeLibraryTaskMeta()` called with correct `audio-capture://` URL
7. Unit: ops-trigger with `channel === null` dispatch context processes Library result without attempting user notification

## Done Criteria

- Successful transcription triggers Librarian ingestion via Router
- Transcript appears in Library as an article after executor completes
- Facts extracted by Librarian appear in Hippocampus
- No direct Library/Hippocampus DB access from audio pipeline code
- `ingest-transcript.ts` deleted, `Transcript` type moved to `types.ts`
- `ingestionDeps` removed from `server-audio.ts`
- Ops-trigger handles `channel: null` gracefully (no notification, no crash)
- All existing audio tests pass
- New tests for ingestion callback + null-channel ops-trigger

## Architecture Review

**Reviewer:** Claude (senior architect review, 2026-03-19)
**Verdict:** Approved with changes (all incorporated above)

Key findings incorporated:
1. ✅ **Result delivery gap** — Added `storeDispatch(channel=null)` + `storeLibraryTaskMeta()` + ops-trigger null-channel handling (Change 3, 5)
2. ✅ **Librarian prompt fit** — Added transcript content_type + meeting-specific extraction guidance (Change 2)
3. ✅ **Transcript truncation** — 50K char limit applied before prompt building (Change 1)
4. ✅ **Callback async** — `onIngest` signature is `void | Promise<void>`, awaited in worker (Change 1)
5. ✅ **Transcript type** — Moved to `types.ts` before deleting `ingest-transcript.ts` (Change 6)
6. ✅ **Dedup** — Documented as solved by existing `UNIQUE(url)` constraint
