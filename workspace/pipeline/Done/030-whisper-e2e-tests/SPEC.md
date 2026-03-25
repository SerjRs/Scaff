---
id: "030"
title: "Real Whisper E2E Tests (no mocks)"
priority: high
created: 2026-03-18
author: scaff
type: test
branch: feat/030-whisper-e2e-tests
tech: typescript
---

# 030 — Real Whisper E2E Tests

## Problem

All existing audio pipeline tests mock Whisper. The 62 TypeScript audio tests and the in-process E2E test (`test-audio-e2e.test.ts`) never invoke the real `whisper` binary. The external E2E script (`test-audio-e2e.ts`) can hit a live gateway but uses sine waves (no speech) — Whisper produces empty/garbage transcripts from pure tones.

We need tests that prove the **entire pipeline** works end-to-end with real Whisper: speech WAV in → Whisper CLI → valid transcript out → Hippocampus facts.

## Prerequisites

- `whisper` on PATH (confirmed: `C:\Users\Temp User\AppData\Local\Python\pythoncore-3.14-64\Scripts\whisper.exe`)
- Model `base.en` (will auto-download on first run, ~150MB)
- Python 3.14+ (confirmed installed)

## What To Build

### 1. Speech test fixture

Create a script that generates a WAV file containing **text-to-speech audio** using a readily available TTS method. Options (in order of preference):

**Option A — Pre-recorded fixture (simplest):**
Record a short (5-10s) WAV file with clear English speech and commit it. Content: a few distinct sentences that Whisper can reliably transcribe. Example: "The meeting is scheduled for Tuesday at three PM. Action item: review the quarterly report by Friday."

**Option B — Use `edge-tts` or `pyttsx3` to generate speech at test time:**
```bash
pip install edge-tts
edge-tts --text "The meeting is scheduled for Tuesday at three PM" --write-mp3 test-speech.mp3
ffmpeg -i test-speech.mp3 -ar 16000 -ac 1 test-speech.wav
```

**Decision:** Use Option A. Commit a pre-recorded stereo WAV fixture (`fixtures/test-speech-10s.wav`) with known content. This avoids runtime dependencies on TTS tools. The expected transcript text is stored alongside for assertion.

