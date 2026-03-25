---
id: "043"
title: "Test cleanup — remove tautological tests, env patching, and misleading labels"
priority: medium
created: 2026-03-19
author: scaff
type: test
branch: feat/043-test-cleanup
tech: typescript, rust
source: "TESTS-REVISION-REPORT.md R2, R3, R10"
---

# 043 — Test Cleanup

## Problem

The test suite contains tests that provide false confidence:
- Tests that patch their own environment then pass (masking production issues)
- Tests that create data and assert their own created data (tautologies)
- Tests labeled "E2E" or "no mocks" that mock critical components
- Skip guards that silently pass entire test files

These tests don't just fail to catch bugs — they actively discourage investigation by reporting green.

## Changes

### 1. Remove PATH patching from whisper-e2e.test.ts

Delete lines 28-37 (the `FFMPEG_DIR` injection and `PYTHONIOENCODING` set). The production code in `transcribe.ts` now handles both. If the test fails after removing the patch, the production fix is incomplete.

### 2. Remove PATH patching from real-e2e.test.ts

Same as above — delete the environment patching block.

### 3. Replace skip guards with CI-aware failures

Change:
```typescript
const describeIf = whisperAvailable ? describe : describe.skip;
```
To:
```typescript
const isCI = process.env.CI === "true";
if (!whisperAvailable && isCI) {
  throw new Error("Whisper not available on CI — install it or remove this test from CI suite");
}
const describeIf = whisperAvailable ? describe : describe.skip;
```
Locally, skip is fine. On CI, fail loudly.

### 4. Delete tautological tests from transcribe.test.ts

Remove "speaker labeling" tests (lines 120-139) that:
```typescript
const segments = [
  { speaker: "user", text: "hello" },
  { speaker: "others", text: "hi" },
];
expect(segments[0].speaker).toBe("user");  // tautology
```

Remove "mocked runWhisper" test that manually replicates JSON parsing instead of calling `runWhisper()`.

### 5. Rename misleading test descriptions

- `real-e2e.test.ts`: Change "Real E2E pipeline (Whisper + Hippocampus)" to "Server-side integration (Whisper + onIngest callback)" — honest about what it tests
- `cross-stack.test.ts`: Change "Cross-stack: Rust shipper → TypeScript server" to "Cross-stack contract (TypeScript multipart → TypeScript server)" — honest that Rust isn't involved
- Update file-level JSDoc comments to remove "NO MOCKS" claims where mocks exist

### 6. Update Rust tests to use capture engine filename format

Replace legacy `sess_chunk_0001.wav` filenames with `sess_chunk-0001_12345.wav` (capture engine format with timestamp) in:
- `shipper/src/lib.rs` tests
- `tray/tests/shipper_integration.rs`

## Done Criteria

- Zero environment patches in test files
- Skip guards fail on CI, skip locally
- No tautological tests remain
- Test descriptions accurately describe what they test
- Rust tests use real filename format
- All tests still pass (after adjustments)
- Test count may decrease — that's the point
