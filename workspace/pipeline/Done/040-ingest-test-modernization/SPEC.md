---
id: "040"
title: "Ingest test modernization — update field names, remove legacy assumptions"
priority: high
created: 2026-03-19
author: scaff
type: test
branch: feat/040-ingest-test-modernization
tech: typescript
source: "TESTS-REVISION-REPORT.md R8"
---

# 040 — Ingest Test Modernization

## Problem

`ingest.test.ts` was written against the old API contract:
- Uses field name `"file"` in `buildMultipart()` (line 117), but the Rust client sends `"audio"`
- Tests the test helper `createTestServer()`, not the production `createGatewayAudioHandler()`
- `makeWavData()` returns `Buffer.alloc(sizeBytes, 0x42)` — not a valid WAV header
- No test verifies session-end → transcription trigger (fire-and-forget path)

The server accepts both `"file"` and `"audio"` for backward compat, but the tests should exercise the current contract.

## Changes

### 1. Update field name to `"audio"` 
Change `buildMultipart()` to use `"audio"` as the file field name. Add a separate backward-compat test that verifies `"file"` still works, with a comment marking it as deprecated.

### 2. Use valid WAV headers in test data
Replace `Buffer.alloc(sizeBytes, 0x42)` with a proper 44-byte WAV header followed by PCM data. Doesn't need real audio — just valid headers so downstream code can parse it if needed.

### 3. Add session-end → worker trigger test
Upload chunks, send session-end, verify that `triggerPendingTranscriptions()` is called (or at minimum that the session status changes to `pending_transcription`). Currently no test verifies this code path.

### 4. Test via `createGatewayAudioHandler()` 
At least one test should use the production handler factory, not just `createTestServer()`. Verify it behaves the same way.

## Done Criteria

- Tests use `"audio"` field name (matching Rust client)
- `"file"` backward compat has explicit test with deprecation comment
- Valid WAV headers in test data
- Session-end → transcription trigger tested
- All existing tests still pass
