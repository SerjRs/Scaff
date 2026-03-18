# STATE — 028 Tray Shipper Integration

## STATUS: COMPLETE
## Last Updated: 2026-03-17

## Progress
- [x] Change default outbox to ./capture/ next to exe
- [x] Add shipper + tokio + reqwest deps to tray/Cargo.toml
- [x] Wire shipper into tray app main.rs (ShipperBridge pattern)
- [x] Expose session_id from AppController (already existed)
- [x] Send session-end on capture stop
- [x] Graceful shutdown on quit
- [x] Unit tests for config + shipper wiring (6 new tests)
- [x] Integration tests with wiremock (5 tests)
- [x] cargo test — 79 tests pass (35 capture + 23 shipper + 16 tray + 5 integration)
- [x] cargo build --release — clean
- [x] Commit, merge to main, pushed

## Files Changed
- `tray/Cargo.toml` — added shipper, tokio, reqwest deps + wiremock/tokio dev-deps
- `tray/src/config.rs` — changed default_outbox_dir to ./capture/, added shipper config fields (maxRetries, initialBackoffMs, maxBackoffMs), added to_shipper_config() method, 6 new unit tests
- `tray/src/main.rs` — ShipperBridge struct (tokio runtime + async shipper bridge), session-end on stop/quit, shipper event polling
- `tray/tests/shipper_integration.rs` — 5 integration tests with wiremock mock server

## Design Decisions
- **ShipperBridge pattern**: Created a `ShipperBridge` struct that owns a tokio runtime and bridges async shipper events to the sync tao event loop via `std::sync::mpsc`. This cleanly separates the sync GUI world from the async shipper world.
- **Session-end via spawn**: `send_session_end()` spawns a task on the tokio runtime (non-blocking) rather than blocking the GUI thread.
- **Shipper starts on app launch**: The shipper watches the outbox directory from the moment the app starts, not just during capture. This means chunks from a previous crashed session would also get uploaded.
- **reqwest added to tray**: Needed for `shipper::upload::send_session_end()` which is called directly from the bridge.
- **Graceful shutdown**: On quit, sends session-end if capturing, then shuts down the shipper bridge with a 5-second timeout.

## Test Results
```
79 tests total, 0 failures
- capture: 35 passed
- shipper: 23 passed
- tray unit: 16 passed (6 new)
- tray integration: 5 passed (all new)
```

## Fix: Chunk Filename Mismatch (2026-03-18)

**Bug:** `parse_chunk_filename()` in `shipper/src/watcher.rs` expected `{session}_chunk_{seq}.wav` but the capture engine writes `{session}_chunk-{seq}_{timestamp}.wav`. Two mismatches: dash vs underscore separator, and extra timestamp suffix. Result: all chunks silently skipped in production.

**Fix:** Updated parser to try capture engine format (`_chunk-`) first, then fall back to legacy format (`_chunk_`). Added 2 unit tests + 1 cross-crate integration test. All 82 tests pass.

**Commit:** `9423a30c0` on `fix/028-chunk-filename-mismatch`, merged to main.

## Errors
(none)
