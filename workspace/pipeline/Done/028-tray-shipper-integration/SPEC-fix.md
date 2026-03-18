---
id: "028-fix"
title: "Fix chunk filename mismatch between capture engine and shipper parser"
priority: critical
created: 2026-03-18
author: scaff
type: bugfix
parent: "028"
branch: fix/028-chunk-filename-mismatch
tech: rust
---

# Fix: Chunk Filename Mismatch (Capture ↔ Shipper)

## Bug

The capture engine's `ChunkWriter` writes files with this format:
```
{sessionId}_chunk-{seq:04}_{timestamp}.wav
```
Example: `abc123_chunk-0001_1710700000.wav`

The shipper's `parse_chunk_filename()` expects:
```
{sessionId}_chunk_{seq:04}.wav
```
Example: `abc123_chunk_0001.wav`

**Two mismatches:**
1. Separator: chunker uses **dash** (`_chunk-`), shipper looks for **underscore** (`_chunk_`)
2. Chunker appends a **Unix timestamp** before `.wav` — the parser grabs everything after `_chunk_` as the sequence, gets `0001_1710700000`, which fails `parse::<u32>()`

**Result:** In production, chunks are written by the capture engine, the shipper's file watcher detects them (any `.wav` triggers), but `parse_chunk_filename()` returns `None`. The file is logged as "Could not parse chunk filename" and **silently skipped**. No chunks ever upload.

**Why tests didn't catch it:** Integration tests manually write files using the shipper's expected format (`_chunk_0001.wav`), never using the actual capture engine.

## Fix Strategy

**Update the shipper's parser** to handle the chunker's actual format. The chunker format is more informative (has timestamp for debugging) — don't change it.

### Change 1: Update `parse_chunk_filename()` in `shipper/src/watcher.rs`

Current:
```rust
/// Expected format: `{session_id}_chunk_{sequence:04}.wav`
pub fn parse_chunk_filename(path: &Path) -> Option<(String, u32)> {
    let stem = path.file_stem()?.to_str()?;
    let idx = stem.rfind("_chunk_")?;
    let session_id = &stem[..idx];
    let seq_str = &stem[idx + 7..]; // skip "_chunk_"
    let sequence = seq_str.parse::<u32>().ok()?;
    Some((session_id.to_string(), sequence))
}
```

New — handle both `_chunk-{seq}_{ts}` and `_chunk_{seq}`:
```rust
/// Parse session_id and sequence from a chunk filename.
/// Supported formats:
///   {session_id}_chunk-{seq:04}_{timestamp}.wav  (capture engine output)
///   {session_id}_chunk_{seq:04}.wav              (legacy/test format)
pub fn parse_chunk_filename(path: &Path) -> Option<(String, u32)> {
    let stem = path.file_stem()?.to_str()?;

    // Try capture engine format first: _chunk-{seq}_{ts}
    if let Some(idx) = stem.rfind("_chunk-") {
        let session_id = &stem[..idx];
        let after = &stem[idx + 7..]; // skip "_chunk-"
        // after = "0001_1710700000" — take digits before the first underscore
        let seq_str = after.split('_').next()?;
        let sequence = seq_str.parse::<u32>().ok()?;
        return Some((session_id.to_string(), sequence));
    }

    // Fallback: legacy format _chunk_{seq}
    if let Some(idx) = stem.rfind("_chunk_") {
        let session_id = &stem[..idx];
        let seq_str = &stem[idx + 7..];
        let sequence = seq_str.parse::<u32>().ok()?;
        return Some((session_id.to_string(), sequence));
    }

    None
}
```

### Change 2: Update/add tests in `shipper/src/watcher.rs`

```rust
#[test]
fn parse_capture_engine_format() {
    // Real capture engine output: {session}_chunk-{seq}_{timestamp}.wav
    let p = Path::new("/tmp/outbox/abc123_chunk-0001_1710700000.wav");
    let (sid, seq) = parse_chunk_filename(p).unwrap();
    assert_eq!(sid, "abc123");
    assert_eq!(seq, 1);

    let p2 = Path::new("/tmp/outbox/my-uuid-session_chunk-0042_1710700999.wav");
    let (sid2, seq2) = parse_chunk_filename(p2).unwrap();
    assert_eq!(sid2, "my-uuid-session");
    assert_eq!(seq2, 42);
}

#[test]
fn parse_legacy_format() {
    // Legacy/test format: {session}_chunk_{seq}.wav
    let p = Path::new("/tmp/outbox/sess-abc_chunk_0001.wav");
    let (sid, seq) = parse_chunk_filename(p).unwrap();
    assert_eq!(sid, "sess-abc");
    assert_eq!(seq, 1);
}
```

### Change 3: Add a cross-crate integration test in `tray/tests/shipper_integration.rs`

Add a test that validates the chunker's **actual filename format** is parseable by the shipper:

```rust
#[test]
fn capture_engine_filenames_parseable_by_shipper() {
    // Simulate what ChunkWriter actually produces
    let session_id = "d4e5f6a7-1234-5678-9abc-def012345678";
    let timestamp = 1710700000u64;
    for seq in 0..5u32 {
        let filename = format!("{}_chunk-{:04}_{}.wav", session_id, seq, timestamp + seq as u64);
        let path = std::path::Path::new(&filename);
        let parsed = shipper::watcher::parse_chunk_filename(path);
        assert!(parsed.is_some(), "Failed to parse: {}", filename);
        let (sid, s) = parsed.unwrap();
        assert_eq!(sid, session_id);
        assert_eq!(s, seq);
    }
}
```

**Note:** This requires `shipper::watcher::parse_chunk_filename` to be pub (it already is).

## Files to Modify

| File | Change |
|------|--------|
| `shipper/src/watcher.rs` | Update `parse_chunk_filename()` to handle both formats; add tests |
| `tray/tests/shipper_integration.rs` | Add cross-crate filename compatibility test |

## Files NOT to Modify

- `capture/src/chunker.rs` — chunker format is fine, don't change it
- `tray/src/main.rs` — no changes needed
- Any TypeScript files

## Tests

- All existing 79 tests must still pass
- New tests for both filename formats
- Cross-crate integration test proving capture output is parseable

## Done Criteria

- `parse_chunk_filename()` correctly parses `{session}_chunk-{seq}_{ts}.wav`
- Backward compatible: `{session}_chunk_{seq}.wav` still works
- All tests pass (79 existing + new)
- Committed, merged to main, pushed
