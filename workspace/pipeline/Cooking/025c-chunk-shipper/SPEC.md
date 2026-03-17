---
id: "025c"
title: "Chunk Shipper — Rust Outbox Watcher & Reliable Upload"
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

# Chunk Shipper — Rust Outbox Watcher & Reliable Upload

## Goal

Rust library crate that watches the local outbox directory for completed WAV chunks and reliably uploads them to the server's audio ingest API (025d). Handles retries, backoff, and cleanup.

## Tech Stack

- **Language:** Rust
- **HTTP:** `reqwest` with `tokio` async runtime
- **File watching:** `notify` crate (cross-platform filesystem events)
- **Project location:** `tools/cortex-audio/shipper/` (lib crate in cargo workspace)

## Public Interface

```rust
pub struct ShipperConfig {
    pub server_url: String,           // e.g. "https://cortex.internal:9500"
    pub api_key: String,
    pub outbox_dir: PathBuf,
    pub max_retries: u32,             // default 10
    pub initial_backoff_ms: u64,      // default 1000
    pub max_backoff_ms: u64,          // default 60000
}

pub enum ShipperEvent {
    ChunkUploaded { path: PathBuf, sequence: u32 },
    ChunkFailed { path: PathBuf, error: String, retries: u32 },
    SessionEndSent { session_id: String },
}

pub struct ChunkShipper { ... }

impl ChunkShipper {
    pub fn new(config: ShipperConfig) -> Result<Self>;
    pub async fn start(&mut self) -> Receiver<ShipperEvent>;
    pub async fn signal_session_end(&self, session_id: &str) -> Result<()>;
    pub async fn stop(&mut self) -> Result<()>;
}
```

## Behavior

1. **Watch outbox**: `notify` watcher on outbox dir, filters for `.wav` files
2. **Stability check**: file size stable for 2 seconds = write complete
3. **Upload**: `POST /audio/chunk` with multipart form — session_id, sequence, audio data
4. **On 200 OK**: delete local file, emit `ChunkUploaded`
5. **On failure**: exponential backoff (1s → 2s → 4s → ... max 60s), retry up to max_retries
6. **On max retries exceeded**: emit `ChunkFailed`, move file to `outbox/failed/`
7. **Session end**: `POST /audio/session-end` with session_id, triggered by capture engine
8. **Ordering**: chunks uploaded in sequence order per session_id (don't send chunk 3 before chunk 2)

## Unit Tests

- **Backoff calculation**: verify exponential sequence with max cap
- **File stability detection**: mock file writes, verify 2s stability gate
- **Sequence ordering**: verify chunks queued in order
- **Retry tracking**: verify retry count increments, max triggers failure event
- **Config validation**: reject empty server_url, invalid backoff values

## E2E Tests

- **Upload success**: place a WAV file in outbox → verify HTTP POST sent → on mock 200 → file deleted
- **Upload retry**: mock server returns 500 → verify retry with backoff → mock 200 → file deleted
- **Max retries**: mock server always 500 → verify file moved to `failed/` after max retries
- **Session end**: signal session end → verify POST to `/audio/session-end`
- **Multi-chunk ordering**: place chunks 3, 1, 2 → verify uploaded in order 1, 2, 3

## Out of Scope

- Audio capture (025a)
- UI (025b)
- Server-side reception (025d)
