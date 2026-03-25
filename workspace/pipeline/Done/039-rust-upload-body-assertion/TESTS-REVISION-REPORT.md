# Cortex-Audio Test Suite — Revision Report

**Date:** 2026-03-19
**Scope:** Full audit of cortex-audio test suite (TypeScript + Rust)
**Trigger:** 5 production bugs found on 2026-03-18 E2E test, all missed by existing tests

---

## Section 1: Executive Summary

### Test Inventory

| Layer | File | Test Count |
|-------|------|-----------|
| **TypeScript** | `ingest.test.ts` | 16 |
| | `transcribe.test.ts` | 10 |
| | `wav-utils.test.ts` | 4 |
| | `whisper-e2e.test.ts` | 4 (skip-guarded) |
| | `real-e2e.test.ts` | 4 (skip-guarded) |
| | `cross-stack.test.ts` | 5 |
| | `gateway-wiring.test.ts` | 9 |
| | `librarian-ingestion.test.ts` | 5 |
| **Rust** | `shipper/src/lib.rs` (unit) | 8 |
| | `shipper/src/watcher.rs` (unit) | 9 |
| | `capture/src/chunker.rs` (unit) | 8 |
| | `tray/tests/shipper_integration.rs` | 8 |
| | `shipper/tests/field_contract.rs` | 2 |
| **Total** | | **~92** |

### Production Bugs Missed: 5 out of 5

| # | Bug | Root Cause in Tests |
|---|-----|-------------------|
| 1 | Shipper sequence off-by-one (`or_insert(1)`) — chunk #0 never uploaded | Rust tests used wiremock that doesn't validate multipart body fields. `expect(N)` checks call count, not sequence values. TS tests hand-crafted requests starting at 0 — they never tested the actual Rust client's behavior. |
| 2 | Chunk #0 race — watcher missed pre-existing files | Test was added *after* the bug was found. Original watcher tests only tested new file detection. |
| 3 | Whisper ENOENT — gateway couldn't find whisper binary | Tests patched `process.env.PATH` at test file scope (lines 28-37 of whisper-e2e.test.ts), masking that production code (transcribe.ts) didn't do this. The skip guard (`describeIf`) silently passed on CI where whisper wasn't installed. |
| 4 | ffmpeg not found — whisper needs ffmpeg, not on gateway PATH | Same as #3. Tests added ffmpeg to PATH themselves. Production code didn't. |
| 5 | Ingestion never wired — `initGatewayAudioCapture()` never passed `ingestionDeps` | No test ever called `initGatewayAudioCapture()`. Gateway-wiring tests used `createGatewayAudioHandler()` directly with hand-constructed deps. The real init function was untested. |

### Root Cause Pattern

**Every bug was at an integration boundary that tests bypassed.**

The test suite systematically mocked or replaced the component on one side of every boundary:
- Rust shipper → wiremock (mock server) instead of real TS server
- TS ingest tests → hand-crafted multipart (mock client) instead of real Rust client
- Whisper tests → patched PATH in test scope, not in production code
- Gateway tests → called handler factory directly, never the init function
- Worker tests → passed `WorkerDeps` manually, never tested how deps are constructed

The result: each component was tested in a hermetic bubble. The tests verified "does this component work if everything around it behaves exactly as I assume?" The answer was yes. The assumptions were wrong.

---

## Section 2: Test-by-Test Audit

### 2.1 `src/audio/__tests__/ingest.test.ts` (16 tests)

**Claims to test:** Audio ingest HTTP API — auth, chunk upload, session-end, status queries, disabled mode, full upload cycle, concurrent sessions.

**Actually tests:** The TypeScript HTTP server in isolation. Uses `createTestServer()` (the test helper, not production init). Hand-crafts multipart bodies with `buildMultipart()`. Uses `fetch()` as client.

**What it misses:**
- Never tests `createGatewayAudioHandler()` (production code path)
- Never tests worker integration (no `workerDeps` passed to test server)
- The `buildMultipart()` helper uses field name `"file"` (line 117), not `"audio"` — this is the *old* field name. The server accepts both due to `f.name === "file" || f.name === "audio"` (ingest.ts line 266), but the Rust client sends `"audio"`. The test was written for the old contract.
- No test verifies what happens when `session-end` triggers transcription (fire-and-forget path)
- `makeWavData()` returns `Buffer.alloc(sizeBytes, 0x42)` — not a valid WAV. Tests only check storage, not processing.

