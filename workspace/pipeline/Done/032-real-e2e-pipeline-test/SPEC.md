---
id: "032"
title: "Real E2E Pipeline Test — Binary to Hippocampus"
priority: critical
created: 2026-03-18
author: scaff
type: test
branch: feat/032-real-e2e-pipeline-test
tech: rust, typescript
lesson: "Every prior 'E2E' test was fake — mocked boundaries, perfect ordering, no real client. This is the test that should have been written first."
---

# 032 — Real E2E Pipeline Test (Binary → Whisper → Hippocampus)

## Why This Exists

We shipped 150+ tests and found 3 bugs in production on the same day:
1. Filename format mismatch (chunker vs shipper parser)
2. Multipart field name mismatch (Rust client vs TS server)
3. Chunk #0 race condition (shipper misses first chunk)

Every existing test mocks or bypasses the actual integration boundary. None of them start the real binary, ship chunks over HTTP, and verify a transcript lands in the knowledge graph. This test does exactly that.

## What This Test Does

```
Real Rust binary (cortex-audio.exe)
    ↓ captures audio from a WAV file (loopback or virtual input)
    ↓ chunks to outbox directory
    ↓ shipper detects, uploads via HTTP multipart
    ↓
Real TypeScript server (gateway audio handler)
    ↓ receives chunks, stores to inbox
    ↓ session-end triggers worker
    ↓ worker concatenates, splits stereo, runs real Whisper
    ↓ transcript JSON written
    ↓ Library article created
    ↓ Hippocampus facts extracted
    ↓
Assertions verify the whole chain
```

No mocks. No hand-crafted HTTP requests. No writing files directly to inbox. The real binary talks to the real server.

## Approach

Since we can't easily automate mic/speaker capture in a test environment, we use a **shipper-only test** that simulates what the capture engine does: writes WAV files to the outbox in the exact format the chunker produces, with realistic timing. The shipper picks them up and ships them to a real server instance.

