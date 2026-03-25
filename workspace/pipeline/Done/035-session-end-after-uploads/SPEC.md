---
id: "035"
title: "Send session-end only after all chunks are uploaded"
priority: critical
created: 2026-03-18
author: scaff
type: bugfix
branch: fix/035-session-end-after-uploads
tech: rust
---

# 035 — Session-End After All Uploads Complete

## Bug

When capture stops, the tray app sends session-end immediately via `shipper.signal_session_end()`. But chunks may still be in-flight — the shipper watcher hasn't detected the last chunk yet, or earlier chunks are mid-upload.

The server receives session-end, transitions the session from "receiving" to "pending_transcription". When remaining chunks arrive after that, the server rejects them with "Session is not in receiving state".

Result: incomplete session, missing chunks, transcription fails or produces truncated transcript.

Observed in production: 2026-03-18, chunk #3 rejected after session-end was already sent.

## Root Cause

In `tray/src/main.rs`, the stop flow is:

```
User clicks Stop
  → AppController.stop() (stops capture engine)
  → shipper.signal_session_end(session_id)  ← IMMEDIATELY
```

There's no coordination between "capture has finished writing all chunks" and "shipper has finished uploading all chunks". The session-end races ahead of pending uploads.

## Fix

### Approach: Drain-then-end

After capture stops:

1. **Wait for the outbox to drain** — the shipper should upload all remaining chunks
2. **Then send session-end** — only after all chunks for this session have been uploaded (or failed)

### Change: `shipper/src/lib.rs`

Add a method to `ChunkShipper`:

```rust
/// Wait until all chunks for the given session have been uploaded or failed.
/// Returns the count of successfully uploaded chunks.
pub async fn drain_session(&self, session_id: &str, timeout: Duration) -> Result<u32, ShipperError>
```

This method:
- Watches the internal upload queue/state for chunks matching this session_id
- Waits until no pending/in-flight chunks remain for the session
- Has a timeout to avoid hanging forever (default: 30 seconds)
- Returns the number of successfully uploaded chunks

### Change: `tray/src/main.rs` (ShipperBridge)

Update the stop flow:

```
User clicks Stop
  → AppController.stop() (stops capture, flushes partial chunk [034])
  → shipper_bridge.drain_and_end(session_id, timeout=30s)
      → internally: drain_session() then signal_session_end()
  → log result
```

The `drain_and_end` call goes through the ShipperBridge's async channel to the tokio runtime, same pattern as existing shipper calls.

### Change: `shipper/src/watcher.rs`

The watcher needs to track which files belong to which session (it already parses session_id from filenames). Add a method to query pending files for a session:

```rust
pub fn pending_for_session(&self, session_id: &str) -> usize
```

### Edge cases

- **Timeout:** If uploads are stuck (server down, network issues), the drain should time out after 30s and send session-end anyway. The server will get a partial session — better than hanging the tray app forever.
- **Retry exhaustion:** If a chunk fails after max retries, it's moved to `failed/`. The drain should count this as "done" (not pending), and session-end should still be sent. The server handles sequence gaps gracefully (logs a warning but still attempts transcription with available chunks).
- **No chunks:** If capture produced zero chunks (very short recording), skip the drain and don't send session-end at all — there's nothing to transcribe.
- **Graceful shutdown on quit:** The quit flow (tray app closing) should also drain before sending session-end, with a shorter timeout (5s).

## Tests

- Unit test: `drain_session` returns immediately when no pending chunks
- Unit test: `drain_session` waits for in-flight upload to complete
- Unit test: `drain_session` times out correctly
- Integration test: upload 3 chunks + session-end via drain_and_end, verify server receives all chunks BEFORE session-end
- Integration test: verify chunk order on server matches upload order

## Done Criteria

- Session-end is never sent before all chunks are uploaded (or timed out)
- Timeout prevents the tray app from hanging
- Failed chunks don't block the drain
- Zero-chunk sessions skip session-end entirely
- All existing tests pass