**Fixture spec:**
- File: `tools/cortex-audio/fixtures/test-speech-10s.wav`
- Format: stereo, 16-bit PCM, 16000 Hz (Whisper's native rate — avoids resampling)
- Duration: ~10 seconds
- Content: clear English speech with 2-3 distinct sentences
- Left channel: speech (simulating "user" mic)
- Right channel: silence or different speech (simulating "others"/speakers)
- Expected text file: `tools/cortex-audio/fixtures/test-speech-10s.expected.txt`

**How to create it:**
```powershell
# Use PowerShell SpeechSynthesizer to generate speech
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile("left-channel.wav")
$synth.Speak("The meeting is scheduled for Tuesday at three PM. Action item: review the quarterly report by Friday.")
$synth.Dispose()
# Then use node script to make it stereo (left=speech, right=silence) at 16kHz
```

### 2. Test file: `src/audio/__tests__/whisper-e2e.test.ts`

**This test file runs real Whisper.** It should be:
- In a separate test file so it can be skipped in CI or fast-test runs
- Guarded by a `whisper` availability check (skip if not on PATH)
- Slower (10-30s per test is expected)

#### Test 1: `whisper produces valid JSON output from speech`
- Input: `test-speech-10s.wav` (mono, left channel extracted)
- Run `runWhisper()` from `src/audio/transcribe.ts` with `whisperModel: "base.en"`
- Assert: returns non-empty `TranscriptSegment[]`
- Assert: at least one segment contains recognizable words from the expected text
- Assert: segments have valid `start < end` timestamps

#### Test 2: `stereo split + whisper produces two-channel transcript`
- Input: `test-speech-10s.wav` (stereo)
- Run `splitStereoToMono()` from `src/audio/wav-utils.ts`
- Run `runWhisper()` on left channel → segments with speaker="user"
- Run `runWhisper()` on right channel → segments with speaker="others"
- Assert: left channel produces meaningful transcript (speech)
- Assert: right channel produces empty or minimal transcript (silence/no speech)
- Run `mergeSegments()` → combined timeline
- Assert: merged result is sorted by timestamp

#### Test 3: `full worker pipeline with real Whisper`
- Create temp `data/audio` directory structure
- Write test-speech WAV as `chunk-0000.wav` in inbox
- Create in-memory SQLite DBs (session store, library, bus)
- Call `transcribeSession()` from `src/audio/worker.ts`
- Assert: session status goes to "done"
- Assert: transcript JSON is written to `transcripts/` dir
- Assert: transcript contains non-empty `fullText`
- Assert: transcript `segments` have valid timestamps and speaker labels
- Assert: audio files moved from `inbox/` to `processed/`

#### Test 4: `full pipeline with ingestion into Hippocampus`
- Same as Test 3 but with `ingestion` deps provided (real Library + Hippocampus DBs)
- Mock only the LLM for fact extraction (use a simple stub that returns 2-3 hardcoded facts)
- Assert: Library article created with title containing "Meeting Transcript"
- Assert: `factsInserted > 0`
- Assert: `edgesInserted > 0`

### 3. Test runner config

Add a vitest tag or filename pattern so these tests can be run separately:

```powershell
# Fast tests (mocked, <5s)
npx vitest run src/audio/__tests__/ingest.test.ts src/audio/__tests__/transcribe.test.ts

# Real Whisper tests (slow, requires whisper on PATH)
npx vitest run src/audio/__tests__/whisper-e2e.test.ts
```

### 4. Skip guard

At the top of `whisper-e2e.test.ts`:

```typescript
import { execFileSync } from "node:child_process";

let whisperAvailable = false;
try {
  execFileSync("whisper", ["--help"], { timeout: 5000, stdio: "pipe" });
  whisperAvailable = true;
} catch {
  // whisper not available
}

const describeIf = whisperAvailable ? describe : describe.skip;

describeIf("Whisper E2E (real binary)", () => {
  // ... tests ...
});
```

## Files to Create

| File | Description |
|------|-------------|
| `tools/cortex-audio/fixtures/test-speech-10s.wav` | Stereo WAV with speech (left) + silence (right) |
| `tools/cortex-audio/fixtures/test-speech-10s.expected.txt` | Expected transcript content for assertions |
| `tools/cortex-audio/fixtures/generate-speech-fixture.ps1` | Script to regenerate the speech fixture |
| `src/audio/__tests__/whisper-e2e.test.ts` | Real Whisper E2E tests |

## Files to Modify

None. All new files.

## Done Criteria

- Speech fixture committed and produces reliable Whisper output
- 4 tests that exercise real Whisper binary
- Tests skip gracefully when whisper not on PATH
- All 4 tests pass on this machine
- All 62 existing mocked tests still pass
- Committed, merged to main

## ⚠️ Why This Test Failed In Production (2026-03-18 Post-Mortem)

This test was marked "Done" and all 4 tests passed. Yet the live pipeline failed. Here's why:

### 1. Environment mismatch — test patched its own PATH
The test hardcodes the WinGet ffmpeg path and adds it to `process.env.PATH` at runtime (lines 39-43). The gateway process doesn't have this. So the test finds ffmpeg, Whisper works. The gateway can't find ffmpeg, Whisper crashes with `FileNotFoundError`. **The test proved Whisper works in the test process, not in the gateway.**

### 2. Environment mismatch — PYTHONIOENCODING
The test sets `process.env.PYTHONIOENCODING = "utf-8"` at runtime. The gateway didn't have this set. Same pattern: test fixes its own environment, production doesn't have the fix.

### 3. Never tested the gateway code path
The test calls `runWhisper()` and `transcribeSession()` directly — the same functions the gateway calls. But it constructs `WorkerDeps` manually with all dependencies perfectly wired. The gateway's `initGatewayAudioCapture()` was missing `ingestionDeps`, so ingestion was silently skipped. **The test proved the worker works when given correct deps. It didn't prove the gateway gives it correct deps.**

### 4. Skip guard masks failures
When Whisper isn't on PATH, the entire suite is skipped with `describe.skip`. This means in any CI or fresh environment, 0 tests run and the suite reports green. A skipped test is not a passing test.

### What Needs To Change

- **Test must verify the gateway environment**, not just the worker functions
- **Test must NOT patch its own PATH** — if ffmpeg/whisper aren't available system-wide, the test should FAIL, not silently fix itself
- **Test must verify deps wiring** — call `initGatewayAudioCapture()` and verify `workerDeps` has all fields populated
- **Skip guard should emit a visible warning**, not silently skip
- Consider a "deployment readiness" test that checks: whisper on PATH? ffmpeg on PATH? PYTHONIOENCODING set? Config has full binary paths?

## Revision Comments (from TESTS-REVISION-REPORT.md, 2026-03-19)

### RC-1: Remove environment patching (R2) — CRITICAL
Delete the PATH and PYTHONIOENCODING patching from `whisper-e2e.test.ts` (lines 28-37). The production code (`transcribe.ts` lines 18-24, 168) now handles this. If tests can't find whisper without patching, that means the production code also can't — which is exactly what the test should tell you.

### RC-2: Replace skip guard with explicit failure (R3) — CRITICAL
Change `describeIf = whisperAvailable ? describe : describe.skip` to a CI-aware pattern: on CI, fail loudly if whisper is missing. Locally, skip is acceptable. A silently skipped test suite reports green and gives false confidence.

### RC-3: Delete tautological tests (R10) — MEDIUM
Remove "speaker labeling" tests from `transcribe.test.ts` (lines 120-139) — they create hardcoded data and assert their own values. Remove the "mocked runWhisper" test that manually replicates parsing logic instead of calling the function. Test count goes down, signal goes up.

### RC-4: Add Whisper failure mode tests (R6) — HIGH
Test `runWhisper()` behavior when:
- Binary not found → expect clear error, not unhandled ENOENT
- Exit code non-zero → expect error with stderr content
- Output JSON malformed → expect parse error
- Output file missing → expect clear error
Mock `execFile` to simulate each failure. These are legitimate mocks — testing error handling, not Whisper itself.

### RC-5: Test must verify gateway environment (from post-mortem)
Do NOT test `runWhisper()` in isolation with perfect deps. Call `initGatewayAudioCapture()` → verify `workerDeps` is fully wired → trigger session-end → verify Whisper is actually invoked. If the gateway can't find Whisper, the test must fail.

## Notes

- First run may be slow (~60s) as Whisper downloads the base.en model
- Tests write to temp directories and clean up after themselves
- The speech content should be "meeting-like" to match the pipeline's expected use case
- Use `base.en` model (smallest English-only, ~150MB) for speed
- Whisper on Windows with Python 3.14 has a stderr encoding issue (`cp1252` vs Unicode) — tests should capture stderr but not fail on encoding warnings
