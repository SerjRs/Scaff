# CLAUDE.md — 042 Deployment Readiness Check

## Branch
`feat/042-deployment-readiness`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

Three of five production bugs were environment issues: whisper not on PATH, ffmpeg not on PATH, PYTHONIOENCODING not set. The test suite patched its own environment to work around these, then reported green. The gateway process did not have the patches and crashed.

This test suite verifies that the production code can find and run all runtime dependencies WITHOUT any test-scope environment patching. If a dependency is missing, the test FAILS — it does not skip, it does not patch.

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/042-deployment-readiness-check/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/042-deployment-readiness-check/SPEC.md` — spec
3. `src/audio/transcribe.ts` — PATH handling, ffmpeg dir injection, PYTHONIOENCODING, execFileAsync
4. `src/audio/ingest.ts` — loadAudioCaptureConfig, createGatewayAudioHandler
5. `src/gateway/server-audio.ts` — initGatewayAudioCapture
6. `src/audio/worker.ts` — WorkerDeps, transcribeSession
7. `src/audio/__tests__/whisper-e2e.test.ts` — how 030 rewrite checks whisper availability

## Step 2 — Write deployment-readiness.test.ts

Create `src/audio/__tests__/deployment-readiness.test.ts`.

### CRITICAL RULES:
- **ZERO environment patching.** Do NOT touch process.env.PATH. Do NOT set PYTHONIOENCODING in test scope. Do NOT add any directory to PATH.
- **ZERO skip guards.** Every test runs. If a dependency is missing, the test FAILS with a clear message telling you what to install.
- **These tests verify the PRODUCTION CODE handles the environment correctly**, not that the test can patch around it.

### Tests to write:

#### Test 1: `whisperBinary config resolves to existing file`
- Load config via loadAudioCaptureConfig() with defaults
- Resolve whisperBinary path (may be absolute or just "whisper")
- If absolute: assert file exists on disk
- If relative name: use production code logic to find it (check transcribe.ts PATH additions)
- Assert: the binary exists and is accessible

#### Test 2: `whisper binary spawns successfully`
- Load config to get whisperBinary
- Spawn it with --help (same way production does — through execFile, NOT through a patched PATH)
- Set PYTHONIOENCODING in the child process env (same as transcribe.ts does)
- Assert: process exits without ENOENT
- Assert: stdout or stderr contains whisper-related output
- Do NOT use process.env to set PYTHONIOENCODING — pass it only in the spawn options env, exactly as production code does

#### Test 3: `ffmpeg binary is available to whisper`
- The production code in transcribe.ts adds the WinGet ffmpeg dir to process.env.PATH at module load
- Verify this works: after importing transcribe.ts, spawn ffmpeg -version
- Assert: exits successfully
- Assert: output contains "ffmpeg version"
- If ffmpeg is NOT found, fail with: "ffmpeg not available. Install via: winget install ffmpeg"

#### Test 4: `PYTHONIOENCODING is set in whisper child process env`
- Read transcribe.ts to find where PYTHONIOENCODING is set in execFile options
- Verify the production code passes it (inspect the execFileAsync call)
- This can be a code inspection test: import the module and verify the env setup
- Or: spawn whisper with a WAV that produces Unicode output and verify no encoding crash

#### Test 5: `initGatewayAudioCapture produces working pipeline end-to-end`
- Call initGatewayAudioCapture with production-like config
- Start HTTP server with returned handler
- Upload a valid speech WAV chunk (from fixtures)
- Send session-end
- Wait for transcription (poll session status, timeout 120s)
- Assert: session status = "done" or at minimum "transcribing" (whisper was invoked)
- This proves the entire chain: config loading -> binary resolution -> PATH setup -> whisper spawn -> transcript
- If whisper is not available, FAIL — do not skip

#### Test 6: `config whisperBinary with full path works`
- Load config with whisperBinary set to the full absolute path (e.g. from the existing openclaw.json)
- Spawn it with --help
- Assert: works

### Optional Test 7: `stale PATH does not break whisper`
- Verify that even if the system PATH does not contain whisper/ffmpeg dirs, the production code in transcribe.ts adds them at module load
- This is the exact scenario from production: gateway started before PATH was updated

## Step 3 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass. NO skips.

## Step 4 — Commit, merge, push

```powershell
git checkout -b feat/042-deployment-readiness
git add src/audio/__tests__/deployment-readiness.test.ts
# Add any source files you fixed
git commit -m "042: deployment readiness check — verify runtime deps without env patching"
git checkout main
git merge feat/042-deployment-readiness --no-edit
git push
```

Do NOT `git add -A`.

## Step 5 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **ABSOLUTELY NO environment patching** — this is the entire point of this test
- **NO skip guards** — if a dep is missing the test must FAIL
- **DO fix source code if you find bugs** — document in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Tests verify whisper, ffmpeg, PYTHONIOENCODING without patching
- Missing dependency = test failure with actionable message (what to install)
- initGatewayAudioCapture tested end-to-end
- Zero skip guards, zero env patches
- All tests pass on this machine
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If whisper or ffmpeg cannot be found by the production code, that is a real bug in transcribe.ts — fix it there, do not patch the test
