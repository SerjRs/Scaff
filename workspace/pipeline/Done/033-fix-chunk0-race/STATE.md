# STATE — 033 Fix Chunk #0 Race

## Status: DONE

## What was done

1. **`scan_existing_files()`** added to `shipper/src/watcher.rs` — scans outbox for `.wav` files, excludes `failed/`, returns sorted.
2. **Scan on startup** — called after `notify::Watcher` init, before event loop. Pre-existing files injected into `pending` map.
3. **Dedup via `HashSet<PathBuf>`** — tracks sent files. Watcher events and stability sends skip already-sent paths.
4. **Unit tests** — `scan_existing_files_finds_wavs_sorted_excludes_failed`, `scan_existing_files_empty_dir`.
5. **Integration tests** — `pre_existing_chunk_uploaded_on_startup`, `pre_existing_and_new_chunks_both_uploaded_no_duplicates`.
6. **All 88 tests pass** (was 84, added 4 new).
7. **Committed, merged to main, pushed.** Commit `dad38c947`.

## Files modified
- `tools/cortex-audio/shipper/src/watcher.rs`
- `tools/cortex-audio/tray/tests/shipper_integration.rs`
