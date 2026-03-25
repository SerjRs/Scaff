# CLAUDE.md — 030 Whisper E2E Tests (Rewrite)

## Branch
`feat/030-whisper-e2e-rewrite`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

You are rewriting the Whisper E2E tests. The existing tests are garbage — they patch their own environment, skip silently when dependencies are missing, and test the worker with hand-crafted deps instead of testing the actual gateway code path. Read the full audit in `TESTS-REVISION-REPORT.md` in this folder before writing anything.

## Step 1 — Read everything

Read these files in order:
1. `workspace/pipeline/InProgress/030-whisper-e2e-tests/TESTS-REVISION-REPORT.md` — the full audit
2. `workspace/pipeline/InProgress/030-whisper-e2e-tests/SPEC.md` — the spec with revision comments
3. `src/audio/__tests__/whisper-e2e.test.ts` — the existing garbage tests
4. `src/audio/__tests__/transcribe.test.ts` — has tautological tests to delete
5. `src/audio/transcribe.ts` — production code (note: it now handles PATH + PYTHONIOENCODING itself)
6. `src/audio/worker.ts` — production worker with onIngest callback
7. `src/gateway/server-audio.ts` — initGatewayAudioCapture (the function that was NEVER tested)
8. `src/audio/types.ts` — Transcript type
9. `tools/cortex-audio/fixtures/` — speech WAV fixture

## Step 2 — Delete and rewrite whisper-e2e.test.ts

Delete the entire content of `src/audio/__tests__/whisper-e2e.test.ts` and rewrite from scratch.

### Rules:
- **NO environment patching.** Do NOT add ffmpeg to PATH. Do NOT set PYTHONIOENCODING. The production code in `transcribe.ts` handles this. If the test can't find whisper without patching, the test should FAIL.
- **NO skip guards that silently pass.** Use this pattern instead:
  ```typescript
  let whisperAvailable = false;
  try { execFileSync("whisper", ["--help"], { timeout: 10000, stdio: "pipe" }); whisperAvailable = true; } catch {}
  const isCI = process.env.CI === "true";
  if (!whisperAvailable) {
    if (isCI) throw new Error("Whisper not available on CI — tests cannot be skipped");
    console.warn("⚠️  Whisper not found — skipping whisper-e2e tests. These tests provide ZERO signal when skipped.");
  }
  const describeIf = whisperAvailable ? describe : describe.skip;
  ```
- **NO hand-crafted WorkerDeps.** Call `initGatewayAudioCapture()` where possible, or at minimum verify the production code path.
- **Real Whisper, real files, real assertions.** No mocking whisper output.

### Tests to write:

#### Test 1: `runWhisper produces valid segments from speech fixture`
- Load the speech fixture WAV from `tools/cortex-audio/fixtures/`
- Extract left channel (mono) via `splitStereoToMono()`
- Write to temp file
- Call `runWhisper()` with production config (loaded via `loadAudioCaptureConfig()`)
- Assert: returns non-empty TranscriptSegment[]
- Assert: at least one segment contains recognizable English words
- Assert: all segments have start < end

#### Test 2: `stereo split + dual whisper produces user and others channels`
- Load stereo speech fixture
- Split via `splitStereoToMono()`
- Run `runWhisper()` on left → speaker="user"
- Run `runWhisper()` on right → speaker="others"
- Assert: user channel has meaningful speech
- Assert: others channel has minimal/no speech (right channel is silence in fixture)
- Merge via `mergeSegments()`, assert sorted by timestamp

#### Test 3: `transcribeSession full pipeline with real Whisper`
- Create temp data directory with inbox/{sessionId}/
- Write speech fixture as chunk-0000.wav
- Create session DB, insert session record
- Call `transcribeSession()` with real whisper config
- Assert: session status = "done"
- Assert: transcript JSON written to transcripts/ dir
- Assert: transcript.fullText contains English words
- Assert: transcript.segments non-empty with valid timestamps
- Assert: audio moved from inbox/ to processed/

#### Test 4: `transcribeSession calls onIngest with librarian prompt`
- Same setup as Test 3
- Pass `onIngest` callback that captures the prompt and sessionId
- Assert: onIngest was called exactly once
- Assert: prompt contains "audio-capture://" URL
- Assert: prompt contains transcript text
- Assert: prompt contains Librarian JSON schema instructions

#### Test 5: `transcribeSession with empty audio skips onIngest`
- Create a very short silence WAV (< 0.5s of zeros)
- Run transcribeSession
- If Whisper produces empty transcript, assert onIngest was NOT called

#### Test 6: `whisper config loaded from production defaults`
- Call `loadAudioCaptureConfig()` with no overrides
- Verify `whisperBinary` resolves to an existing file
- Verify `whisperModel` is set
- This tests that the production config can actually find Whisper

## Step 3 — Clean up transcribe.test.ts

In `src/audio/__tests__/transcribe.test.ts`:
- Delete the "speaker labeling" tautological tests (they create data and assert their own created data)
- Delete the "mocked runWhisper" test (it doesn't call runWhisper, it manually replicates JSON parsing)
- Keep the pure function tests: mergeSegments, buildFullText, WAV processing pipeline — these are good

## Step 4 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass. The whisper-e2e tests must actually RUN (not skip) on this machine since whisper is available.

## Step 5 — Commit, merge, push

```powershell
git checkout -b feat/030-whisper-e2e-rewrite
git add src/audio/__tests__/whisper-e2e.test.ts src/audio/__tests__/transcribe.test.ts
git commit -m "030: rewrite whisper E2E tests — no env patching, no silent skips, real gateway config"
git checkout main
git merge feat/030-whisper-e2e-rewrite --no-edit
git push
```

Only add the files you changed. Do NOT `git add -A`.

## Step 6 — Create STATE.md

Create `workspace/pipeline/InProgress/030-whisper-e2e-tests/STATE.md`.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT modify** any Rust files
- **Do NOT `git add -A`**
- **Do NOT patch PATH or PYTHONIOENCODING in test files**
- **Do NOT use describe.skip without a visible warning**
- **Do NOT construct WorkerDeps by hand** — use production config loading where possible

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- whisper-e2e.test.ts rewritten from scratch with no env patching
- All tests actually run (not skipped) when whisper is available
- Tests use production config loading, not hand-crafted deps
- Tautological tests removed from transcribe.test.ts
- All existing + new tests pass
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If whisper can't be found without PATH patching, that means transcribe.ts's own PATH handling is broken — investigate and fix transcribe.ts, don't patch the test
