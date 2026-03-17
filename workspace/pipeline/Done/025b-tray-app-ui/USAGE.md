# 025b — Tray App UI Usage

## Binary

`tools/cortex-audio/target/release/cortex-audio.exe` (build with `cargo build --release`)

## Architecture

- **`config.rs`** — Loads/saves `%LOCALAPPDATA%\CortexAudio\config.json` with serde. Missing file → defaults. Invalid JSON → error. Converts to `CaptureConfig` for the engine.
- **`state.rs`** — `AppController` with state machine (Stopped/Capturing/Error), UUID v4 session IDs, start/stop wired to `CaptureEngine`, non-blocking event polling.
- **`main.rs`** — `tao` event loop + `tray-icon` + `muda` context menu. Right-click menu: Start Capture / Stop Capture / Quit. Icon changes color: red (stopped), green (capturing), yellow (error). Polls capture events every 250ms. Clean shutdown on Quit.

## How to Run

```
cd tools\cortex-audio
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cargo run -p cortex-audio-tray
```

## Configuration

Auto-created at `%LOCALAPPDATA%\CortexAudio\config.json` on first run:

```json
{
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50,
  "sampleRate": 44100,
  "serverUrl": "https://cortex.internal:9500",
  "apiKey": "",
  "outboxDir": "%LOCALAPPDATA%\\CortexAudio\\outbox"
}
```

## Tray Icon

- 🟥 Red = Stopped
- 🟩 Green = Capturing
- 🟨 Yellow = Error

Right-click menu: Start Capture / Stop Capture / Quit

## Tests

```
cargo test -p cortex-audio-tray
# 11 tests: config (5) + state (6)
```
