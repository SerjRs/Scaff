# CLAUDE.md — 040 Ingest Test Modernization

## Branch
`feat/040-ingest-test-modernization`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

`ingest.test.ts` was written against the old API contract. It uses field name "file" but the Rust client sends "audio". It uses `makeWavData()` which returns `Buffer.alloc(sizeBytes, 0x42)` — not a valid WAV. It uses `createTestServer()` (test helper) instead of `createGatewayAudioHandler()` (production). No test verifies session-end triggers transcription.

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/040-ingest-test-modernization/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/040-ingest-test-modernization/SPEC.md` — spec
3. `src/audio/__tests__/ingest.test.ts` — existing tests to modernize
4. `src/audio/ingest.ts` — production handler, createGatewayAudioHandler, multipart parsing
5. `src/audio/session-store.ts` — session DB operations
6. `src/audio/worker.ts` — WorkerDeps, transcribeSession
7. `src/audio/types.ts` — AudioCaptureConfig
8. `src/audio/wav-utils.ts` — buildWav for creating valid WAV data
9. `tools/cortex-audio/shipper/src/upload.rs` — what the Rust client actually sends (field names, content types)

## Step 2 — Modernize ingest.test.ts

Do NOT delete and rewrite from scratch — the existing tests have good coverage for auth, validation, concurrent sessions. Instead, modernize them:

### Change 1: Update buildMultipart to use "audio" field name
- Find `buildMultipart()` or equivalent helper
- Change file field name from "file" to "audio" (matching Rust client)
- Add a separate backward-compat test that verifies "file" still works with a comment marking it deprecated

### Change 2: Use valid WAV headers in test data
- Find `makeWavData()` or equivalent
- Replace `Buffer.alloc(sizeBytes, 0x42)` with actual WAV data using `buildWav()` from `wav-utils.ts`
- Create a helper like:
  ```typescript
  function makeValidWav(durationMs = 100): Buffer {
    const sampleRate = 16000;
    const frames = Math.ceil(sampleRate * durationMs / 1000);
    const pcm = Buffer.alloc(frames * 2); // mono 16-bit silence
    return buildWav(pcm, 1, sampleRate, 16);
  }
  ```

### Change 3: Add session-end triggers transcription test
- Upload chunks, send session-end
- Verify transcription is triggered (session status changes to pending_transcription or transcribing)
- This tests the fire-and-forget path that was never tested

### Change 4: Test via createGatewayAudioHandler
- Add at least one test that uses `createGatewayAudioHandler()` (the production factory) instead of `createTestServer()`
- Verify it behaves the same way
- If createTestServer is a wrapper around createGatewayAudioHandler, document that relationship

### Change 5: Verify chunk storage format
- Upload a chunk with sequence 0
- Assert it is stored as `chunk-0000.wav`
- Assert the stored file contains valid WAV data (starts with RIFF header)

### Change 6: Add "audio" field as primary, "file" as deprecated
- New test: upload with "audio" field name, assert success
- New test: upload with "file" field name, assert success with comment "deprecated backward compat"
- If any test uses "file", add a comment explaining this is legacy

## Step 3 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass.

## Step 4 — Commit, merge, push

```powershell
git checkout -b feat/040-ingest-test-modernization
git add src/audio/__tests__/ingest.test.ts
# Add any source files you fixed
git commit -m "040: modernize ingest tests — use audio field name, valid WAV, session-end trigger"
git checkout main
git merge feat/040-ingest-test-modernization --no-edit
git push
```

Do NOT `git add -A`.

## Step 5 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT delete well-tested auth/validation tests** — modernize them
- **Do NOT patch environment variables**
- **DO fix source code if you find bugs** — document in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Field name "audio" used as primary in all tests
- "file" backward compat has explicit test with deprecation comment
- Valid WAV headers in all test data
- Session-end triggers transcription tested
- At least one test uses createGatewayAudioHandler (production factory)
- Chunk stored as chunk-0000.wav with valid WAV verified
- All tests pass
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
