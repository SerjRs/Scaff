---
id: "031"
title: "Cross-Stack Integration Tests (Rust client → TypeScript server)"
priority: high
created: 2026-03-18
author: scaff
type: test
branch: feat/031-cross-stack-integration-tests
tech: rust, typescript
---

# 031 — Cross-Stack Integration Tests

## Problem

The audio pipeline has two independently-tested halves:
- **Rust client** (capture + shipper) — tested with wiremock (fake server)
- **TypeScript server** (ingest + worker) — tested with hand-built HTTP requests

Nobody ever tests them **together**. This has caused two bugs that shipped to production:
1. **Filename mismatch** (028-fix): chunker writes `_chunk-{seq}_{ts}.wav`, shipper expected `_chunk_{seq}.wav`
2. **Multipart field name mismatch**: shipper sends part name `"audio"`, server expected `"file"`

Both passed all unit/integration tests because each side was tested in isolation with matching assumptions.

## What To Build

A test harness that starts the real TypeScript ingest server and hits it with the real Rust shipper HTTP client code.

### Test 1: `Rust upload_chunk() → TypeScript /audio/chunk`

- Start `createTestServer()` from `src/audio/ingest.ts` (in-process, random port)
- From a separate process or inline, run the equivalent of `upload_chunk()`:
  - Build a real multipart POST with the exact field names the Rust client uses (`session_id`, `sequence`, `audio`)
  - Send to the test server
- Assert: server returns 200
- Assert: chunk file written to inbox directory
- Assert: session created in DB with `chunks_received = 1`

### Test 2: `Rust session-end → TypeScript /audio/session-end`

- Upload at least one chunk (Test 1)
- Send `POST /audio/session-end` with `{ "session_id": "..." }` using the same auth header format
- Assert: server returns 200 with `status: "pending_transcription"`

### Test 3: `Full shipper flow → real server`

- Start test server
- Start `ChunkShipper` pointed at the test server URL
- Write WAV files to the outbox using the **exact filename format** the capture engine produces: `{sessionId}_chunk-{seq:04}_{timestamp}.wav`
- Wait for `ShipperEvent::ChunkUploaded` events
- Call `signal_session_end()`
- Assert: all chunks received by server
- Assert: session status is `pending_transcription`
- Assert: chunk files exist in server's inbox directory

### Test 4: `Multipart field name contract`

A contract test that will break if either side changes field names:
- Define the expected field names in a shared constant or test assertion
- Rust side: assert `upload_chunk()` sends fields named `session_id`, `sequence`, `audio`
- Server side: assert handler accepts all three of those field names
- This test should fail loudly if someone renames a field on one side only

## Implementation Approach

Two options:

### Option A: TypeScript test that shells out to a Rust test binary

- Write a small Rust binary (`tests/cross-stack-client.rs`) that takes a server URL and runs `upload_chunk()` + `send_session_end()`
- TypeScript test starts the ingest server, spawns the Rust binary with the server URL, asserts server state after

**Pros:** Tests the actual compiled Rust code
**Cons:** Requires Rust toolchain in test environment, slower

### Option B: TypeScript test that replicates the Rust client's exact HTTP calls

- TypeScript test constructs multipart requests matching exactly what the Rust `upload_chunk()` sends:
  - Same field names (`session_id`, `sequence`, `audio`)
  - Same content types (`audio/wav`)
  - Same auth header format (`Bearer {key}`)
- Any deviation between this test and the Rust code is caught by also running a Rust-side contract test

**Pros:** Faster, no Rust toolchain needed at test time
**Cons:** Could drift from Rust implementation (mitigated by contract test)

### Recommendation: Option B + contract test

Use Option B for the server-side tests (fast, runs in vitest). Add a Rust-side contract test that asserts the multipart form field names/structure haven't changed. If someone changes the Rust client, the contract test forces them to update the cross-stack test too.

## Files to Create

| File | Description |
|------|-------------|
| `src/audio/__tests__/cross-stack.test.ts` | Tests 1-3: real server + client-matching HTTP requests |
| `src/audio/__tests__/field-contract.test.ts` | Test 4: field name contract assertions (server side) |
| `tools/cortex-audio/shipper/tests/field_contract.rs` | Test 4: field name contract assertions (Rust side) |

## Files to Modify

| File | Change |
|------|--------|
| `tools/cortex-audio/shipper/src/upload.rs` | Extract field name constants (e.g., `FIELD_SESSION_ID`, `FIELD_SEQUENCE`, `FIELD_AUDIO`) |

## Key Assertions

The cross-stack tests must assert these exact values that both sides must agree on:

