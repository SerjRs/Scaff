# Cortex Audio — Build, Run & Test

## Prerequisites

- **Rust toolchain**: `rustup` installed, `cargo build` works
- **Whisper CLI**: `whisper --help` returns usage info (install via `pip install openai-whisper`)
- **Node.js v24+**: for the gateway and transcription worker
- **OpenClaw gateway**: running on `http://127.0.0.1:18789`

## Build

### Release build

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo build --release
```

Output binary: `tools/cortex-audio/target/release/cortex-audio.exe`

Expected binary size: ~3-10 MB.

### Debug build (faster compilation)

```powershell
cd tools/cortex-audio
cargo build
```

## Configuration

### Gateway (openclaw.json)

Ensure `audioCapture` is enabled in `~/.openclaw/openclaw.json`:

```json
{
  "audioCapture": {
    "enabled": true,
    "apiKey": "<generate-a-secure-key>",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "whisperBinary": "whisper",
    "whisperModel": "base.en",
    "whisperLanguage": "en",
    "whisperThreads": 4,
    "retentionDays": 30
  }
}
```

### Client (CortexAudio config)

Config file location: `%LOCALAPPDATA%\CortexAudio\config.json`

```json
{
  "server_url": "http://127.0.0.1:18789",
  "api_key": "<matching audioCapture.apiKey from openclaw.json>",
  "chunk_duration_secs": 30,
  "sample_rate": 44100,
  "channels": 2,
  "silence_threshold": 0.01,
  "silence_duration_secs": 3.0
}
```

## Running

### Start the gateway

```powershell
cd ~/.openclaw
npx tsx src/gateway/index.ts
```

### Start the tray app

```powershell
.\tools\cortex-audio\target\release\cortex-audio.exe
```

The system tray icon should appear. Green = capturing, Red = stopped.

## Manual Test Procedure

1. **Start the gateway** with audio capture enabled (see config above)
2. **Run `cortex-audio.exe`** — verify tray icon appears
3. **Click tray icon → Start Capture** — icon should turn green
4. **Play audio** through speakers or talk into the mic for ~30 seconds
5. **Click tray icon → Stop Capture** — icon should turn red
6. **Wait for transcription** — check the session status:
   ```powershell
   curl -H "Authorization: Bearer <apiKey>" http://127.0.0.1:18789/audio/session/<session-id>/status
   ```
7. **Verify transcript** in `data/audio/transcripts/<session-id>.json`
8. **Verify facts** in the Hippocampus (via SQLite or memory_query tool)

## Automated E2E Test

The automated test bypasses the tray app and ships synthetic WAV chunks directly:

```powershell
# Set the API key from openclaw.json audioCapture.apiKey
$env:AUDIO_API_KEY = "<your-api-key>"
$env:AUDIO_SERVER_URL = "http://127.0.0.1:18789"

# Run the full E2E test (requires running gateway + Whisper)
npx tsx scripts/test-audio-e2e.ts
```

### In-process smoke test (no gateway/Whisper required)

```powershell
npx vitest run scripts/test-audio-e2e.test.ts
```

This starts the ingest server in-process, uploads real WAV chunks, and validates the HTTP API + WAV processing pipeline without needing Whisper.

## Pipeline Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│ cortex-audio │────▶│ Audio Ingest │────▶│  Transcription│────▶│  Hippocampus │
│ (Rust tray)  │HTTP │   API (TS)   │     │  Worker (TS)  │     │  (Knowledge) │
│  WASAPI+WAV  │     │  /audio/*    │     │  Whisper CLI  │     │  Facts+Edges │
└─────────────┘     └──────────────┘     └───────────────┘     └──────────────┘
     capture          chunk storage        stereo→mono           Library article
     chunking         session tracking     L+R transcribe        fact extraction
     shipping         sequence validation  segment merge         vector embedding
```

### Data flow

1. **Capture** (Rust): WASAPI stereo capture → WAV chunks in outbox
2. **Ship** (Rust): HTTP POST chunks to `/audio/chunk` with session_id + sequence
3. **Ingest** (TS): Validate, store in `data/audio/inbox/{session_id}/`
4. **Session-end** (TS): Mark session complete, trigger worker
5. **Worker** (TS): Concatenate → split stereo → Whisper → merge segments → transcript JSON
6. **Ingest** (TS): Create Library article + Hippocampus facts from transcript

### File layout

```
data/audio/
├── audio.sqlite              # session tracking DB
├── inbox/{session_id}/       # chunks being received
│   ├── chunk-0000.wav
│   ├── chunk-0001.wav
│   └── ...
├── processed/{session_id}/   # chunks after transcription
│   └── chunk-*.wav
└── transcripts/
    └── {session_id}.json     # final transcript
```

## Troubleshooting

- **No tray icon**: Check Windows notification area settings, ensure hidden icons are visible
- **401 Unauthorized**: Verify `apiKey` matches between client config and `openclaw.json`
- **Whisper fails**: Run `whisper --help` to verify installation. Check `whisperModel` in config.
- **No transcript**: Check session status via API. Look for errors in gateway console output.
- **Large binary**: Release build should be 3-10 MB. Debug build will be much larger.
