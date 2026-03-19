//! Sequence numbering contract tests for ChunkWriter.
//!
//! These tests explicitly assert 0-based indexing at the capture engine level.
//! The ChunkWriter (chunker.rs) is the origin of all sequence numbers in the
//! pipeline — it writes the first chunk as sequence 0 and embeds it in the
//! filename as `chunk-0000`.
//!
//! If someone changes `sequence: 0` in ChunkWriter::new to `sequence: 1`,
//! these tests MUST fail.

use capture::chunker::ChunkWriter;
use std::fs;
use tempfile::TempDir;

/// Helper: create a ChunkWriter with a given max chunk size.
fn make_writer(dir: &std::path::Path, max_bytes: usize) -> ChunkWriter {
    ChunkWriter::new(dir, "seq-test", 44100, max_bytes).unwrap()
}

// ---------------------------------------------------------------------------
// Test 6: ChunkWriter first chunk is sequence 0
// ---------------------------------------------------------------------------

#[test]
fn chunkwriter_first_chunk_is_sequence_0() {
    let tmp = TempDir::new().unwrap();
    let mut writer = make_writer(tmp.path(), 1_000_000);

    // Write some samples and finalize
    let samples: Vec<i16> = vec![100; 200];
    writer.write_samples(&samples).unwrap();
    let (path, seq) = writer.finalize().unwrap().unwrap();

    // Sequence number MUST be 0 (not 1)
    assert_eq!(seq, 0, "first chunk must have sequence 0 (0-based contract)");

    // Filename MUST contain chunk-0000
    let filename = path.file_name().unwrap().to_str().unwrap();
    assert!(
        filename.contains("chunk-0000"),
        "first chunk filename must contain 'chunk-0000', got: {}",
        filename
    );

    // Explicitly verify chunk-0001 does NOT appear in any filename
    let files: Vec<String> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(files.len(), 1, "only one chunk file should exist");
    assert!(
        !files[0].contains("chunk-0001"),
        "first chunk must NOT be named chunk-0001 (off-by-one check)"
    );
}

// ---------------------------------------------------------------------------
// Test 7: ChunkWriter sequences increment: 0, 1, 2
// ---------------------------------------------------------------------------

#[test]
fn chunkwriter_sequences_increment_0_1_2() {
    let tmp = TempDir::new().unwrap();
    // Small max_bytes to force rotation: 44 header + 400 data = 444 per chunk
    let max_bytes = 44 + 400;
    let mut writer = make_writer(tmp.path(), max_bytes);

    // Write enough samples for 3 chunk rotations
    // 600 samples × 2 bytes = 1200 bytes of data → ~3 chunks at 400 bytes each
    let samples: Vec<i16> = (0..600).map(|i| (i % 100) as i16).collect();
    let completed = writer.write_samples(&samples).unwrap();
    let last = writer.finalize().unwrap();

    // Collect all (path, seq) pairs
    let mut all: Vec<(std::path::PathBuf, u32)> = completed;
    if let Some(pair) = last {
        all.push(pair);
    }

    assert!(
        all.len() >= 3,
        "expected at least 3 chunks, got {}",
        all.len()
    );

    // Verify sequence numbers are 0, 1, 2 in order
    for (i, (_, seq)) in all.iter().enumerate() {
        assert_eq!(
            *seq, i as u32,
            "chunk {} should have sequence {}, got {}",
            i, i, seq
        );
    }

    // Verify filenames contain the correct sequence numbers
    let mut filenames: Vec<String> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    filenames.sort();

    assert!(
        filenames[0].contains("chunk-0000"),
        "first file must contain chunk-0000, got: {}",
        filenames[0]
    );
    assert!(
        filenames[1].contains("chunk-0001"),
        "second file must contain chunk-0001, got: {}",
        filenames[1]
    );
    assert!(
        filenames[2].contains("chunk-0002"),
        "third file must contain chunk-0002, got: {}",
        filenames[2]
    );
}
