# STATE — 030 Whisper E2E Tests

## Status: COMPLETE

## Results

- **4/4 tests passing** with real Whisper binary (base.en model, CPU)
- **66/66 total audio tests passing** (62 existing mocked + 4 new E2E)
- Tests skip gracefully when `whisper` not on PATH (`describe.skip`)
- Committed, merged to main, pushed — commit `6bbceb64a`

## Test Timing (CPU, no GPU)

| Test | Duration |
|------|----------|
| whisper produces valid JSON output from speech | ~13s |
| stereo split + whisper produces two-channel transcript | ~16s |
| full worker pipeline with real Whisper | ~16s |
| full pipeline with ingestion into Hippocampus | ~16s |
| **Total** | **~62s** |

## Files Created

| File | Description |
|------|-------------|
| `src/audio/__tests__/whisper-e2e.test.ts` | 4 real Whisper E2E tests |
| `tools/cortex-audio/fixtures/test-speech-10s.wav` | Stereo WAV (16kHz, 16-bit, 7.4s) — left=speech, right=silence |
| `tools/cortex-audio/fixtures/test-speech-10s.expected.txt` | Expected transcript text |
| `tools/cortex-audio/fixtures/generate-speech-fixture.ps1` | PowerShell TTS script to regenerate fixture |
| `tools/cortex-audio/fixtures/make-stereo-16k.mjs` | Node helper to convert mono→stereo 16kHz |

## Notes

- FFmpeg was installed via `winget install Gyan.FFmpeg` (required by Whisper for audio loading)
- Whisper base.en model auto-downloaded on first run (~139MB)
- Tests set `PYTHONIOENCODING=utf-8` and add ffmpeg to PATH at runtime
- Right channel (silence) test uses `lessThan` comparison since Whisper may hallucinate on silence
