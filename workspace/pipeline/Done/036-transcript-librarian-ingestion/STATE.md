# STATE — 036 Transcript Librarian Ingestion

## Status: DONE

## Completed: 2026-03-19

## Changes Made

### Change 1: `src/audio/worker.ts`
- Removed `ingestion?: IngestionDeps` from `WorkerDeps`
- Added `onIngest?: (librarianPrompt: string, sessionId: string) => void | Promise<void>`
- Removed `WorkerResult.ingestion` field
- After successful transcription: truncates fullText to 50K chars, builds Librarian prompt, calls `onIngest`
- Imports `buildLibrarianPrompt` from `../library/librarian-prompt.js`
- Imports `Transcript` from `./types.js` (moved from deleted file)

### Change 2: `src/library/librarian-prompt.ts`
- Added `"transcript"` to the `content_type` enum
- Added detection for `audio-capture://` URLs with transcript-specific extraction guidance (action items, decisions, key quotes, participants, deadlines)

### Change 3: `src/gateway/server-audio.ts`
- Removed all `ingestionDeps` related code (imports, interface field, conditional wiring, `complete()` import)
- Built `onIngest` callback using lazy singleton resolution:
  - `getGatewayCortex()` → cortexDb
  - `getGatewayRouter()` → enqueue
  - `getCortexSessionKey("main")` → issuer
- `storeDispatch(cortexDb, { taskId, channel: null, ... })` — null channel for system-initiated tasks
- `storeLibraryTaskMeta(cortexDb, taskId, url)` — links taskId to `audio-capture://{sessionId}`
- `router.enqueue("agent_run", ...)` — spawns Librarian executor

### Change 4: `src/gateway/server.impl.ts`
- No changes needed — lazy singleton resolution in server-audio.ts means no params to pass

### Change 5: `src/cortex/gateway-bridge.ts`
- Added null-channel guard in Router result handler (onJobDelivered)
- When `dispatch?.channel` is null: Library DB writes proceed, dispatch lifecycle updated, skip `appendTaskResult` + ops-trigger, log success
- When channel is non-null: existing behavior unchanged

### Change 6: Dead code cleanup
- Moved `Transcript` interface from `ingest-transcript.ts` to `src/audio/types.ts`
- Deleted `src/audio/ingest-transcript.ts`
- Updated imports in `worker.ts`, `whisper-e2e.test.ts`, `real-e2e.test.ts`

### Supporting change: `src/cortex/session.ts`
- `TaskDispatch.channel`: `string` → `string | null`
- `storeDispatch` `channel` param: `string` → `string | null`

## Tests

### New tests: `src/audio/__tests__/librarian-ingestion.test.ts` (5 tests)
1. `buildLibrarianPrompt` includes transcript guidance for `audio-capture://` URLs
2. `buildLibrarianPrompt` does NOT include transcript guidance for regular URLs
3. onIngest called with correct prompt and sessionId
4. fullText truncated to 50K chars with [TRUNCATED] marker
5. `buildLibrarianPrompt` preserves content within 50K

### Updated tests
- `whisper-e2e.test.ts`: Replaced ingestion test with onIngest callback test
- `real-e2e.test.ts`: Replaced Library/Hippocampus DB assertions with onIngest callback assertions

### Test results
- `src/audio/`: 72 passed, 8 skipped (Whisper-dependent e2e)
- `src/cortex/`: All delegation/webchat/sharding/library tests pass. Pre-existing failures in gardener-shards, read-file, compressed-reference-loop unrelated to this change.

## Commit
- `1eda73d57` on `main` — merged from `feat/036-transcript-librarian-ingestion`
- Pushed to origin