**What works well:** Auth tests are thorough (missing header, wrong key, wrong scheme). Validation tests (bad UUID, negative sequence, non-multipart Content-Type) are solid. Concurrent session isolation test is genuinely useful.

**Severity:** HIGH — Tests the server in a configuration that never runs in production (no worker, no gateway handler, old field names).

---

### 2.2 `src/audio/__tests__/transcribe.test.ts` (10 tests)

**Claims to test:** Whisper CLI wrapper, segment merging, full-text generation, and WAV processing pipeline.

**Actually tests:** Pure functions (`mergeSegments`, `buildFullText`) and data structure manipulation. The "runWhisper (mocked)" test doesn't actually call `runWhisper()` — it manually writes a JSON file and parses it, simulating what `runWhisper` does internally. The "E2E: WAV processing pipeline" test only tests `concatenateWavFiles` → `splitStereoToMono`, not the Whisper step.

**What it misses:**
- `runWhisper()` is never actually called in any test in this file
- No test for Whisper binary discovery (PATH resolution)
- No test for `PYTHONIOENCODING` handling
- No test for Whisper failure modes (binary not found, invalid WAV input, timeout, malformed JSON output)
- "Speaker labeling" tests (lines 120-139) are tautologies — they create hardcoded arrays and assert their own values

**What works well:** `mergeSegments` and `buildFullText` are pure functions tested thoroughly with edge cases (empty arrays, overlapping timestamps, single speaker). The WAV pipeline test with known PCM data and channel isolation verification is genuinely useful.

**Severity:** MEDIUM — Pure function tests are fine. The "mocked runWhisper" test is theater — it doesn't test `runWhisper` at all.

---

### 2.3 `src/audio/__tests__/wav-utils.test.ts` (4 tests)

**Claims to test:** WAV parsing, building, stereo splitting, file concatenation.

**Actually tests:** Exactly what it claims. Pure functions with Buffer manipulation.

**What it misses:** Edge cases like corrupt headers, wrong sample rates between chunks, mono input to `splitStereoToMono`, empty files, very large files.

**What works well:** Round-trip test (build → parse → verify), channel isolation verification, concatenation with multiple chunks. These tests caught real bugs during development.

**Severity:** LOW — These tests are fine. They test pure functions that don't have integration boundary issues.

---

### 2.4 `src/audio/__tests__/whisper-e2e.test.ts` (4 tests, skip-guarded)

**Claims to test:** Real Whisper binary, real speech, no mocks.

**Actually tests:** When whisper is available: real transcription pipeline from WAV file through Whisper CLI to transcript JSON. Tests call `runWhisper()`, `transcribeSession()`, and verify `onIngest` callback.

**What it misses:**
- **Critical: Environment masking.** Lines 28-37 patch `process.env.PATH` and `PYTHONIOENCODING` at test file scope. This means the test passes even when the production code (`transcribe.ts`) doesn't set these. This is exactly bug #3 and #4.
- **Skip guard hides failures.** `describeIf = whisperAvailable ? describe : describe.skip` means on any environment without whisper (CI, fresh dev machines), all 4 tests silently pass. No failure, no warning in the test report.
- Test 3 ("full worker pipeline") constructs `WorkerDeps` manually with `{ sessionDb }` — no `onIngest`. This doesn't test the ingestion path.
- Test 4 ("full pipeline calls onIngest") does test `onIngest` but constructs deps manually, bypassing `initGatewayAudioCapture()`.

**What works well:** When it runs, it genuinely validates Whisper output parsing, stereo split + dual transcription, segment merging, file lifecycle (inbox → processed).

**Severity:** CRITICAL — The environment patching at test scope is the exact pattern that caused bugs #3 and #4. The skip guard means these tests provide *zero* signal on CI. A test suite that silently skips its most important tests is worse than having no tests — it gives false confidence.

---

### 2.5 `src/audio/__tests__/real-e2e.test.ts` (4 tests, skip-guarded)

**Claims to test:** "Real E2E pipeline — Binary chunks → HTTP upload → Whisper → Hippocampus. NO MOCKS except the LLM."

