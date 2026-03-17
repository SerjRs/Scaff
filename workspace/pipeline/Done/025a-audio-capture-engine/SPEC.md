---
id: "025a"
title: "Audio Capture Engine — Rust WASAPI Stereo Capture & Chunking"
priority: high
assignee: scaff
status: "in_progress"
created: 2026-03-16
updated: 2026-03-17
type: feature
parent: "025"
depends_on: null
tech: rust
---

# Audio Capture Engine — Rust WASAPI Stereo Capture & Chunking

## Goal

Rust library crate that records both mic and speaker audio via WASAPI (through `cpal`), mixes them into a stereo WAV stream (left = mic, right = speakers), and writes size-based chunks to a local outbox directory.

## Tech Stack

- **Language:** Rust (2021 edition)
- **Audio:** `cpal` crate — cross-platform audio I/O, uses WASAPI backend on Windows
- **WAV writing:** `hound` crate
- **Async events:** `tokio::sync::mpsc` channels for chunk-ready / session-end callbacks
- **Project location:** `tools/cortex-audio/capture/` (lib crate inside cargo workspace)

## Cargo Workspace

All 025 client-side crates live under `tools/cortex-audio/`:

```
tools/cortex-audio/
  Cargo.toml          # [workspace] members = ["capture", "shipper", "tray"]
  capture/
    Cargo.toml        # [lib] — this task
    src/lib.rs
    src/mixer.rs      # stereo mixing logic
    src/chunker.rs    # WAV chunk writer
    src/silence.rs    # silence detection
    src/config.rs     # configuration
  shipper/            # 025c
  tray/               # 025b (bin crate, depends on capture + shipper)
```

## Public Interface

```rust
pub struct CaptureEngine { ... }

pub struct CaptureConfig {
    pub max_chunk_size_bytes: usize,    // default 10 MB
    pub silence_timeout_secs: u64,      // default 60
    pub silence_threshold_db: f32,      // default -50.0
    pub sample_rate: u32,               // default 44100
    pub outbox_dir: PathBuf,
}

pub enum CaptureEvent {
    ChunkReady { path: PathBuf, sequence: u32 },
    SessionEnd { session_id: String, chunks: u32 },
    Error(CaptureError),
}

impl CaptureEngine {
    pub fn new(config: CaptureConfig) -> Result<Self>;
    pub fn start(&mut self, session_id: &str) -> Result<Receiver<CaptureEvent>>;
    pub fn stop(&mut self) -> Result<()>;
    pub fn is_capturing(&self) -> bool;
}
```

## Key Implementation Notes

- `cpal` provides `Host::default()` → `Device` for both input (mic) and loopback (speakers)
- On Windows, WASAPI loopback = `host.output_devices()` with loopback flag
- Two `cpal::Stream` instances run concurrently, feeding samples into a shared ring buffer
- Mixer thread reads both buffers, interleaves into stereo (L=mic, R=speakers)
- `hound::WavWriter` writes chunks; when file size hits threshold, close and open next
- Silence detection: RMS of mixed signal over a sliding window, compared to threshold
- File naming: `{session_id}_chunk-{sequence:04}_{unix_timestamp}.wav`

## Configuration

```json
{
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50,
  "sampleRate": 44100,
  "outboxDir": "%LOCALAPPDATA%\\CortexAudio\\outbox"
}
```

## Unit Tests

- **Stereo mixing**: given separate mono buffers (mic, speakers), verify interleaved stereo output with mic on left, speakers on right
- **Chunk size enforcement**: feed continuous samples, verify WAV files close at size threshold and new ones start
- **File naming**: verify `{session_id}_chunk-{seq}_{ts}.wav` format with incrementing sequence
- **Silence detection**: feed sub-threshold samples for > timeout duration, verify `SessionEnd` event fires
- **No false silence**: feed audio with brief pauses (< timeout), verify session continues
- **Config validation**: reject invalid values (negative chunk size, zero sample rate)
- **Session state**: verify `is_capturing()` returns correct state before/after start/stop
- **Outbox directory**: verify directory is created if missing

## E2E Tests

- **Full capture cycle**: start → feed test audio via mock device → verify chunk files in outbox with correct WAV headers and stereo layout
- **Silence auto-stop**: start → feed audio → feed silence > timeout → verify `SessionEnd` event and no further chunks
- **Multi-chunk session**: feed enough audio for 3+ chunks → verify sequential, no gaps
- **Resume after stop**: start → stop → start new session → verify new session_id, sequence resets

## Out of Scope

- Network/shipping (025c)
- UI/tray (025b)
- Server-side logic (025d/025e)
