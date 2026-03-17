# cortex-audio-capture

Rust library crate that records mic and speaker audio via WASAPI (through `cpal`), mixes them into a stereo WAV stream (left = mic, right = speakers), and writes size-based chunks to a local outbox directory.

## Usage

```rust
use capture::{CaptureConfig, CaptureEngine, CaptureEvent};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = CaptureConfig::new(PathBuf::from("./outbox"));
    let mut engine = CaptureEngine::new(config)?;

    let rx = engine.start("session-001")?;

    // Process events from the capture engine
    for event in rx {
        match event {
            CaptureEvent::ChunkReady { path, sequence } => {
                println!("Chunk {sequence}: {}", path.display());
            }
            CaptureEvent::SessionEnd { session_id, chunks } => {
                println!("Session {session_id} ended with {chunks} chunks");
                break;
            }
            CaptureEvent::Error(msg) => {
                eprintln!("Error: {msg}");
            }
        }
    }

    Ok(())
}
```

## Configuration

| Field | Default | Description |
|---|---|---|
| `max_chunk_size_bytes` | 10 MB | Max WAV chunk file size before rotation |
| `silence_timeout_secs` | 60 | Seconds of silence before auto-ending session |
| `silence_threshold_db` | -50.0 | RMS threshold in dB for silence detection |
| `sample_rate` | 44100 | Audio sample rate in Hz |
| `outbox_dir` | (required) | Directory for WAV chunk output |

## Modules

- **`config`** — `CaptureConfig` with validation and serde support
- **`mixer`** — Stereo interleaving (mic → left, speakers → right)
- **`chunker`** — WAV chunk writer with size-based rotation
- **`silence`** — RMS-based silence detection with timeout

## Testing

```bash
cargo test --manifest-path tools/cortex-audio/capture/Cargo.toml
```
