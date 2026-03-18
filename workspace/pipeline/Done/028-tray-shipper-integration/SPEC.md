---
id: "028"
title: "Tray Shipper Integration — Wire chunk upload + local capture folder"
priority: high
assignee: scaff
status: cooking
created: 2026-03-17
updated: 2026-03-17
type: feature
parent: "025"
depends_on: ["025b", "025c"]
tech: rust
---

# Tray Shipper Integration — Wire chunk upload + local capture folder

## Problem

The tray app (025b) captures audio to WAV chunks in the outbox directory, but the shipper (025c) is not integrated. Chunks sit on disk and are never uploaded to the server. The full pipeline (capture → ship → ingest → transcribe) is broken at the ship step.

Additionally, the default outbox path (`%LOCALAPPDATA%\CortexAudio\outbox\`) is inconvenient for portable deployments. Users want chunks saved next to the exe for easy inspection.

## Goal

1. Wire the shipper crate into the tray app so chunks are automatically uploaded as they're written
2. Change the default outbox to `./capture/` relative to the exe location
3. After stop, send session-end to the server to trigger transcription

## What Exists

### Tray app (`tray/src/main.rs`)
- Synchronous event loop via `tao` (no tokio runtime)
- `AppController` wraps `CaptureEngine` (start/stop/poll_events)
- Polls `CaptureEvent`s every 250ms in the event loop
- Config loaded from `config.json` next to exe (or `%LOCALAPPDATA%\CortexAudio\config.json`)

### Shipper crate (`shipper/src/lib.rs`)
- `ChunkShipper` — async (tokio) watcher + uploader
- `start()` returns `mpsc::Receiver<ShipperEvent>` 
- `stop()` signals shutdown
- Watches outbox dir via `notify` crate, uploads in sequence order
- Uses `reqwest` for HTTP multipart upload
- Sends session-end after all chunks uploaded (when it sees a session-end marker or is told to stop)

### Key mismatch
- Tray app: **sync** (tao event loop)
- Shipper: **async** (tokio runtime)

## Changes Required

### 1. Change default outbox to `./capture/` next to exe

In `tray/src/config.rs`, change `default_outbox_dir()`:

```rust
fn default_outbox_dir() -> PathBuf {
    // Relative to exe location, not %LOCALAPPDATA%
    std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("capture")))
        .unwrap_or_else(|| PathBuf::from("capture"))
}
```

This makes the outbox portable — chunks appear in `./capture/` next to `cortex-audio.exe`.

### 2. Add shipper + tokio to tray dependencies

In `tray/Cargo.toml`:

```toml
[dependencies]
shipper = { path = "../shipper", package = "cortex-audio-shipper" }
tokio = { version = "1", features = ["rt-multi-thread"] }
```

### 3. Wire shipper into tray app

**Approach:** Spawn a tokio runtime in a background thread. The shipper runs on this runtime. Communication with the tray event loop is via `std::sync::mpsc` (already used for capture events).

In `main.rs`:

```rust
// Before the tao event loop:
let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(2)
    .enable_all()
    .build()
    .expect("Failed to create tokio runtime");

let shipper_config = ShipperConfig {
    server_url: tray_config.server_url.clone(),
    api_key: tray_config.api_key.clone(),
    outbox_dir: tray_config.outbox_dir.clone(),
    max_retries: 3,
    initial_backoff_ms: 1000,
    max_backoff_ms: 30000,
};

// Start shipper on the tokio runtime
let (shipper_event_tx, shipper_event_rx) = std::sync::mpsc::channel();
let shipper_handle = rt.spawn(async move {
    let mut shipper = ChunkShipper::new(shipper_config).expect("Failed to create shipper");
    let mut events = shipper.start().await.expect("Failed to start shipper");
    while let Some(event) = events.recv().await {
        let _ = shipper_event_tx.send(event);
    }
});
```

Then in the event loop, poll `shipper_event_rx` alongside capture events:

```rust
// Poll shipper events
while let Ok(event) = shipper_event_rx.try_recv() {
    match event {
        ShipperEvent::ChunkUploaded { path, sequence } => {
            log::info!("Chunk #{sequence} uploaded: {}", path.display());
        }
        ShipperEvent::ChunkFailed { path, error, retries } => {
            log::warn!("Chunk upload failed after {retries} retries: {} — {error}", path.display());
        }
        ShipperEvent::SessionEndSent { session_id } => {
            log::info!("Session-end sent for {session_id}");
        }
    }
}
```

### 4. Send session-end on capture stop

When the user clicks Stop (or silence timeout fires), after the capture engine stops, the shipper needs to know the session is complete. Options:

**Option A — Marker file:** Write a `.session-end` marker file to the outbox that the shipper watches for.

**Option B — Direct call:** Expose a `send_session_end(session_id)` method on the shipper and call it from the tray app when capture stops.

**Recommended: Option B** — more reliable, avoids file system race conditions. Requires passing a handle/channel to the shipper's session-end method. The shipper already has `upload::send_session_end()`.

### 5. Shutdown shipper on quit

When the user clicks Quit, stop the shipper gracefully before exiting:

```rust
if event.id == quit_id {
    if controller.state() == AppState::Capturing {
        let _ = controller.stop();
    }
    // Stop shipper
    rt.block_on(async { shipper.stop().await });
    *control_flow = ControlFlow::Exit;
}
```

## Config Changes

The `config.json` stays the same — `serverUrl` and `apiKey` are already there and used by both capture config and shipper config.

Add optional shipper-specific fields (with defaults):

```json
{
  "serverUrl": "http://10.18.2.5:18789",
  "apiKey": "cortex-audio-2026-a7f3b9e1",
  "sampleRate": 48000,
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50.0,
  "maxRetries": 3,
  "initialBackoffMs": 1000,
  "maxBackoffMs": 30000
}
```

## Files to Modify

| File | Change |
|------|--------|
| `tray/Cargo.toml` | Add `shipper` + `tokio` dependencies |
| `tray/src/config.rs` | Change `default_outbox_dir()` to `./capture/` next to exe; add shipper config fields |
| `tray/src/main.rs` | Spawn tokio runtime, create shipper, poll shipper events, send session-end on stop, shutdown on quit |
| `tray/src/state.rs` | Expose session_id so tray can pass it to shipper for session-end |

## Files NOT to Modify

- `capture/src/*.rs` — capture engine is complete
- `shipper/src/*.rs` — shipper crate is complete
- Any TypeScript files

## Tests

- **Outbox path default**: verify `default_outbox_dir()` returns path next to exe
- **Shipper config from tray config**: verify `ShipperConfig` is correctly built from `TrayConfig`
- **Session-end on stop**: verify session-end is triggered when capture stops
- Existing 69 cargo tests must continue to pass

## Verification (Manual)

1. Copy `cortex-audio.exe` + `config.json` to a folder
2. Run from terminal
3. Start capture → chunks appear in `./capture/` subfolder
4. Logs show "Chunk #N uploaded" messages
5. Stop capture → logs show "Session-end sent"
6. Server shows session in `data/audio/inbox/{session_id}/`
7. Transcript appears in `data/audio/transcripts/` (if Whisper is running)

## Out of Scope

- Changes to the shipper crate itself
- Changes to the capture crate
- Server-side changes
- Whisper integration issues
