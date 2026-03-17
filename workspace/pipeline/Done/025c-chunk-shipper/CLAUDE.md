# CLAUDE.md — 025c Chunk Shipper

## What You're Building

A Rust **library crate** (`shipper`) that watches the outbox directory for completed WAV chunks and uploads them to the server via HTTP. Handles retries with exponential backoff.

## Project Location

Lib crate in the existing workspace at `tools/cortex-audio/`:

```
tools/cortex-audio/
  Cargo.toml          # workspace — add "shipper" to members
  capture/            # already built (025a)
  tray/               # already built (025b)
  shipper/            # THIS TASK
    Cargo.toml
    src/lib.rs
    src/upload.rs      # HTTP upload logic
    src/watcher.rs     # outbox file watcher
    src/backoff.rs     # exponential backoff
```

## Setup

1. Add `"shipper"` to workspace members in `tools/cortex-audio/Cargo.toml`
2. Create `shipper/Cargo.toml`:
```toml
[package]
name = "cortex-audio-shipper"
version = "0.1.0"
edition = "2021"

[dependencies]
reqwest = { version = "0.12", features = ["multipart", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
notify = "7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"

[dev-dependencies]
tempfile = "3"
tokio = { version = "1", features = ["full", "test-util"] }
wiremock = "0.6"
```

## Key Constraints

- **Rust only.** Do NOT install .NET, Python, or any other runtime.
- **No unsafe code.**
- Must compile with `cargo build` from workspace root.
- Work on branch `feat/025c-chunk-shipper`.
- Use `wiremock` for HTTP mock tests. If version doesn't compile, try alternatives like `mockito`. Document choice.

## Implementation Order

1. `backoff.rs` — Exponential backoff calculator (pure, easy to test)
2. `upload.rs` — HTTP upload function: POST multipart with session_id, sequence, WAV data
3. `watcher.rs` — Outbox directory watcher using `notify`, file stability check (2s)
4. `lib.rs` — `ChunkShipper` struct tying it together, events channel, sequence ordering
5. Tests for each module
6. `cargo test`, `cargo clippy`

## Testing Strategy

- `backoff.rs` — pure math, no dependencies
- `upload.rs` — use `wiremock` (or `mockito`) to mock HTTP server responses (200, 500, timeout)
- `watcher.rs` — use `tempfile`, create files, verify detection
- `lib.rs` integration — mock server + temp outbox, verify full flow

## Done Criteria

- `cargo build` succeeds from workspace root
- `cargo test --workspace` — all tests pass
- `cargo clippy` clean
- Crate exposes `ChunkShipper`, `ShipperConfig`, `ShipperEvent` publicly
- Update STATE.md with STATUS: COMPLETE when done
