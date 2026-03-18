# CLAUDE.md — 025f Gateway Audio Wiring

## Branch
`feat/025f-gateway-audio-wiring`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Build

Wire the existing audio modules into the running OpenClaw gateway. Read `SPEC.md` in this folder for full details.

**Summary of changes:**

1. **Refactor `src/audio/ingest.ts`** — export a `handleAudioHttpRequest(req, res, deps)` handler function (return `true` if handled, `false` otherwise). Keep the standalone `createServer` as a fallback export.

2. **Mount in `src/gateway/server-http.ts`** — add the audio handler to the HTTP request chain. Place it after plugin routes, before OpenAI/canvas. Gate on `audio.enabled` config.

3. **Add `audio` config to `openclaw.json`** — add the config block with `enabled: false` (safe default). See SPEC.md for schema.

4. **Init at startup** — in gateway startup, when `audio.enabled`:
   - Call `initAudioSessionTable(db)` 
   - Create data dirs (`data/audio/{inbox,processed,transcripts}`)

5. **Wire worker → Hippocampus** — ensure `ingest-transcript.ts` receives proper `IngestionDeps`:
   - `libraryDb` from gateway context
   - `busDb` from gateway context  
   - `extractLLM` wired to `src/llm/simple-complete.ts`

6. **Wire session-end → worker** — `POST /audio/session-end` must call `worker.runTranscriptionPipeline()` with correct deps.

## Constraints

- **TypeScript only** — no new dependencies unless absolutely necessary
- **Do NOT modify** `wav-utils.ts`, `transcribe.ts`, or `session-store.ts` — they're complete
- **Do NOT break existing tests** — run `npx vitest run src/audio/` before committing
- **Do NOT create a separate HTTP server** — mount on the existing gateway server
- **Follow existing patterns** — look at how `handleSlackHttpRequest` and `handlePluginRequest` are wired in `server-http.ts`
- **All work inside `C:\Users\Temp User\.openclaw`**

## Working Directory

`C:\Users\Temp User\.openclaw`

## Git Workflow

```powershell
git checkout -b feat/025f-gateway-audio-wiring
# ... make changes ...
git add -A
git commit -m "025f: <description>"
# repeat per milestone
git checkout main
git merge feat/025f-gateway-audio-wiring
git push
```

## State Updates

After each milestone, update `workspace/pipeline/InProgress/025f-gateway-audio-wiring/STATE.md` with:
- What's done
- What's next
- Any errors encountered
- Test results

## Test Commands

```powershell
npx vitest run src/audio/
npx vitest run src/gateway/ --reporter=verbose
```

Existing audio tests (50 total) must continue to pass. New tests are welcome.

## Done Criteria

- Audio handler mounted on gateway HTTP server
- `openclaw.json` has `audio` config block
- Session table init'd at startup when enabled
- Session-end triggers worker which triggers Hippocampus ingestion
- All existing tests pass
- New integration tests for the wiring
- All committed to branch, merged to main, pushed
- `STATE.md` shows `STATUS: COMPLETE`

## If Something Fails

- Document the failure in STATE.md
- Try an alternative approach
- If stuck after 2 attempts, write `STATUS: BLOCKED` in STATE.md with details
