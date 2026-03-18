---
id: "025g"
title: "E2E Pipeline Test — Full Audio Capture to Knowledge Graph"
priority: high
assignee: scaff
status: cooking
created: 2026-03-17
updated: 2026-03-17
type: feature
parent: "025"
depends_on: ["025f"]
tech: [rust, typescript]
---

# E2E Pipeline Test — Full Audio Capture to Knowledge Graph

## Goal

Validate the complete meeting transcription pipeline end-to-end: tray app starts capture → audio chunks ship to the gateway → ingest API stores them → Whisper transcribes → facts appear in the Hippocampus knowledge graph.

This is the final task in the 025 series. After this, the system is production-ready.

## Prerequisites

- 025f (Gateway Audio Wiring) is complete — routes mounted, config added, Hippocampus integration wired
- Whisper CLI installed and working (`whisper --help` succeeds)
- Rust toolchain available (`cargo build` works)

## Deliverables

### 1. Release Build

Build the Rust client binary for production use:

```powershell
cd tools/cortex-audio
cargo build --release
```

Output: `tools/cortex-audio/target/release/cortex-audio.exe`

Verify:
- Binary size (should be ~3-10 MB)
- Starts without errors
- Shows tray icon
- Config file created at `%LOCALAPPDATA%\CortexAudio\config.json`

### 2. Client Configuration

Set the server URL in the client config to point at the local gateway:

```json
{
  "server_url": "http://127.0.0.1:18789",
  "api_key": "<matching audio.apiKey from openclaw.json>",
  "chunk_duration_secs": 30,
  "sample_rate": 44100,
  "channels": 2,
  "silence_threshold": 0.01,
  "silence_duration_secs": 3.0
}
```

### 3. Gateway Configuration

Ensure `openclaw.json` has audio enabled:

```json
{
  "audio": {
    "enabled": true,
    "apiKey": "<generate-a-key>",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "whisperBinary": "whisper",
    "whisperModel": "base.en",
    "whisperLanguage": "en",
    "whisperThreads": 4
  }
}
```

### 4. E2E Test Script

Create `scripts/test-audio-e2e.ts` (or `.ps1`) that automates the full pipeline test without needing real microphone input:

**Test flow:**

1. **Generate test audio**: Create a synthetic stereo WAV file (~30s) with:
   - Left channel: speech-like signal (or a known WAV fixture)
   - Right channel: different speech-like signal
   
2. **Chunk it**: Split into 10-second WAV chunks (simulating what 025a produces)

3. **Ship chunks**: POST each chunk to `http://127.0.0.1:18789/audio/chunk` with correct session_id + sequence

4. **Signal session-end**: POST to `/audio/session-end`

5. **Wait for transcription**: Poll `/audio/session/:id/status` until status = `done` or `failed` (timeout: 120s)

6. **Verify outputs**:
   - `data/audio/transcripts/{session_id}.json` exists with valid segments
   - `data/audio/processed/{session_id}/` contains the original chunks
   - `data/audio/inbox/{session_id}/` is empty (moved to processed)
   - Library has a new article with title matching `Meeting Transcript — *`
   - `hippocampus_facts` has entries with `source_type = 'audio-capture'` and `source_ref` containing the session_id

7. **Report results**: Print pass/fail for each checkpoint

### 5. Manual Tray App Test (Documented)

Create `tools/cortex-audio/USAGE.md` (or update existing) with manual test procedure:

1. Start gateway with audio enabled
2. Run `cortex-audio.exe`
3. Click tray icon → Start Capture
4. Play audio through speakers / talk into mic for ~30 seconds
5. Click tray icon → Stop Capture
6. Wait for transcription (check session status endpoint)
7. Verify transcript in `data/audio/transcripts/`
8. Verify facts in Hippocampus

### 6. Smoke Test for CI (Optional)

If time permits, a minimal vitest that:
- Starts the audio ingest handler in-process
- Ships pre-made WAV chunks via HTTP
- Mocks Whisper CLI (to avoid requiring Whisper in CI)
- Verifies transcript JSON + Library article + Hippocampus facts

## Verification Checklist

- [ ] `cargo build --release` succeeds with 0 warnings
- [ ] `cortex-audio.exe` starts and shows tray icon
- [ ] Tray icon turns green on Start, red on Stop
- [ ] Chunks appear in `data/audio/inbox/{session_id}/`
- [ ] `POST /audio/session-end` returns 200
- [ ] Whisper produces transcript JSON
- [ ] Transcript has segments with speaker labels
- [ ] Library article created with transcript text
- [ ] Hippocampus facts created with `source_type = 'audio-capture'`
- [ ] Facts have embeddings in `hippocampus_facts_vec`
- [ ] Session status shows `done`
- [ ] Processed audio moved from inbox to processed

## Test Fixtures

Create `tools/cortex-audio/fixtures/` with:
- `test-stereo-30s.wav` — 30-second stereo WAV (can be generated programmatically)
- `test-chunk-00.wav` through `test-chunk-02.wav` — pre-split 10-second chunks

## Files to Create

| File | Purpose |
|------|---------|
| `scripts/test-audio-e2e.ts` | Automated E2E test script |
| `tools/cortex-audio/fixtures/*.wav` | Test audio fixtures |
| `tools/cortex-audio/USAGE.md` | Manual test + usage docs (update if exists) |

## Files NOT to Modify

- All `src/audio/*.ts` files (wiring is 025f's job)
- Rust source code (025a-025c are done)
- Gateway source (025f's job)

## Out of Scope

- Performance tuning
- Multiple concurrent session handling (future)
- Remote server deployment
- Whisper model fine-tuning
- Speaker identification beyond L/R channel split
