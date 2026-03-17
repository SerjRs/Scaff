---
id: "025b"
title: "Tray App UI — Rust System Tray Binary"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
updated: 2026-03-17
type: feature
parent: "025"
depends_on: "025a"
tech: rust
---

# Tray App UI — Rust System Tray Binary

## Goal

Single Windows binary that lives in the system tray and orchestrates audio capture (025a) and chunk shipping (025c). This is the only process the user interacts with.

## Tech Stack

- **Language:** Rust
- **Tray:** `tray-icon` + `winit` (or `tao`) for event loop
- **Menu:** `muda` crate for context menus
- **Config:** `serde_json` — reads `config.json` from app data dir
- **Project location:** `tools/cortex-audio/tray/` (bin crate in cargo workspace)

## Dependencies

- `capture` crate (025a) — audio engine
- `shipper` crate (025c) — chunk upload

## Features

- **System tray icon**: green (capturing) / red (stopped) / yellow (error)
- **Right-click menu**: `Start Capture` / `Stop Capture` / `Settings...` / `Quit`
- **Start**: generates new `session_id` (UUID), starts capture engine + shipper
- **Stop**: stops capture, signals session-end, shipper drains remaining chunks
- **Settings dialog**: minimal — server URL, API key, chunk size, silence timeout
- **Auto-start**: optional Windows startup registry entry
- **Logging**: to `%LOCALAPPDATA%\CortexAudio\logs\`

## Binary Output

```
tools/cortex-audio/target/release/cortex-audio.exe  (~3-5 MB)
```

No installer needed. Copy exe + config.json, run.

## Configuration

Reads from `%LOCALAPPDATA%\CortexAudio\config.json`:

```json
{
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50,
  "sampleRate": 44100,
  "serverUrl": "https://cortex.internal:9500",
  "apiKey": "...",
  "outboxDir": "%LOCALAPPDATA%\\CortexAudio\\outbox"
}
```

## Unit Tests

- **Config loading**: valid JSON → parsed config, missing file → defaults, invalid JSON → error
- **Session ID generation**: verify UUID v4 format
- **State transitions**: Stopped → Capturing → Stopped, reject double-start

## E2E Tests

- **Startup**: binary launches, tray icon appears, no crash
- **Menu**: right-click produces expected menu items
- **Toggle flow**: start capture → icon turns green → stop → icon turns red

## Out of Scope

- Audio capture logic (025a)
- Network shipping logic (025c)
- Server-side (025d/025e)