**Actually tests:** TypeScript HTTP upload → real ingest server → real Whisper worker → transcript JSON → `onIngest` callback.

**What it misses:**
- **Critical: Same environment masking as whisper-e2e.test.ts** (lines 31-40). PATH and PYTHONIOENCODING patched in test scope.
- **Critical: Same skip guard** — silently passes when whisper unavailable.
- **Does NOT test the Rust shipper.** Despite claiming "real E2E," it uses `rawRequest()` / `buildMultipart()` — a TypeScript HTTP client. The actual Rust `upload_chunk()` is never called. The test replicates what the Rust client *should* do, encoding the same assumptions.
- Constructs `createGatewayAudioHandler()` manually with hand-built deps (lines 280-288). Never calls `initGatewayAudioCapture()`.
- `onIngest` callback is a simple array push (line 260-262), not the real Librarian → Router → Cortex pipeline from `server-audio.ts`.
- Uses `loadChunkFixture(i)` — pre-split chunk files. The real pipeline starts with the capture engine writing chunks, not pre-made fixtures.

**What works well:** The polling loop (`pollSessionStatus`) with timeout is a realistic pattern. Testing that session-end triggers fire-and-forget transcription is valuable. The "session-end right after last chunk" test catches a real timing edge case.

**Severity:** CRITICAL — The "no mocks" claim in the docstring is false. It mocks: the Rust client, the environment (PATH/PYTHONIOENCODING), the gateway init, the onIngest pipeline, and the capture engine. Every integration boundary is still bypassed.

---

### 2.6 `src/audio/__tests__/cross-stack.test.ts` (5 tests)

**Claims to test:** "Rust shipper client → TypeScript ingest server" cross-stack compatibility.

**Actually tests:** TypeScript multipart HTTP requests (crafted to match reqwest output) → real TypeScript ingest server. Verifies field names (`session_id`, `sequence`, `audio`), URL paths, and backwards compatibility with `file` field name.

**What it misses:**
- **Does NOT actually run the Rust client.** Uses hand-crafted TypeScript multipart builder that "matches reqwest output byte-for-byte" (line 68). This is a claim, not a verified fact. If reqwest's multipart encoding differs (e.g., Content-Disposition quoting, boundary format, part ordering), this test won't catch it.
- Does not test sequence numbering contract. All uploads use explicit `sequence: "0"` or `String(seq)`. It doesn't test what the Rust shipper *actually* sends as the sequence value — which was the off-by-one bug.
- The companion Rust `field_contract.rs` test only checks constant values, not runtime behavior.
- Uses `createTestServer()` (test helper), not `createGatewayAudioHandler()` (production path).

**What works well:** The field name contract tests are genuinely useful — they prevent field name drift. The backwards-compat test for `"file"` vs `"audio"` is good defensive testing.

**Severity:** HIGH — Claims cross-stack testing but doesn't cross stacks. Both sides are tested in TypeScript. The Rust contract test only verifies string constants, not the multipart body the Rust client actually produces.

---

### 2.7 `src/audio/__tests__/gateway-wiring.test.ts` (9 tests)

**Claims to test:** Gateway audio wiring — route mounting, config loading, auth middleware, disabled bypass, session status.

**Actually tests:** `createGatewayAudioHandler()` with mock `IncomingMessage` / `ServerResponse` objects. `loadAudioCaptureConfig()` with various inputs.

**What it misses:**
- **Never tests `initGatewayAudioCapture()`** — the actual function called in `server.impl.ts` line 366. This is the function that constructs `WorkerDeps` with the real `onIngest` callback (lazy-importing Cortex, Router, Librarian). Bug #5 lived here.
- Mock request/response objects (lines 60-88) skip the actual HTTP parsing. `mockReq()` doesn't have a readable body stream, so POST tests can't actually upload data.
- The POST test for `/audio/chunk` (line 138) doesn't send any body — it just checks that the handler returns `true` (handled the route). The actual chunk upload path is untested through this handler.
- No test verifies that `workerDeps` is wired through to `session-end` → `triggerPendingTranscriptions`.

**What works well:** Config loading tests are thorough (defaults, partial, full). Route matching (audio vs non-audio paths) is solid. Auth tests work correctly with the mock approach. Disabled bypass test is useful.

**Severity:** HIGH — Tests the handler factory but not the init function. Bug #5 (ingestion never wired) lived in `initGatewayAudioCapture()`, which has zero test coverage.

