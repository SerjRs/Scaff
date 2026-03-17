# CLAUDE.md — 025b Tray App UI

## What You're Building

A Rust **binary crate** (`tray`) that provides a Windows system tray icon to control audio capture (025a) and chunk shipping (025c). This is the user-facing process.

**NOTE:** 025c (Chunk Shipper) is not built yet. For now, scaffold the tray app with the capture crate only. The shipper integration will be added when 025c is complete.

## Project Location

This is a bin crate inside the existing cargo workspace at `tools/cortex-audio/`:

```
tools/cortex-audio/
  Cargo.toml          # workspace — add "tray" to members
  capture/            # already built (025a)
  tray/               # THIS TASK
    Cargo.toml
    src/main.rs
    src/config.rs
    src/state.rs
```

## Setup

1. Add `"tray"` to workspace members in `tools/cortex-audio/Cargo.toml`
2. Create `tray/Cargo.toml`:
```toml
[package]
name = "cortex-audio-tray"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "cortex-audio"
path = "src/main.rs"

[dependencies]
cortex-audio-capture = { path = "../capture" }
tray-icon = "0.19"
winit = "0.30"
muda = "0.15"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
dirs = "6"
```

## Key Constraints

- **Rust only.** Do NOT install .NET, Python, or any other runtime.
- **No unsafe code** unless required for Windows tray interop.
- Must compile with `cargo build` from workspace root.
- Work on branch `feat/025b-tray-app-ui`.
- If `tray-icon` or `winit` versions differ, use whatever compiles. Document version in STATE.md.

## Implementation Order

1. `config.rs` — Load/save config from `%LOCALAPPDATA%\CortexAudio\config.json`, defaults
2. `state.rs` — App state machine: Stopped → Capturing → Stopped. Session ID generation (UUID v4)
3. `main.rs` — Event loop with `winit`, tray icon with `tray-icon`, context menu with `muda`
4. Wire up: Start menu item → generate session ID → start CaptureEngine → icon green
5. Wire up: Stop menu item → stop CaptureEngine → icon red
6. Quit menu item → clean shutdown
7. Tests: config loading, state transitions, UUID format

## Tray Icon

Use simple colored rectangles as icons (no external .ico files needed):
- Green = capturing
- Red = stopped
- Create programmatically via `tray-icon::Icon::from_rgba()`

## Done Criteria

- `cargo build` succeeds from workspace root
- Binary runs, shows tray icon, right-click menu works
- Start/Stop toggles capture engine and changes icon color
- Config loads from `%LOCALAPPDATA%\CortexAudio\config.json` (creates defaults if missing)
- `cargo clippy` clean
- Update STATE.md with STATUS: COMPLETE when done
