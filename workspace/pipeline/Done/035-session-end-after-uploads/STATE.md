# 035 — Session-End After All Uploads Complete

## Status: DONE

## Summary

Fixed the race condition where `session-end` was sent immediately when capture stops, before pending chunk uploads completed. The server was rejecting late-arriving chunks with "Session is not in receiving state".

## Changes

### `shipper/src/watcher.rs`
- Added `pending_for_session(outbox_dir, session_id) -> usize` — counts pending chunk files for a session in the outbox directory (excluding `failed/`).

### `shipper/src/lib.rs`
- Added `uploaded_counts: Arc<Mutex<HashMap<String, u32>>>` to `ChunkShipper` — tracks per-session upload success counts.
- Added `drain_session(&self, session_id, timeout) -> Result<u32, ShipperError>` — polls `pending_for_session()` every 250ms until no pending chunks remain or timeout expires. Returns count of successfully uploaded chunks.
- Upload loop increments `uploaded_counts` on each successful upload.

### `tray/src/main.rs`
- Added `ShipperBridge::drain_and_end(session_id, timeout)` — async fire-and-forget: drains pending uploads then sends session-end. Used for normal stop flow (30s timeout).
- Added `ShipperBridge::drain_and_end_blocking(session_id, timeout)` — blocking variant for quit/shutdown path (5s timeout).
- Removed `ShipperBridge::send_session_end()` — replaced by drain_and_end everywhere.
- **Stop flow**: Get session_id -> stop capture (flushes partial chunk) -> drain_and_end(30s).
- **Quit flow**: Get session_id -> stop capture -> drain_and_end_blocking(5s) -> shutdown bridge.
- **CaptureEvent::SessionEnd**: Uses drain_and_end(30s), skips if chunks == 0.
- `handle_stop()` simplified — no longer takes shipper_bridge param or sends session-end.

## Tests Added (6 new, 98 total pass)

- `pending_for_session_counts_matching_files` — counts files by session, ignores other sessions
- `pending_for_session_excludes_failed` — files in `failed/` are not counted as pending
- `drain_session_immediate_when_no_pending` — returns immediately when outbox empty
- `drain_session_times_out` — respects timeout when chunks never get uploaded
- `drain_session_waits_for_upload` — waits for watcher stability + upload, then returns
- `drain_session_with_failed_chunk_not_blocked` — failed chunks (moved to `failed/`) don't block drain

## Done Criteria Met

- [x] Session-end never sent before all chunks uploaded (or timed out)
- [x] 30s timeout prevents tray app from hanging
- [x] Failed chunks don't block drain
- [x] Zero-chunk sessions skip session-end (via CaptureEvent::SessionEnd chunks == 0)
- [x] All 98 existing + new tests pass
- [x] Clean commit `7e64a394`, merged to main, pushed
