# STATE — 025g E2E Pipeline Test

## STATUS: COMPLETE
## Last Updated: 2026-03-17

## Progress
- [x] cargo build --release — succeeded, binary 1.9 MB at tools/cortex-audio/target/release/cortex-audio.exe
- [x] Create test WAV fixtures — 4 files in tools/cortex-audio/fixtures/ (all < 100 KB)
- [x] Create E2E test script — scripts/test-audio-e2e.ts (manual runner) + scripts/test-audio-e2e.test.ts (vitest smoke)
- [x] Create USAGE.md — tools/cortex-audio/USAGE.md with build, config, manual test, and architecture docs
- [x] Run all existing tests — 62 passed (4 test files)
- [x] Run new E2E smoke tests — 6 passed
- [x] Commit, merge to main, push

## Files Created
- `scripts/test-audio-e2e.ts` — standalone E2E test runner (requires gateway + Whisper)
- `scripts/test-audio-e2e.test.ts` — in-process vitest smoke test (6 tests, no external deps)
- `tools/cortex-audio/USAGE.md` — build, run, and manual test documentation
- `tools/cortex-audio/fixtures/generate-fixtures.mjs` — WAV fixture generator
- `tools/cortex-audio/fixtures/test-stereo-3s.wav` — 3s stereo WAV (94 KB)
- `tools/cortex-audio/fixtures/test-chunk-00.wav` — 1s stereo WAV (31 KB)
- `tools/cortex-audio/fixtures/test-chunk-01.wav` — 1s stereo WAV (31 KB)
- `tools/cortex-audio/fixtures/test-chunk-02.wav` — 1s stereo WAV (31 KB)

## Test Results
- Existing audio tests: 62/62 passed
- New E2E smoke tests: 6/6 passed
- Total: 68/68 passed

## Decisions Made
- Used 8 kHz sample rate for committed fixtures to stay under 100 KB each (spec constraint). E2E test script generates its own 44.1 kHz WAVs at runtime.
- Created both a standalone script (scripts/test-audio-e2e.ts for real gateway testing) and a vitest file (scripts/test-audio-e2e.test.ts for CI).
- Vitest smoke test validates HTTP API + WAV processing pipeline without Whisper (verifies chunks upload, session lifecycle, WAV concatenation, stereo split).
- Full 30s fixture omitted (would be 5+ MB at 44.1 kHz). Generator can produce any duration.

## Errors
(none)
