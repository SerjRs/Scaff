---
id: "033"
title: "Fix chunk #0 race — shipper misses first chunk"
priority: critical
created: 2026-03-18
author: scaff
type: bugfix
branch: fix/033-chunk0-race
tech: rust
---

# 033 — Fix Chunk #0 Race

## Bug

The shipper's file watcher starts monitoring the outbox directory, but the first chunk may already be written before the watcher is fully initialized. The watcher relies on filesystem events (notify crate) which only fire for new files created after the watch is established.

Result: chunk #0 is never detected, never uploaded. Server gets chunks 1, 2, 3... but not 0. Transcription fails with "Missing chunks in sequence: 0".

Observed in production: 2026-03-18, session `4a47755f`.

## Root Cause

In `shipper/src/watcher.rs`, the watcher subscribes to directory events, then waits for new file notifications. It never scans for pre-existing files in the outbox at startup.

The capture engine and shipper start concurrently. If the capture engine writes chunk #0 before the watcher's `notify::Watcher` is fully registered, the filesystem event is lost.

## Fix

On watcher startup, **scan the outbox directory for existing WAV files** before entering the event loop. Any files already present should be queued for upload immediately.

### Change: `shipper/src/watcher.rs`

After initializing the `notify::Watcher`, scan the outbox for existing `.wav` files:

```rust
// After watcher is set up, scan for pre-existing files
fn scan_existing_files(outbox: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(outbox) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_wav(&path) && !is_in_failed_dir(&path, outbox) {
                files.push(path);
            }
        }
    }
    files.sort(); // ensure chunk ordering
    files
}
```

Call this right after the watcher starts and feed the results into the upload queue, before processing any new events.

### Edge cases

- Files from a previous session may exist in the outbox (stale chunks). The parser extracts session_id from the filename — these will be uploaded under their original session_id, which is fine (server will create the session on first chunk).
- Race between scan and watcher: a file could appear during the scan and also trigger a watcher event. Deduplicate by tracking uploaded file paths in a HashSet.

## Tests

- Unit test: `scan_existing_files` returns correct files, excludes `failed/` dir
- Integration test: write chunk to outbox BEFORE starting shipper, verify it gets uploaded
- Integration test: write chunk before AND after shipper start, verify both uploaded in order

## Done Criteria

- Chunk #0 is reliably uploaded even when written before shipper starts
- No duplicate uploads for the same file
- All existing tests pass
