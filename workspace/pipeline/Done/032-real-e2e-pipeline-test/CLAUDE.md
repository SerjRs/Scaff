# CLAUDE.md — 032 Real E2E Pipeline Test (Rewrite)

## Branch
`feat/032-real-e2e-rewrite`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

You are rewriting the "Real E2E" pipeline test. The existing test claims "NO MOCKS" but mocks: the Rust client, the environment, the gateway init, and the ingestion pipeline. Every integration boundary is bypassed. All 5 production bugs were in the untested boundaries.

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/032-real-e2e-pipeline-test/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/032-real-e2e-pipeline-test/SPEC.md` — spec with post-mortem and revision comments
3. `src/audio/__tests__/real-e2e.test.ts` — existing tests to rewrite
4. `src/audio/worker.ts` — transcription worker with onIngest callback
5. `src/audio/ingest.ts` — HTTP chunk handler + createGatewayAudioHandler
6. `src/gateway/server-audio.ts` — initGatewayAudioCapture (was NEVER tested by old e2e)
7. `src/audio/transcribe.ts` — Whisper wrapper (now handles PATH itself)
8. `src/audio/session-store.ts` — session DB
9. `src/audio/types.ts` — types including Transcript
10. `src/library/librarian-prompt.ts` — librarian prompt builder
11. `tools/cortex-audio/fixtures/` — speech WAV fixture

## Step 2 — Rewrite real-e2e.test.ts

Delete the entire content and rewrite from scratch.

### Rules:
- **NO environment patching.** Do NOT add ffmpeg to PATH. Do NOT set PYTHONIOENCODING. Production code handles this.
- **CI-aware skip guard** — fail loudly on CI if whisper missing, warn locally
- **Use initGatewayAudioCapture()** — not createGatewayAudioHandler with hand-crafted deps. Test the real init function that production uses.
- **Sequence starts at 0** — match the capture engine
- **Use field name "audio"** — match the Rust client, not the old "file" name
- **Multipart format must match Rust client** — same field names, same content types
- **Honest naming** — if this test still uses TypeScript HTTP client instead of Rust binary, name it "Server-side E2E" not "Real E2E". Only call it "Real E2E" if the Rust binary is actually involved.

### Tests to write:

#### Test 1: `server-side E2E: chunks upload + whisper + transcript`
- Call initGatewayAudioCapture() with production-like config to get the handler
- Start a real HTTP server using the returned handler
- Split speech fixture into 3 chunks (chunk-0000, chunk-0001, chunk-0002)
- Upload via multipart matching Rust client format (field: "audio", sequences 0,1,2)
- Send session-end
- Poll session status until done or failed (timeout 120s)
- Assert: session status = "done"
- Assert: chunks_received = 3
- Assert: transcript JSON exists in transcripts dir
- Assert: transcript.fullText contains English words from the fixture
- Assert: transcript.segments is non-empty with valid timestamps
- Assert: audio files moved from inbox to processed

#### Test 2: `onIngest callback fires after successful transcription`
- Same setup as Test 1 but verify the onIngest callback
- Since initGatewayAudioCapture wires onIngest via lazy Cortex/Router imports which may not be available in test, provide a way to intercept/verify the callback fires
- At minimum: verify workerDeps has onIngest defined after init
- If possible: mock the lazy imports (Cortex/Router) with stubs and verify onIngest calls storeDispatch + storeLibraryTaskMeta + spawn

#### Test 3: `session-end right after last chunk — no lost data`
- Upload 3 chunks with minimal delay
- Send session-end immediately after last chunk (no wait)
- Assert: all 3 chunks received, session completes successfully
- Tests the fire-and-forget timing edge case

#### Test 4: `single chunk session works`
- Upload 1 chunk only (chunk-0000)
- Send session-end
- Assert: transcription succeeds with 1 chunk

#### Test 5: `missing chunk 0 fails with clear error`
- Upload chunks 1 and 2 only (skip 0)
- Send session-end
- Assert: session fails with error mentioning missing chunk 0

#### Test 6: `initGatewayAudioCapture wires workerDeps correctly`
- Call initGatewayAudioCapture() with valid config
- Verify the returned handle has: handler (function), db (open), config (enabled)
- Upload a chunk + session-end through the handler
- Verify transcription is triggered (session status changes from pending)
- This is the test that would have caught bug #5

## Step 3 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass. The real-e2e tests must actually RUN (not skip) on this machine.

## Step 4 — Commit, merge, push

```powershell
git checkout -b feat/032-real-e2e-rewrite
git add src/audio/__tests__/real-e2e.test.ts
# Add any source files you had to fix
git commit -m "032: rewrite server-side E2E tests — real gateway init, no env patching, 0-based sequences"
git checkout main
git merge feat/032-real-e2e-rewrite --no-edit
git push
```

Do NOT `git add -A`.

## Step 5 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT patch PATH or PYTHONIOENCODING in test files**
- **Do NOT construct WorkerDeps manually** — use initGatewayAudioCapture or at minimum createGatewayAudioHandler with production config loading
- **Do NOT use sequence 1 as first chunk**
- **Do NOT use field name "file"** for new tests (add one backward compat test if you want)
- **DO fix source code if you find bugs** — document in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- real-e2e.test.ts rewritten with honest naming and real gateway init
- initGatewayAudioCapture() exercised in at least one test
- No environment patching in test files
- Sequences start at 0
- Multipart matches Rust client format
- onIngest callback verified
- All tests pass, 0 skipped when whisper available
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If initGatewayAudioCapture needs deps you cannot provide in test (like Cortex DB), test as much as you can and document the gap
