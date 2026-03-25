---
id: "038"
title: "Whisper failure mode tests — error handling coverage"
priority: high
created: 2026-03-19
author: scaff
type: test
branch: feat/038-whisper-failure-tests
tech: typescript
source: "TESTS-REVISION-REPORT.md R6"
---

# 038 — Whisper Failure Mode Tests

## Problem

No test covers what happens when Whisper fails. The only tests that run real Whisper assume success. When Whisper crashed in production (ENOENT, ffmpeg missing), the error surfaced as an unhelpful `spawn whisper ENOENT` or `FileNotFoundError` deep in a Python traceback.

`runWhisper()` in `transcribe.ts` needs explicit error handling tests.

## What To Test

### Test 1: `binary not found → clear error message`
- Mock `execFile` to emit ENOENT error
- Call `runWhisper()`
- Assert: throws with message containing "whisper" and "not found" (not raw ENOENT)

### Test 2: `non-zero exit code → error with stderr`
- Mock `execFile` to return exit code 1 with stderr "Some whisper error"
- Call `runWhisper()`
- Assert: throws with message containing "Whisper failed" and the stderr content

### Test 3: `malformed JSON output → parse error`
- Mock `execFile` to succeed
- Write invalid JSON to the expected output path
- Call `runWhisper()`
- Assert: throws with message about JSON parse failure

### Test 4: `output file missing → clear error`
- Mock `execFile` to succeed but don't create the output file
- Call `runWhisper()`
- Assert: throws with message "Whisper output not found at {path}"

### Test 5: `empty transcript (no speech) → empty segments, no error`
- Mock `execFile` to succeed
- Write valid JSON with `{ "text": "", "segments": [], "language": "en" }`
- Call `runWhisper()`
- Assert: returns empty `TranscriptSegment[]`, no throw

### Test 6: `timeout → clear error`
- Mock `execFile` to hang (never resolve)
- Call `runWhisper()` with a short timeout (if supported)
- Assert: throws with timeout-related message

## Mock Strategy

These tests legitimately use mocks — they test error handling, not Whisper itself. Mock `execFile` via `vi.mock("node:child_process")` or inject it as a dependency.

## Done Criteria

- Every Whisper failure mode produces a clear, actionable error message
- Session status goes to "failed" with useful error text (not raw stack trace)
- Worker doesn't crash on Whisper failure — fails gracefully and updates session DB
- All existing tests still pass