This tests everything except WASAPI audio capture itself (which is hardware-dependent and can't run in CI).

### Test Harness Architecture

```
Test orchestrator (TypeScript, vitest)
  │
  ├── Starts real ingest server (createTestServer, random port)
  │     └── with real Whisper worker (not mocked)
  │     └── with real SQLite DBs (session, library, hippocampus)
  │
  ├── Starts real ChunkShipper (Rust crate, via Node FFI or subprocess)
  │     └── pointed at test server URL
  │     └── watching a temp outbox directory
  │
  ├── Writes speech WAV chunks to outbox
  │     └── using EXACT capture engine filename format
  │     └── with realistic timing (not instant)
  │     └── starting from chunk-0000
  │
  ├── Waits for shipper upload events
  │
  ├── Sends session-end (via shipper)
  │
  ├── Polls session status until "done" or "failed"
  │
  └── Asserts EVERYTHING:
        ├── All chunks received by server
        ├── Session status = "done"
        ├── Transcript JSON exists and contains speech
        ├── Audio files moved from inbox/ to processed/
        ├── Library article created
        ├── Hippocampus facts inserted
        └── Hippocampus edges inserted
```

### Implementation: TypeScript test with Rust subprocess

Since the shipper is async Rust and hard to call from Node directly, the test will:

1. Build a small Rust test binary (`tools/cortex-audio/tests/e2e-shipper-client.rs`) that:
   - Takes args: `--server-url`, `--api-key`, `--outbox-dir`, `--session-id`
   - Starts a ChunkShipper watching the outbox
   - Waits for chunks to appear, uploads them
   - When it receives a `STOP` on stdin, sends session-end and exits
   - Prints JSON events to stdout: `{"event":"uploaded","sequence":0}`, `{"event":"session_end_sent"}`

2. TypeScript test orchestrates everything:
   - Starts the ingest server
   - Spawns the Rust binary as a child process
   - Writes chunks to the outbox with delays
   - Reads stdout for upload confirmations
   - Sends STOP to stdin
   - Polls server for completion
   - Asserts all outputs

### Alternative: Pure TypeScript with manual multipart

If the Rust subprocess approach is too complex, fall back to a TypeScript-only test that:
- Builds multipart uploads matching the exact Rust client format (field names, content types)
- Sends them with realistic timing (not instant)
- Uses capture engine filename format in the multipart `filename` field
- Tests the same server pipeline

**This is the 031 cross-stack test but with real Whisper, real DBs, and real ingestion.** Not a mock in sight.

## Test Cases

### Test 1: `happy path — 3 chunks → transcript → Hippocampus`

- Generate 3 speech WAV chunks from the test fixture (split `test-speech-10s.wav` into 3 parts)
- Upload all 3 in order with 1-second delays between them
- Send session-end
- Wait for transcription (up to 120s)
- Assert:
  - Session status = "done"
  - `chunks_received` = 3
  - Transcript JSON exists in `transcripts/{sessionId}.json`
  - `transcript.fullText` contains recognizable words from the speech
  - `transcript.segments` is non-empty with valid timestamps
  - Audio files moved from `inbox/` to `processed/`
  - Library article exists with title containing "Meeting Transcript"
  - At least 1 Hippocampus fact inserted
  - At least 1 Hippocampus edge inserted (sourced_from)

### Test 2: `chunk ordering preserved across network`

- Upload 5 chunks with small delays
- Verify server received all 5 in correct sequence (chunk-0000 through chunk-0004)
- Verify no sequence gaps detected

### Test 3: `session-end waits for in-flight uploads`

- Upload 3 chunks
- Send session-end immediately after last chunk (no delay)
- Verify all 3 chunks arrived before worker starts
- Verify session completes successfully

### Test 4: `single chunk session`

- Upload 1 chunk only
- Send session-end
- Verify transcription succeeds with just 1 chunk

## Files to Create

| File | Description |
|------|-------------|
| `src/audio/__tests__/real-e2e.test.ts` | The real E2E test — no mocks |
| `tools/cortex-audio/fixtures/split-speech-chunks.mjs` | Script to split test-speech-10s.wav into individual chunks |

## Files to Modify

None. All new files.

## Dependencies

- `whisper` on PATH (real Whisper, not mocked)
- `test-speech-10s.wav` fixture (from task 030)
- Python + openai-whisper installed

## Test Runner

```powershell
# Real E2E (slow, requires Whisper on PATH)
$env:PYTHONIOENCODING = "utf-8"
$env:PATH += ";C:\Users\Temp User\AppData\Local\Python\pythoncore-3.14-64\Scripts"
npx vitest run src/audio/__tests__/real-e2e.test.ts --timeout 300000
```

Timeout: 5 minutes (Whisper can be slow on CPU).

Skip guard: same pattern as 030 — skip if whisper not on PATH.

## Done Criteria

- Test starts a real server with real Whisper + real DBs
- Test uploads chunks via HTTP matching exact Rust client format
- Test verifies transcript contains actual speech content
- Test verifies Library article + Hippocampus facts exist
- All 4 tests pass
- All existing tests still pass
- If this test had existed before today, it would have caught all 3 bugs

## ⚠️ Why This Test Failed In Production (2026-03-18 Post-Mortem)

This spec says "No mocks. No hand-crafted HTTP requests." The implementation violated both promises. Here's every failure:

### 1. Bypassed the Rust client entirely
The spec offered two approaches: Rust subprocess or "pure TypeScript with manual multipart." The implementation chose the TypeScript approach — constructing HTTP requests by hand. **This means the test never ran the actual shipper code.** The off-by-one bug (`or_insert(1)`) was in the shipper, which was never invoked.

### 2. Hand-crafted HTTP requests started at sequence 1
Same bug as 031: the test used sequences starting at 1, matching the shipper's broken assumption. A test that replicates the bug is worse than no test — it gives false confidence.

### 3. Test patched ffmpeg/whisper PATH at runtime
Lines 39-43 hardcode the WinGet ffmpeg path and inject it into `process.env.PATH`. The gateway doesn't have this. So Whisper works in tests but crashes in production with `FileNotFoundError: [WinError 2]`.

### 4. Test constructed WorkerDeps manually with full ingestion
The test created `workerDeps` with `ingestion: { libraryDb, busDb, extractLLM }` — all correctly wired. The gateway's `initGatewayAudioCapture()` never passed `ingestionDeps`, so `workerDeps.ingestion` was undefined in production. **The test proved ingestion works when deps are correct. It didn't prove the gateway provides correct deps.**

### 5. "No mocks" claim was false
The spec says "Not a mock in sight" but the implementation:
- Mocked the Rust shipper (replaced with TypeScript HTTP calls)
- Mocked the gateway wiring (constructed deps manually instead of using `initGatewayAudioCapture`)
- Patched the environment (PATH, PYTHONIOENCODING)

The only things that were real: Whisper binary and SQLite databases.

### 6. All 5 production bugs were in the UNTESTED boundaries
| Bug | Where | Tested? |
|-----|-------|---------|
| Shipper seq off-by-one | Rust shipper `or_insert(1)` | ❌ Shipper never ran |
| Chunk #0 not uploaded | Rust watcher stability | ❌ Watcher never ran |
| Whisper ENOENT | Gateway PATH | ❌ Test patched PATH |
| ffmpeg not found | Gateway PATH | ❌ Test patched PATH |
| Ingestion not wired | Gateway server-audio.ts | ❌ Test wired manually |

### What Needs To Change

- **Either run the real Rust binary or don't call it "E2E"** — rename to "server-side integration test" if it only tests the TS pipeline
- **Do NOT patch PATH in tests** — tests must fail if the production environment would fail
- **Do NOT construct WorkerDeps manually** — call `initGatewayAudioCapture()` and verify what it returns
- **Use sequence 0 as the first chunk** — match the capture engine, not the test author's assumption
- **Add a deployment readiness check**: a test that boots the gateway audio handler the same way production does and verifies all deps are wired
- **If the Rust subprocess is "too complex", the test coverage gap must be documented** — not hidden behind "real E2E" branding

## Revision Comments (from TESTS-REVISION-REPORT.md, 2026-03-19)

### RC-1: Remove environment patching (R2) — CRITICAL
Same as 030: delete the PATH and PYTHONIOENCODING patching (lines 31-40). Production code now handles this. Tests must fail if the production environment would fail.

### RC-2: Replace skip guard with explicit failure (R3) — CRITICAL
Same as 030: CI should fail loudly when Whisper is missing, not silently skip.

### RC-3: Worker → onIngest integration test (R7) — HIGH
Test `transcribeSession()` with a real WAV fixture, real Whisper (when available), and a real `onIngest` callback. Verify the prompt contains the transcript text and the `audio-capture://` URL. Current test uses a spy array push — should at minimum verify the prompt structure.

### RC-4: Do NOT construct WorkerDeps manually (from post-mortem)
The test must call `initGatewayAudioCapture()` to get the handler + deps, not construct `createGatewayAudioHandler()` with hand-built deps. Bug #5 (ingestion never wired) lived in the init function, which had zero test coverage.

### RC-5: Rename if not truly E2E (from post-mortem)
If the test still uses TypeScript HTTP client instead of the real Rust shipper, rename from "Real E2E" to "Server-side integration test." Do not claim "no mocks" if the client, environment, gateway init, and ingestion pipeline are all mocked.

### RC-6: Ingest test uses old field name (R8, from audit §2.1)
`buildMultipart()` in `ingest.test.ts` uses field name `"file"` (line 117), not `"audio"`. The Rust client sends `"audio"`. Update tests to use `"audio"` as the primary field name. Document `"file"` as deprecated backward compat.

## Anti-Patterns to Avoid

- ❌ Do NOT mock Whisper
- ❌ Do NOT mock the HTTP server
- ❌ Do NOT write chunks directly to inbox (bypass the upload path)
- ❌ Do NOT use perfect instant timing
- ❌ Do NOT skip sequence gap validation
- ❌ Do NOT use different field names than the Rust client
- ❌ Do NOT use different filename formats than the capture engine
- ❌ Do NOT patch PATH or env vars that the gateway doesn't have
- ❌ Do NOT construct deps manually — use the real gateway init functions
- ❌ Do NOT call it "E2E" if it skips the client