| Contract | Value |
|----------|-------|
| Chunk upload URL path | `/audio/chunk` |
| Session-end URL path | `/audio/session-end` |
| Auth header format | `Bearer {key}` |
| Multipart field: session ID | `session_id` |
| Multipart field: sequence | `sequence` |
| Multipart field: audio file | `audio` (or `file` — server must accept both) |
| Session-end body format | `{ "session_id": "..." }` |
| Chunk filename format | `{sessionId}_chunk-{seq:04}_{timestamp}.wav` |

## ⚠️ Why This Test Failed In Production (2026-03-18 Post-Mortem)

This test was marked "Done" and all tests passed. Yet it missed the shipper off-by-one bug. Here's why:

### 1. Tests used 1-based sequences — same assumption as the bug
The Rust shipper started `next_seq` at `or_insert(1)`. All cross-stack tests also used chunk filenames starting at `_chunk_0001.wav`. The test and the bug shared the same wrong assumption. **A contract test that encodes the wrong contract catches nothing.**

### 2. No test starts at sequence 0
The capture engine generates `chunk-0000` as the first chunk. No cross-stack test verified that sequence 0 is accepted and processed. The test used sequences 1, 2, 3 — which happened to match the shipper's broken expectation.

### 3. TypeScript tests replicate Rust behavior, not verify it
Option B was chosen: TypeScript constructs HTTP requests matching what Rust "should" send. But if the test author has the same understanding as the bug author, the test replicates the bug. **The test proves the server accepts what the test sends, not what the real client sends.**

### 4. Contract test verified field names, not sequencing contract
The contract tests assert field names (`session_id`, `sequence`, `audio`) and URL paths. They don't assert the sequencing contract: "sequences start at 0." The most critical contract between client and server — what sequence number comes first — was never tested.

### What Needs To Change

- **Add a sequencing contract test**: assert that the capture engine starts at seq 0, the shipper expects seq 0, and the server accepts seq 0
- **Test with real capture engine output**: use actual files generated by `ChunkWriter` (seq 0, 1, 2) instead of hand-crafted filenames
- **Don't let test authors choose sequence numbers** — derive them from the capture engine's actual behavior
- **Add a "first chunk" test**: single chunk at sequence 0 → upload → verify server stores it as chunk-0000

## Revision Comments (from TESTS-REVISION-REPORT.md, 2026-03-19)

### RC-1: Add Rust upload body assertion (R4) — CRITICAL
Add a wiremock `Mock::given()` matcher that inspects the multipart body for correct `session_id`, `sequence`, and `audio` field values. The current wiremock mocks only match `method("POST").and(path("/audio/chunk"))` — they accept any body. The off-by-one bug (`or_insert(1)`) passed all tests because wiremock returned 200 regardless of what sequence value was sent.

Alternative: capture the request body in a wiremock handler and assert on it after the test.

### RC-2: True cross-stack test — real Rust client → real TS server (R5) — CRITICAL
The current "cross-stack" test constructs multipart requests in TypeScript that "match what Rust sends." This is a claim, not a verified fact. Write a test that runs the real Rust `upload_chunk()` against a real TypeScript ingest server via subprocess or FFI. If the Rust subprocess approach is too complex, the coverage gap must be documented explicitly — not hidden behind "cross-stack" branding.

### RC-3: Sequence numbering contract test (R9) — MEDIUM
Add a test that creates chunks 0, 1, 2 via ChunkWriter → ships via ChunkShipper → receives at ingest server → verifies stored files are `chunk-0000.wav`, `chunk-0001.wav`, `chunk-0002.wav`. Explicitly assert 0-based indexing at every boundary. The off-by-one bug proves this contract was never enforced.

### RC-4: Use real capture engine filenames in all tests
Multiple tests use legacy filename format (`sess_chunk_0001.wav`). The capture engine produces `{session}_chunk-{seq:04}_{timestamp}.wav`. Tests should use the real format or derive filenames from the capture engine's actual behavior.

### RC-5: Wiremock validates nothing about multipart content (from audit §2.9, §2.12)
All Rust shipper tests use `Mock::given(method("POST")).and(path("/audio/chunk")).respond_with(200)`. Wiremock doesn't validate that the multipart body contains the correct fields or values. The tests check "did HTTP calls happen?" not "did HTTP calls contain correct data?"

## Done Criteria

- Cross-stack tests prove Rust client HTTP calls are accepted by TypeScript server
- Contract tests on both sides enforce shared field names
- Tests would have caught both historical bugs (filename mismatch + field name mismatch)
- All existing tests still pass
- Committed, merged to main
