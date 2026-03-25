# STATE — 032 Real E2E Pipeline Test (Rewrite)

## Status: DONE (Rewrite)

**Branch:** `feat/032-real-e2e-rewrite` (merged to main)
**Commit:** `f34b45af9` — `032: rewrite server-side E2E tests — real gateway init, no env patching, 0-based sequences`
**Date:** 2026-03-19

## What Changed (Rewrite)

Rewrote `src/audio/__tests__/real-e2e.test.ts` from scratch. Old file: 493 lines, 4 tests, all boundaries mocked. New file: 326 lines, 6 tests, real production init path.

### Old vs New

| Concern | Old Test | New Test |
|---------|----------|----------|
| Gateway init | `createGatewayAudioHandler()` with hand-built deps | `initGatewayAudioCapture()` — production path |
| Environment | Patched PATH + PYTHONIOENCODING at module scope | Zero patching — production code handles it |
| Skip guard | `describe.skip` silently on all envs | CI fails loudly, local warns |
| First sequence | 0 (correct) | 0 (correct, verified) |
| Field name | `"audio"` (correct) | `"audio"` (correct, verified) |
| WorkerDeps | Manual construction with spy onIngest | Suite 1: real init (onIngest hits Cortex lazy-require, fails gracefully). Suite 2: spy for prompt content verification |
| Naming | "Real E2E pipeline" | "Server-side E2E pipeline" (honest) |

### Tests Written (6 total)

1. **server-side E2E: 3 chunks → Whisper → transcript** — Happy path through initGatewayAudioCapture. Uploads 3 speech chunks, verifies transcript JSON, segment structure, file lifecycle (inbox → processed).
2. **session-end right after last chunk — no lost data** — Timing edge case. No delay between last chunk and session-end.
3. **single chunk session works** — Minimum viable session (1 chunk).
4. **missing chunk 0 → session fails** — Uploads chunks 1,2 only. Verifies sequence gap detection and session failure.
5. **initGatewayAudioCapture returns valid handle** — Verifies handler, db, config, data dirs created by the real init function (the function that was NEVER tested before — bug #5).
6. **onIngest callback receives Librarian prompt** — Separate suite with spy to verify prompt contains `audio-capture://` URL and Librarian instructions.

### Bugs Found in Source Code

None. Production code is correct. The `initGatewayAudioCapture` onIngest callback correctly catches missing Cortex/Router modules in test context via try/catch (line 111 of server-audio.ts).

### Skip Guard Detail

The whisper availability check needed `PYTHONIOENCODING=utf-8` in the child process env (not in `process.env`) because `whisper --help` outputs Unicode characters that fail on cp1252 console encoding. This matches the production pattern in `transcribe.ts:177`.

## Test Results

```
Test Files  8 passed (8)
     Tests  82 passed (82)
  Duration  98.51s
```

All 82 audio tests pass. Zero failures, zero skips (whisper available on this machine).

## Done Criteria Checklist

- [x] real-e2e.test.ts rewritten with honest naming
- [x] initGatewayAudioCapture() exercised (Suite 1 + Test 5)
- [x] No environment patching in test files
- [x] Sequences start at 0
- [x] Multipart matches Rust client format (field "audio")
- [x] onIngest callback verified (Suite 2)
- [x] All tests pass, 0 skipped
- [x] No source bugs found
- [x] Clean commit, merged to main, pushed
- [x] STATE.md created

## Previous State (Pre-Rewrite)

1. **Chunk splitter script** — `tools/cortex-audio/fixtures/split-speech-chunks.mjs` splits `test-speech-10s.wav` into 3 stereo WAV chunks (~2.5s each)
2. **Original E2E test** — 4 tests using `createGatewayAudioHandler` with manual deps, PATH patching, silent skip guard
3. **Commit** — `f7bdbd6fe` on `feat/032-real-e2e-pipeline-test`, merged to `main`
