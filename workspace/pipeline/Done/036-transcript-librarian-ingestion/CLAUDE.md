# CLAUDE.md — 036 Transcript Librarian Ingestion

## Branch
`feat/036-transcript-librarian-ingestion`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Build

Route audio transcripts through the existing Librarian pipeline for ingestion into Library + Hippocampus. Read SPEC.md for full architecture and all 6 changes.

## Implementation Steps

### Step 1 — Read existing code

Read these files thoroughly before changing anything:
- `workspace/pipeline/InProgress/036-transcript-librarian-ingestion/SPEC.md` — the full spec
- `src/audio/worker.ts` — transcription orchestrator (Change 1)
- `src/audio/ingest-transcript.ts` — dead code to delete (Change 6), has Transcript type to move
- `src/audio/types.ts` — where Transcript type should move to
- `src/library/librarian-prompt.ts` — prompt builder (Change 2)
- `src/gateway/server-audio.ts` — audio gateway init (Change 3)
- `src/gateway/server.impl.ts` — gateway wiring (Change 4) — find cortexDb + router spawn refs
- `src/cortex/loop.ts` — ops-trigger handler (Change 5) — find where Library task results are processed, look for `getLibraryTaskMeta`, `storeDispatch`, channel handling
- `src/cortex/tools.ts` — library_ingest tool for reference
- `src/library/db.ts` — storeLibraryTaskMeta function

### Step 2 — Change 1: worker.ts

1. Remove `ingestion?: IngestionDeps` from `WorkerDeps`
2. Add `onIngest?: (librarianPrompt: string, sessionId: string) => void | Promise<void>` to `WorkerDeps`
3. Remove `WorkerResult.ingestion` field
4. After successful transcription (after writing transcript JSON, before returning):
   - Skip if `fullText` is empty
   - Truncate `fullText` to 50K chars if needed (append `[TRUNCATED]`)
   - Import and call `buildLibrarianPrompt("audio-capture://{sessionId}", truncatedText)`
   - `await deps.onIngest?.(prompt, sessionId)`
5. Remove imports from `ingest-transcript.ts`

### Step 3 — Change 6: Move Transcript type + delete dead code

1. Move `Transcript` interface from `ingest-transcript.ts` to `src/audio/types.ts`
2. Update imports in `worker.ts` to import `Transcript` from `./types.js`
3. Delete `src/audio/ingest-transcript.ts`
4. Update any other files that import from `ingest-transcript.ts`

### Step 4 — Change 2: librarian-prompt.ts

1. Add `"transcript"` to the `content_type` enum in the prompt
2. Add a paragraph that detects `audio-capture://` URLs:
   ```
   If the URL starts with "audio-capture://", this is a meeting transcript.
   Focus on: action items, decisions made, key quotes, participants mentioned,
   deadlines and commitments. Use content_type: "transcript".
   ```

### Step 5 — Change 3: server-audio.ts

1. Add `cortexDb?: DatabaseSync` and `onSpawn?` to the opts interface
2. Remove all `ingestionDeps` related code (imports, interface field, conditional wiring, `complete()` import)
3. Build the `onIngest` callback inside `initGatewayAudioCapture`:
   - Generate taskId via `crypto.randomUUID()`
   - Call `storeDispatch(cortexDb, { taskId, channel: null, ... })` — discover exact params from loop.ts
   - Call `storeLibraryTaskMeta(cortexDb, taskId, url)`
   - Call `onSpawn({ task: prompt, taskId, resultPriority: "normal" })`
   - If spawn returns undefined, log warning
4. Pass `onIngest` into `workerDeps`

### Step 6 — Change 4: server.impl.ts

1. Find where the Cortex bus database is opened (look for `bus.sqlite` or cortex DB init)
2. Find where the Router spawn function is created (look for `onSpawn` in cortex init)
3. Pass both to `initGatewayAudioCapture()`:
   ```typescript
   audioCaptureHandle = initGatewayAudioCapture({
     audioCaptureConfig: cfgAtStart.audioCapture,
     stateDir: defaultWorkspaceDir,
     cortexDb: <bus database ref>,
     onSpawn: <router spawn function>,
     log,
   });
   ```

### Step 7 — Change 5: loop.ts ops-trigger

1. Find the ops-trigger handler that processes Library task results (look for `getLibraryTaskMeta`)
2. After the handler parses JSON and writes to Library DB:
   - Check if dispatch context has `channel === null`
   - If null: log success, skip shard append and user notification
   - If non-null: existing behavior unchanged

### Step 8 — Tests

Write tests in `src/audio/__tests__/`:

1. `onIngest` called after successful transcription with correct prompt and sessionId
2. `onIngest` NOT called when transcription fails
3. `onIngest` NOT called when fullText is empty
4. fullText truncated to 50K chars before prompt
5. `buildLibrarianPrompt` with `audio-capture://` URL includes transcript guidance

Write test in `src/cortex/__tests__/` (or existing test file):

6. ops-trigger with channel=null dispatch processes Library result without notification

### Step 9 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
npx vitest run src/cortex/ 2>&1
npx vitest run src/library/ 2>&1
```

All existing + new tests must pass. If Whisper-dependent tests are skipped (no whisper on PATH), that's fine.

### Step 10 — Commit, merge, push

```powershell
git checkout -b feat/036-transcript-librarian-ingestion
git add src/audio/worker.ts src/audio/types.ts src/audio/ingest-transcript.ts src/library/librarian-prompt.ts src/gateway/server-audio.ts src/gateway/server.impl.ts src/cortex/loop.ts
git add src/audio/__tests__/ src/cortex/__tests__/
git commit -m "036: route transcripts through Librarian pipeline — no direct DB coupling"
git checkout main
git merge feat/036-transcript-librarian-ingestion --no-edit
git push
```

Only add the files you changed. Do NOT `git add -A`.

### Step 11 — Create STATE.md

Create `workspace/pipeline/InProgress/036-transcript-librarian-ingestion/STATE.md`.

## Constraints

- **Do NOT edit openclaw.json** — gateway auto-restarts on config changes
- **Do NOT modify** any Rust files
- **Do NOT `git add -A`** — only add files you changed
- **Do NOT create new database tables or schemas** — use existing Library + Hippocampus tables
- **Preserve all existing tests** — only add new ones
- **The `ingest-transcript.ts` file must be deleted** — move Transcript type to types.ts first

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Successful transcription triggers Librarian ingestion via Router spawn
- `storeDispatch(channel=null)` + `storeLibraryTaskMeta()` called correctly
- Ops-trigger handles null-channel dispatch (processes result, skips notification)
- Librarian prompt includes transcript-specific guidance for `audio-capture://` URLs
- `ingest-transcript.ts` deleted, Transcript type in types.ts
- `ingestionDeps` fully removed from server-audio.ts
- fullText truncated to 50K before prompt
- All existing + new tests pass
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If you can't find cortexDb or onSpawn refs in server.impl.ts, search the full src/gateway/ directory
- If storeDispatch requires fields you can't determine, check the function signature and pass reasonable defaults
