---
id: "042"
title: "Deployment readiness check — verify runtime environment before tests pass"
priority: high
created: 2026-03-19
author: scaff
type: test
branch: feat/042-deployment-readiness
tech: typescript
source: "TESTS-REVISION-REPORT.md R2, R3 + post-mortem"
---

# 042 — Deployment Readiness Check

## Problem

Three of the five production bugs (whisper ENOENT, ffmpeg not found, PYTHONIOENCODING missing) were environment issues. The test suite patched its own environment to work around these problems, then reported green. The gateway process didn't have the patches and crashed.

The test suite actively lied about system readiness by fixing the environment in test scope.

## What To Build

A deployment readiness test that runs in the gateway's actual environment (no patching) and verifies all runtime dependencies.

### Test 1: `whisper binary is resolvable`
- Do NOT patch PATH
- Resolve `whisper` the same way `transcribe.ts` does: use the `whisperBinary` config value
- Spawn it with `--help`
- Assert: exits with code 0 or 1 (found and ran), not ENOENT

### Test 2: `ffmpeg binary is resolvable`
- Do NOT patch PATH
- Check if ffmpeg is on PATH or if `transcribe.ts` adds it at module load
- Spawn `ffmpeg -version`
- Assert: exits successfully

### Test 3: `PYTHONIOENCODING is set in whisper spawn`
- Call `runWhisper()` on a minimal WAV
- Verify the spawned process has `PYTHONIOENCODING=utf-8` in its environment
- (This can be tested by checking the `env` option in the `execFile` call)

### Test 4: `whisperBinary config resolves to existing file`
- Load audio config via `loadAudioCaptureConfig()`
- Resolve `whisperBinary` path
- Assert: file exists on disk

### Test 5: `initGatewayAudioCapture produces working handler`
- Call `initGatewayAudioCapture()` with production-like config
- Upload a valid WAV chunk
- Send session-end
- Verify transcription starts (even if it fails due to content — the point is that Whisper is found and invoked)

## Key Constraints

- **NO environment patching in test scope.** If the test needs to patch PATH, the production code is broken and the test must fail.
- **NO skip guards for dependencies.** If whisper/ffmpeg isn't available, the test FAILS, not skips. This is a readiness check — skipping defeats the purpose.
- Tests must run in the same environment the gateway runs in. If the gateway is started via `openclaw gateway start`, the test should simulate that environment.

## Anti-Patterns

- ❌ `process.env.PATH = ffmpegDir + ":" + process.env.PATH` — this hides problems
- ❌ `describe.skip` when whisper not found — this hides problems
- ❌ Testing `runWhisper()` in isolation with injected config — test the real config loading

## Done Criteria

- All 5 tests pass without any environment patching
- If whisper/ffmpeg is removed from PATH, tests fail immediately with clear messages
- Tests verify the production code's own PATH/env handling works correctly
- All existing tests still pass
