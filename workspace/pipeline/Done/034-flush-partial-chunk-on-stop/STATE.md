# 034 — Flush Partial Chunk on Stop

## Status: DONE

## Summary

Added `ChunkWriter::flush()` method that finalizes partial chunks with a 0.5-second minimum duration guard. Both the normal stop path and silence timeout path in `capture_worker` now use `flush()` instead of `finalize()`.

## Changes

### `tools/cortex-audio/capture/src/chunker.rs`
- Added `flush()` method: checks if accumulated PCM data >= 0.5s (`sample_rate * 2` bytes). If below threshold, finalizes the WAV writer and deletes the temp file. If above, delegates to `finalize_current()`.
- Added 4 unit tests:
  - `test_flush_writes_valid_wav_for_partial_data` — 1s of audio produces valid WAV
  - `test_flush_empty_buffer_produces_no_file` — no writer open returns None
  - `test_flush_short_audio_produces_no_file` — 0.3s audio discarded, file cleaned up
  - `test_flush_at_threshold_produces_file` — exactly 0.5s produces a chunk

### `tools/cortex-audio/capture/src/lib.rs`
- Post-loop finalize (stop path): `finalize()` → `flush()`
- Silence timeout path: `finalize()` → `flush()`

## Test Results

All 92 tests pass (39 capture + 27 shipper + 2 field contract + 16 tray + 8 integration).

## Commit

`54ef2824b` — merged to main, pushed.
