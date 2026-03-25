# 042 — Deployment Readiness Check — STATE

## Status: DONE

## What Was Built

`src/audio/__tests__/deployment-readiness.test.ts` — 7 tests verifying all runtime dependencies work through production code paths.

### Tests Written

| # | Test | What It Verifies |
|---|------|-----------------|
| 1 | `whisperBinary config resolves to existing file` | Production config path exists on disk or binary is on PATH |
| 2 | `whisper binary spawns successfully (--help)` | Whisper spawns without ENOENT using production env handling |
| 3 | `ffmpeg binary is available to whisper` | After `transcribe.ts` module load, ffmpeg is on PATH |
| 4 | `PYTHONIOENCODING is set in whisper child process env` | Production code sets `PYTHONIOENCODING: "utf-8"` in execFile env |
| 5 | `initGatewayAudioCapture produces working pipeline end-to-end` | Full chain: config → HTTP server → chunk upload → session-end → whisper invocation → transcript |
| 6 | `config whisperBinary with full absolute path works` | Absolute path from openclaw.json is executable |
| 7 | `production code adds whisper/ffmpeg dirs to PATH at module load` | transcribe.ts PATH additions verified |

### Key Design Decisions

- **Zero env patching**: No `process.env.PATH` modification in test scope. Tests rely on production code's own PATH handling in `transcribe.ts` (module-level FFMPEG_DIR and PYTHON_SCRIPTS_DIR additions).
- **Zero skip guards**: Every test runs. If whisper/ffmpeg is missing, the test FAILS with an actionable message ("Install via: pip install openai-whisper" or "winget install ffmpeg").
- **Real initGatewayAudioCapture**: Test 5 calls the actual production init function, starts an HTTP server, uploads a real speech WAV, triggers session-end, and polls until whisper completes.
- **UUID session IDs**: Test 5 uses `crypto.randomUUID()` since the ingest server validates UUIDs.

### Bugs Found

None. The production code (`transcribe.ts`) already handles PATH and PYTHONIOENCODING correctly after previous fixes. The tests confirm this.

### Test Results

- **All 7 new tests pass**
- **All 114 audio tests pass** (12 test files, zero failures, zero skips)
- Duration: ~104s total (whisper CPU transcription is slow)

## Commit

```
354b980a3 042: deployment readiness check — verify runtime deps without env patching
```

Merged to `main`, pushed.
