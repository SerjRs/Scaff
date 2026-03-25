# 038 — Whisper Failure Mode Tests — STATE

## Status: DONE

**Branch:** `feat/038-whisper-failure-tests` (merged to main)
**Commit:** `9888c8460` — merged via fast-forward
**Date:** 2026-03-19

## Tests Written (8/8)

File: `src/audio/__tests__/whisper-failures.test.ts`

| # | Test | Status |
|---|------|--------|
| 1 | binary not found produces clear error (not raw ENOENT) | PASS |
| 2 | non-zero exit code includes stderr in error | PASS |
| 3 | malformed JSON output produces parse error with file path | PASS |
| 4 | output file missing produces clear error | PASS |
| 5 | empty transcript (silence) returns empty segments without error | PASS |
| 6 | worker sets session status=failed with useful error on whisper failure | PASS |
| 7 | whisper timeout produces clear error message | PASS |
| 8 | ffmpeg missing produces clear error about ffmpeg | PASS |

## Source Fixes

### `src/audio/transcribe.ts` — 4 fixes

1. **ENOENT detection**: `execFileAsync` now checks `err.code === "ENOENT"` and produces `"Whisper binary not found: \"{cmd}\" is not installed or not on PATH"` instead of raw `"Whisper failed: spawn whisper ENOENT"`.

2. **JSON parse wrapping**: `JSON.parse()` output is now wrapped in try/catch producing `"Whisper output is not valid JSON at {path}: {parse error}"` instead of raw `SyntaxError`.

3. **Timeout support**: Added `timeoutMs?: number` to `WhisperConfig`. `execFileAsync` passes it to `execFile` options. Killed+SIGTERM processes produce `"Whisper timed out after {ms}ms"`.

4. **ffmpeg detection**: When stderr contains `ffmpeg` + `not found`/`FileNotFoundError`/`No such file`, produces `"ffmpeg not found — Whisper requires ffmpeg to be installed and on PATH"` instead of generic process failure.

### `src/audio/worker.ts` — No changes needed

Worker already had correct error handling:
- Catches all errors in `transcribeSession()` catch block
- Extracts `err.message` (not stack trace)
- Calls `updateSessionStatus(db, sessionId, "failed", { error: message })`
- Re-throws for caller awareness

## Full Test Suite Results

All 100 audio tests pass across 10 test files (including the new 8 failure mode tests).
