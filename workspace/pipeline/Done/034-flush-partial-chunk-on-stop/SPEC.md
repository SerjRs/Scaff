---
id: "034"
title: "Flush partial chunk on capture stop"
priority: high
created: 2026-03-18
author: scaff
type: bugfix
branch: fix/034-flush-partial-chunk
tech: rust
---

# 034 — Flush Partial Chunk on Capture Stop

## Bug

When capture stops (user clicks Stop, or silence timeout fires), the current in-progress chunk is discarded if it hasn't reached `maxChunkSizeMB`. The audio data accumulated since the last chunk rotation is lost.

Example: with `maxChunkSizeMB: 1` at 48kHz stereo 16-bit, a chunk fills in ~5 seconds. If the user stops capture 3 seconds after the last rotation, those 3 seconds are lost.

With `maxChunkSizeMB: 10`, a chunk takes ~52 seconds to fill. A 17-second recording produces zero chunks.

## Root Cause

In `capture/src/chunker.rs`, `ChunkWriter` only writes a complete WAV file when the chunk reaches the size threshold and rotates. The `finalize()` method (or equivalent stop path) either doesn't exist or doesn't flush the partial buffer to disk as a valid WAV file.

## Fix

### Change: `capture/src/chunker.rs`

Add a `flush()` or `finalize()` method to `ChunkWriter` that:

1. Takes whatever PCM data has been accumulated since the last rotation
2. Writes it as a valid WAV file with correct headers (duration matching actual data length)
3. Uses the same filename format as regular chunks: `{sessionId}_chunk-{seq:04}_{timestamp}.wav`
4. Increments the sequence counter
5. Emits a `CaptureEvent::ChunkReady` event for the partial chunk

### Change: `capture/src/lib.rs`

In `CaptureEngine::stop()`, call `flush()` on the `ChunkWriter` before shutting down the audio stream. Ensure the `ChunkReady` event for the partial chunk is sent through the channel before the channel is closed.

### Edge cases

- If the partial buffer is empty (stop immediately after a rotation), don't write a zero-byte chunk
- Minimum chunk size: only flush if there's at least 0.5 seconds of audio (avoids tiny useless chunks)
- The WAV header must reflect the actual data length, not the max chunk size

## Tests

- Unit test: `flush()` writes a valid WAV with correct header for partial data
- Unit test: `flush()` with empty buffer produces no file
- Unit test: `flush()` with <0.5s of audio produces no file
- Integration test: start capture, wait 2 seconds (less than chunk rotation), stop — verify one partial chunk exists
- Verify partial chunk is a valid WAV (parseable headers, correct sample count)

## Done Criteria

- Stopping capture always produces the final partial chunk
- Partial chunk has correct WAV headers
- Partial chunk triggers ChunkReady event
- No empty or sub-0.5s chunks produced
- All existing tests pass