---

### 2.8 `src/audio/__tests__/librarian-ingestion.test.ts` (5 tests)

**Claims to test:** Transcript Librarian Ingestion — onIngest callback, prompt building, truncation.

**Actually tests:** `buildLibrarianPrompt()` with `audio-capture://` URLs. String truncation logic. Does NOT test the actual `onIngest` callback in `server-audio.ts`.

**What it misses:**
- Never calls `transcribeSession()` with real Whisper to trigger `onIngest`.
- The `onIngest` test (line 128) doesn't call `transcribeSession` at all — it directly calls `buildLibrarianPrompt()` and checks the output. This tests the prompt builder, not the worker-to-ingestion wiring.
- The truncation test (line 141) manually replicates the truncation logic from `worker.ts` and tests *its own reimplementation*, not the actual production code.
- Never tests the real `onIngest` from `server-audio.ts` (lazy import of Cortex/Router, dispatch storage, Router enqueue).
- `createFakeChunks()` builds minimal WAV files but no test in this file actually uses them to run through `transcribeSession`.

**What works well:** `buildLibrarianPrompt()` tests verify transcript-specific guidance is included (action items, decisions, participants, deadlines). The URL-type discrimination test (audio-capture vs https) is useful.

**Severity:** MEDIUM — Tests the prompt builder correctly. The "onIngest callback" tests are misleading — they test prompt construction, not callback wiring.

---

### 2.9 Rust: `shipper/src/lib.rs` unit tests (8 tests)

**Claims to test:** ChunkShipper lifecycle, upload with retry, ordering, drain, failure handling.

**Actually tests:** Shipper against wiremock mock servers. Real async Tokio runtime, real file I/O, mock HTTP endpoint.

**What it misses:**
- **Wiremock doesn't validate multipart body content.** `Mock::given(method("POST")).and(path("/audio/chunk"))` matches any POST to `/audio/chunk`. It doesn't check that the multipart body contains `session_id`, `sequence`, or `audio` fields, or that their values are correct. The off-by-one bug (`or_insert(1)`) would have passed all these tests because wiremock just returns 200 regardless.
- `multi_chunk_ordering` test (line 510) uses `sess_chunk_{seq:04}.wav` — legacy filename format. The capture engine actually produces `{session}_chunk-{seq:04}_{timestamp}.wav`. Not testing the real filename format.
- No test verifies the HTTP body sent by `upload::upload_chunk()` contains correct field values.
- No test for what happens when the server returns an error body (e.g., 400 with JSON error).

**What works well:** Drain tests are thorough — immediate when empty, times out correctly, waits for upload, handles failed chunks. Stop/start lifecycle tests prevent resource leaks. Retry with backoff is tested.

**Severity:** HIGH — Tests check "did HTTP calls happen?" not "did HTTP calls contain correct data?" The off-by-one bug proves this gap is real.

---

### 2.10 Rust: `shipper/src/watcher.rs` unit tests (9 tests)

**Claims to test:** File watching, filename parsing, stability detection, pre-existing file scanning.

**Actually tests:** `parse_chunk_filename()` (both formats), `is_wav()`, `is_in_failed_dir()`, `scan_existing_files()`, `pending_for_session()`, `OutboxWatcher::next_file()`.

**What it misses:**
- No test for file created between `scan_existing_files()` and watcher registration — the chunk #0 race window.
- `watcher_detects_new_file` test uses legacy filename format (`sess1_chunk_0001.wav`), not capture engine format.
- No test for rapid file creation (multiple files within stability period).
- No test for file that gets deleted before stability period expires.

**What works well:** Filename parsing tests cover both formats with edge cases. `scan_existing_files` correctly sorts and excludes failed/. `pending_for_session` counting is well-tested. The stability detection concept is sound.

