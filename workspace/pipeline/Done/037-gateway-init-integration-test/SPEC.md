---
id: "037"
title: "Gateway init integration test — verify initGatewayAudioCapture() wiring"
priority: critical
created: 2026-03-19
author: scaff
type: test
branch: feat/037-gateway-init-test
tech: typescript
source: "TESTS-REVISION-REPORT.md R1"
---

# 037 — Gateway Init Integration Test

## Problem

`initGatewayAudioCapture()` is the single function that wires together the entire audio pipeline in production. It was never tested. Bug #5 (ingestion never wired) lived here — `ingestionDeps` was never passed, so `workerDeps.ingestion` was undefined and ingestion was silently skipped.

No test in the suite calls `initGatewayAudioCapture()`. All tests call the inner handler factory (`createGatewayAudioHandler()`) directly with manually constructed deps, bypassing the init function entirely.

## What To Test

### Test 1: `initGatewayAudioCapture returns handler with fully wired deps`
- Call `initGatewayAudioCapture()` with realistic config
- Verify it returns a non-null `AudioCaptureHandle`
- Verify `handle.handler` is a function
- Verify `handle.db` is an open SQLite database
- Verify `handle.config.enabled === true`

### Test 2: `initGatewayAudioCapture returns null when disabled`
- Call with `audioCaptureConfig: { enabled: false }`
- Verify returns `null`

### Test 3: `initGatewayAudioCapture returns null when apiKey empty`
- Call with `audioCaptureConfig: { enabled: true, apiKey: "" }`
- Verify returns `null`

### Test 4: `workerDeps.onIngest is wired when Cortex/Router available`
- Call `initGatewayAudioCapture()` with valid config
- Verify `workerDeps` includes `onIngest` callback
- This requires the lazy Cortex/Router singleton to be resolvable, OR mock the lazy imports and verify they're called

### Test 5: `session-end triggers transcription with real workerDeps`
- Call `initGatewayAudioCapture()`
- Use the returned handler to upload chunks + session-end
- Verify `transcribeSession()` is called with the workerDeps that initGateway provided
- Verify `onIngest` is present in the workerDeps (even if we can't run the full Librarian pipeline)

### Test 6: `handler cleanup closes database`
- Call `initGatewayAudioCapture()`
- Call `handle.close()`
- Verify DB is closed (subsequent queries throw)

## Key Constraint

These tests must call `initGatewayAudioCapture()`, NOT `createGatewayAudioHandler()`. The entire point is to test the init function that production uses.

## Mock Strategy

- **Real:** SQLite database, file I/O, config parsing
- **Mock:** Cortex/Router lazy imports (inject stubs that verify they're called correctly)
- **Do NOT mock:** `initGatewayAudioCapture()` itself — that's what we're testing

## Done Criteria

- `initGatewayAudioCapture()` has test coverage for happy path, disabled, and wiring
- Tests would have caught bug #5 (missing ingestionDeps / onIngest)
- All existing tests still pass