**Severity:** MEDIUM — Core logic is well-tested. The race condition gap (bug #2) is a real concern but hard to test deterministically.

---

### 2.11 Rust: `capture/src/chunker.rs` unit tests (8 tests)

**Claims to test:** ChunkWriter — WAV file creation, chunk rotation, flush behavior, minimum duration enforcement.

**Actually tests:** Exactly what it claims. Pure file I/O with hound WAV library.

**What it misses:**
- No test for interaction with the shipper's watcher (do filenames the chunker produces get parsed correctly by the shipper?). This is tested in `shipper_integration.rs` → `capture_engine_filenames_parseable_by_shipper`.
- No test for concurrent writes (multiple threads pushing samples).

**What works well:** Comprehensive. Rotation, sequence numbering, flush with minimum duration, file naming format, WAV validity. These are genuine unit tests that verify real behavior.

**Severity:** LOW — Good tests for a self-contained component.

---

### 2.12 Rust: `tray/tests/shipper_integration.rs` (8 tests)

**Claims to test:** Shipper wiring in the tray app — start/stop, chunk upload, session-end, full flow, pre-existing files, deduplication, config validation.

**Actually tests:** ChunkShipper against wiremock. File watching → HTTP upload → event emission.

**What it misses:**
- Same wiremock limitation — doesn't validate multipart body content.
- `capture_engine_filenames_parseable_by_shipper` (line 171) only tests filename *parsing*, not that the parsed sequence is correctly used in the upload body.
- Full flow test uses legacy filenames (`{session_id}_chunk_0000.wav`), not capture engine format with timestamps.
- No test connects to a real TypeScript ingest server.
- Pre-existing chunk test was added to fix bug #2, but the timing window race (file appears between scan and watch registration) is not actually tested.

**What works well:** Pre-existing + new chunks with dedup detection is a real integration concern. The `expect(N)` on wiremock at least catches duplicate uploads. Start/stop lifecycle test is practical.

**Severity:** HIGH — Same false confidence as lib.rs tests. Checks call counts, not call correctness.

---

### 2.13 Rust: `shipper/tests/field_contract.rs` (2 tests)

**Claims to test:** Cross-stack field name and URL path contract.

**Actually tests:** String constant values: `FIELD_SESSION_ID == "session_id"`, `FIELD_SEQUENCE == "sequence"`, `FIELD_AUDIO == "audio"`, paths match.

**What it misses:**
- Only tests that constants have the right values, not that `upload_chunk()` actually uses these constants when building the multipart body. A refactor that stops using the constants but hardcodes different strings would pass this test and break production.
- No equivalent assertion on the TypeScript side (the TS cross-stack test hardcodes the same strings but doesn't import them from a shared source).

**What works well:** It's a tripwire — if someone renames a Rust constant, this breaks. Better than nothing.

**Severity:** MEDIUM — Useful but insufficient. Constants matching ≠ behavior matching.

---

## Section 3: Integration Boundary Map

```
Capture Engine → Outbox → Watcher → Shipper → HTTP → Ingest Server → Inbox → Worker → Whisper → Transcript → Librarian → Library/Hippocampus
     (Rust)     (disk)   (Rust)    (Rust)   (net)     (TypeScript)   (disk)   (TS)    (Python)    (JSON)      (TS)        (TS/SQLite)
```

| Boundary | Tested? | By Which Test? | Real or Mock? |
|----------|---------|----------------|---------------|
| **Capture → Outbox** (ChunkWriter writes WAV to disk) | YES | `chunker.rs` unit tests | **REAL** — writes actual WAV files, reads back with hound |
| **Outbox → Watcher** (watcher detects new/existing files) | PARTIAL | `watcher.rs::watcher_detects_new_file`, `shipper_integration::pre_existing_chunk_uploaded` | **REAL** file I/O, but legacy filenames, no race condition test |
| **Watcher → Shipper** (watcher sends path, shipper parses filename → session + sequence) | YES | `shipper_integration::capture_engine_filenames_parseable_by_shipper` | **REAL** parsing, but no test that parsed sequence matches upload body |
| **Shipper → HTTP** (Rust `upload_chunk()` sends multipart POST) | PARTIAL | `lib.rs` and `shipper_integration.rs` tests | **MOCK server** (wiremock). Server accepts anything. Body content never validated. |
| **HTTP → Ingest Server** (TS server receives multipart, parses, stores) | YES | `ingest.test.ts`, `cross-stack.test.ts` | **MOCK client** (hand-crafted multipart). Never receives from real Rust client. |
| **Ingest → Inbox** (server writes chunk to disk as `chunk-NNNN.wav`) | YES | `ingest.test.ts` | **REAL** file I/O |
| **Inbox → Worker** (session-end triggers `transcribeSession`) | PARTIAL | `real-e2e.test.ts` | Worker triggered via `createGatewayAudioHandler`, but deps are hand-constructed |
| **Worker → Whisper** (worker shells out to whisper CLI) | PARTIAL | `whisper-e2e.test.ts`, `real-e2e.test.ts` | **REAL** whisper when available, but **PATH is patched in test scope**, hiding production PATH issues |
| **Whisper → Transcript** (worker parses JSON output → Transcript struct) | YES | `whisper-e2e.test.ts` (when whisper available) | **REAL** |
| **Transcript → Librarian** (worker calls `onIngest` with prompt) | PARTIAL | `whisper-e2e.test.ts` test 4, `librarian-ingestion.test.ts` | **MOCK** — `onIngest` is a spy/stub, not the real Librarian pipeline |
| **Librarian → Library/Hippocampus** (Router dispatches, executor runs, facts extracted) | NO | None | **UNTESTED** — `server-audio.ts` `onIngest` with lazy imports of Cortex/Router is never exercised |
| **Gateway init → Handler** (`initGatewayAudioCapture()` → handler + deps) | NO | None | **UNTESTED** — Bug #5 lived here |

### Summary: Of 12 boundaries, **3 are untested**, **5 use mocks on one side**, **1 has a race condition gap**, and only **3 are tested with real components on both sides** (and two of those are file I/O within the same language).

---

## Section 4: Gap Analysis

### 4.1 Environment Dependencies

| Dependency | Production Location | Test Coverage | Status |
|------------|-------------------|---------------|--------|
| `whisper` binary on PATH | `transcribe.ts` → `execFileAsync()` | Tests patch PATH at test file scope; skip when unavailable | **CRITICAL GAP** — Bugs #3, #4 |
| `ffmpeg` binary on PATH | Required by whisper internally | Tests patch PATH at test file scope | **CRITICAL GAP** — Bug #4 |
| `PYTHONIOENCODING=utf-8` | `transcribe.ts` line 168 (in `execFileAsync` env) | Tests set `process.env.PYTHONIOENCODING` at file scope | **Was a gap, now fixed** in production code |
| WinGet ffmpeg install path | `transcribe.ts` lines 18-24 (hardcoded path) | Tests replicate the same hardcoded path | **Fragile** — breaks on different ffmpeg versions or install methods |
| `node:sqlite` availability | `session-store.ts`, `server-audio.ts` | Tests use `requireNodeSqlite()` | OK |

### 4.2 Gateway Wiring

| Concern | Test Coverage | Status |
|---------|---------------|--------|
| `initGatewayAudioCapture()` called with correct config | None | **CRITICAL GAP** — Bug #5 |
| `workerDeps.onIngest` wired with Cortex/Router lazy imports | None | **CRITICAL GAP** |
| `initGatewayAudioCapture()` returns null when disabled | None (tested on handler, not init) | **GAP** |
| Audio handler mounted in gateway HTTP server | None | **GAP** — `server.impl.ts` lines 363-373 are untested |
| Audio handler cleanup on shutdown | None | **GAP** — `server.impl.ts` line 796 |

### 4.3 Sequence Numbering Contract

| Concern | Test Coverage | Status |
|---------|---------------|--------|
| Chunker starts at sequence 0 | `chunker.rs` tests verify `chunk-0000` | OK |
| Shipper sends sequence from filename | `field_contract.rs` checks constant name | **Partial** — constant name ≠ runtime value |
| Shipper's `next_seq` starts at 0 | `lib.rs` line 131: `or_insert(0)` | **Was bug #1** — no test specifically asserts the starting sequence |
| Server accepts sequence 0 | `ingest.test.ts` sends sequence "0" | OK |
| Gap detection is 0-based | `ingest.ts` `detectSequenceGaps()` loops from 0 | OK |

### 4.4 Error Paths

| Scenario | Test Coverage | Status |
|----------|---------------|--------|
| Whisper binary not found (ENOENT) | Skip guard hides this | **GAP** |
| Whisper returns non-zero exit | Not tested | **GAP** |
| Whisper produces malformed JSON | Not tested | **GAP** |
| Whisper timeout (hangs on large file) | Not tested | **GAP** |
| Upload fails with 4xx (rejected by server) | `lib.rs::drain_session_with_failed_chunk_not_blocked` tests 500 | **Partial** |
| Upload fails with network error | Not tested | **GAP** |
| DB locked during session update | Not tested | **GAP** |
| Disk full during chunk write | Not tested | **GAP** |
| onIngest callback throws | `server-audio.ts` has try/catch, but untested | **GAP** |

### 4.5 Timing and Ordering

| Scenario | Test Coverage | Status |
|----------|---------------|--------|
| File created before watcher starts | `shipper_integration::pre_existing_chunk_uploaded_on_startup` | **Partial** — tests pre-existing file but not race window |
| Session-end before all chunks uploaded | `lib.rs::drain_session_waits_for_upload` | OK (Rust side) |
| Rapid chunk creation (faster than stability period) | Not tested | **GAP** |
| Worker triggered while previous session still transcribing | Not tested | **GAP** |
| `drain_session` timeout + session-end ordering | Tested in lib.rs | OK |

---

## Section 5: Recommendations

### Priority 1: CRITICAL — Tests that would have caught production bugs

#### R1. Gateway init integration test
**What:** Test `initGatewayAudioCapture()` with realistic config. Verify it returns a handler that, when session-end is called, actually triggers transcription with onIngest callback.
**What to verify:** `workerDeps.onIngest` is defined and callable. Handler accepts chunks and triggers worker on session-end. This would have caught bug #5.
**Real or mock:** Real SQLite, real handler. Mock the lazy imports (Cortex/Router) with stubs that verify they're called.
**Complexity:** MEDIUM

#### R2. Remove environment patching from tests
**What:** Delete the PATH and PYTHONIOENCODING patching from `whisper-e2e.test.ts` and `real-e2e.test.ts` (lines 28-37 in both files). The production code (`transcribe.ts` lines 18-24, 168) now handles this. If tests can't find whisper without patching, that means the production code also can't — which is exactly what you want the test to tell you.
**What to verify:** Tests still pass *without* the test-scope environment patches. If they don't, the production code fix is incomplete.
**Real or mock:** N/A — removal of mocking.
**Complexity:** SMALL

#### R3. Replace skip guard with explicit failure
**What:** Change `describeIf = whisperAvailable ? describe : describe.skip` to a CI-aware pattern: on CI, fail loudly if whisper is missing. Locally, skip is fine.
**What to verify:** CI pipeline either (a) installs whisper and runs the tests, or (b) explicitly marks them as "known missing" with a tracked issue.
**Real or mock:** N/A — test infrastructure.
**Complexity:** SMALL

#### R4. Rust upload body assertion
**What:** Add a wiremock `Mock::given()` matcher that inspects the multipart body for correct `session_id`, `sequence`, and `audio` field values. Alternatively, capture the request body in a handler and assert on it.
**What to verify:** The multipart body produced by `upload::upload_chunk()` contains `sequence=0` for the first chunk (not `sequence=1`). This would have caught bug #1.
**Real or mock:** Still uses wiremock, but with content validation.
**Complexity:** MEDIUM

#### R5. True cross-stack test (Rust client → TS server)
**What:** Write a test that runs the real Rust `upload_chunk()` function against a real TypeScript ingest server in the same process (or via subprocess). Not hand-crafted multipart in TypeScript.
**What to verify:** Rust client's multipart encoding is accepted by TS server. Sequence numbers arrive correctly. File data round-trips.
**Real or mock:** Real on both sides. This is the test that the "cross-stack" tests claim to be but aren't.
**Complexity:** LARGE — requires Rust-to-Node interop or subprocess orchestration.

### Priority 2: HIGH — Gaps that could cause future production issues

#### R6. Whisper failure mode tests
**What:** Test `runWhisper()` behavior when: binary not found (expect clear error, not ENOENT), exit code non-zero (expect error with stderr), output JSON malformed (expect parse error), output file missing (expect clear error).
**What to verify:** Each failure mode produces a `WorkerResult` with `status: "failed"` and a useful error message, not an unhandled exception.
**Real or mock:** Mock the `execFile` call to simulate each failure. These are legitimate mocks — you're testing error handling, not whisper itself.
**Complexity:** MEDIUM

#### R7. Worker → onIngest integration test
**What:** Test `transcribeSession()` with a real WAV fixture, real Whisper (when available), and a real `onIngest` callback. Verify the prompt contains the transcript text and the `audio-capture://` URL.
**What to verify:** The `onIngest` callback is actually called (not just that `buildLibrarianPrompt` returns the right string).
**Real or mock:** Real whisper, real worker, spy on onIngest.
**Complexity:** MEDIUM (builds on existing whisper-e2e test 4, which already does this — just need to verify it runs on CI)

#### R8. Ingest test modernization
**What:** Update `ingest.test.ts` to use `"audio"` as the file field name (matching the Rust client), not `"file"`. Add a test that explicitly verifies *only* `"audio"` works for new clients (backwards compat for `"file"` is fine but should be documented as deprecated).
**What to verify:** The test exercises the current contract, not the legacy one.
**Real or mock:** Same test structure, updated field names.
**Complexity:** SMALL

### Priority 3: MEDIUM — Hardening

#### R9. Sequence numbering contract test
**What:** Add a specific test (Rust or TS) that creates chunks 0, 1, 2 via ChunkWriter → ships via ChunkShipper → receives at ingest server → verifies files are `chunk-0000.wav`, `chunk-0001.wav`, `chunk-0002.wav`. Explicitly asserts 0-based indexing at every step.
**What to verify:** The sequence numbering contract is maintained end-to-end. No off-by-one at any boundary.
**Real or mock:** Ideally real on both sides (Priority 1 R5). Minimum: Rust side asserts upload body, TS side asserts stored filename.
**Complexity:** MEDIUM

#### R10. Delete or rewrite tautological tests
**What:** Remove "speaker labeling" tests from `transcribe.test.ts` (lines 120-139) — they create hardcoded data and assert their own values. Remove the "mocked runWhisper" test that manually replicates parsing logic instead of calling the function.
**What to verify:** Test count goes down, signal goes up.
**Real or mock:** N/A — cleanup.
**Complexity:** SMALL

#### R11. Gateway handler mount test
**What:** Test that `startGatewayServer()` (or a realistic subset) mounts the audio handler and it's reachable via HTTP. Doesn't need full gateway — just verify the audio routes are registered.
**What to verify:** `POST /audio/chunk` reaches the audio handler, not a 404.
**Real or mock:** Real HTTP server, mock everything else (channels, Cortex, etc).
**Complexity:** LARGE (gateway startup has many dependencies)

---

## Appendix: What's Working Well

Not everything is broken. Credit where due:

1. **WAV utilities** (`wav-utils.test.ts`) — Pure function tests with real data. No mocks needed, no integration boundaries. These caught bugs during development and continue to provide value.

2. **Chunker tests** (`chunker.rs`) — Solid unit tests for a self-contained component. Rotation, naming, flush behavior, minimum duration. Well-scoped, no false claims.

3. **Auth tests** (`ingest.test.ts`) — Thorough coverage of auth edge cases. These are unit tests of a specific boundary (HTTP auth) and they do it well.

4. **Drain tests** (`lib.rs`) — The drain_session family tests complex async behavior with real timers. They test timeout, wait-for-upload, and failed-chunk-not-blocked scenarios. Good async testing.

5. **Field contract test** (`field_contract.rs`) — While insufficient alone, it's a good tripwire that prevents accidental constant drift. Just needs to be paired with runtime behavior tests.

6. **Concurrent sessions** (`ingest.test.ts`) — Tests that two sessions uploading simultaneously don't interfere. This is a real production concern and the test is valid.

---

## Conclusion

The test suite has **~92 tests across TypeScript and Rust**, all reporting green. **5 out of 5 production bugs were missed.** The root cause is systematic: every integration boundary between components is tested with a mock on at least one side, and the mocks encode assumptions that turned out to be wrong.

The most damaging pattern is **environment masking** — tests that patch `process.env.PATH` at test scope, making tests pass in environments where production code would fail. Combined with skip guards that silently pass when the real binary isn't available, this creates a test suite that actively lies about system readiness.

The second most damaging pattern is **claiming integration testing while mocking both sides**. The cross-stack test uses a TypeScript client pretending to be Rust. The real-e2e test claims "no mocks" while mocking the client, the environment, the gateway init, and the ingestion pipeline. These tests give false confidence — they make developers believe boundaries are tested when they aren't.

**The fix is not more tests. The fix is fewer mocks at the boundaries that matter.**
