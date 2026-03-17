use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::CaptureError;

/// WAV chunk writer. Writes stereo i16 samples to WAV files, rotating
/// to a new file when the current one reaches the size threshold.
pub struct ChunkWriter {
    outbox_dir: PathBuf,
    session_id: String,
    sample_rate: u32,
    max_chunk_bytes: usize,
    sequence: u32,
    current_writer: Option<WavWriter<BufWriter<fs::File>>>,
    current_path: Option<PathBuf>,
    current_size: usize,
}

/// Size of the WAV header (44 bytes for standard PCM).
const WAV_HEADER_SIZE: usize = 44;

impl ChunkWriter {
    pub fn new(
        outbox_dir: &Path,
        session_id: &str,
        sample_rate: u32,
        max_chunk_bytes: usize,
    ) -> Result<Self, CaptureError> {
        fs::create_dir_all(outbox_dir).map_err(|e| {
            CaptureError::IoError(format!("Failed to create outbox dir: {e}"))
        })?;

        Ok(Self {
            outbox_dir: outbox_dir.to_path_buf(),
            session_id: session_id.to_string(),
            sample_rate,
            max_chunk_bytes,
            sequence: 0,
            current_writer: None,
            current_path: None,
            current_size: WAV_HEADER_SIZE,
        })
    }

    /// Write stereo i16 samples. Returns (path, sequence) pairs of any chunks
    /// that were completed (rotated) during this write.
    pub fn write_samples(&mut self, samples: &[i16]) -> Result<Vec<(PathBuf, u32)>, CaptureError> {
        let mut completed = Vec::new();

        if self.current_writer.is_none() {
            self.open_new_chunk()?;
        }

        let mut offset = 0;
        while offset < samples.len() {
            // How many samples can we fit before hitting the size limit?
            let bytes_remaining = self.max_chunk_bytes.saturating_sub(self.current_size);
            let samples_remaining = (bytes_remaining / 2).max(1); // at least try 1
            let batch_end = (offset + samples_remaining).min(samples.len());
            let batch = &samples[offset..batch_end];

            if let Some(ref mut writer) = self.current_writer {
                for &sample in batch {
                    writer.write_sample(sample).map_err(|e| {
                        CaptureError::IoError(format!("Failed to write sample: {e}"))
                    })?;
                }
            }
            self.current_size += batch.len() * 2;
            offset = batch_end;

            // Check if we need to rotate
            if self.current_size >= self.max_chunk_bytes && offset < samples.len() {
                if let Some(pair) = self.finalize_current()? {
                    completed.push(pair);
                }
                self.open_new_chunk()?;
            }
        }

        Ok(completed)
    }

    /// Finalize the current chunk. Returns (path, sequence) if there was an open chunk.
    pub fn finalize(&mut self) -> Result<Option<(PathBuf, u32)>, CaptureError> {
        self.finalize_current()
    }

    /// Get the total number of completed chunks.
    pub fn chunk_count(&self) -> u32 {
        self.sequence
    }

    fn open_new_chunk(&mut self) -> Result<(), CaptureError> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let filename = format!(
            "{}_chunk-{:04}_{}.wav",
            self.session_id, self.sequence, ts
        );
        let path = self.outbox_dir.join(&filename);

        let spec = WavSpec {
            channels: 2,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let writer = WavWriter::create(&path, spec).map_err(|e| {
            CaptureError::IoError(format!("Failed to create WAV file: {e}"))
        })?;

        self.current_writer = Some(writer);
        self.current_path = Some(path);
        self.current_size = WAV_HEADER_SIZE;
        Ok(())
    }

    fn finalize_current(&mut self) -> Result<Option<(PathBuf, u32)>, CaptureError> {
        if let Some(writer) = self.current_writer.take() {
            writer.finalize().map_err(|e| {
                CaptureError::IoError(format!("Failed to finalize WAV: {e}"))
            })?;
            let seq = self.sequence;
            self.sequence += 1;
            Ok(Some((self.current_path.take().unwrap(), seq)))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::WavReader;
    use tempfile::TempDir;

    fn make_writer(dir: &Path, max_bytes: usize) -> ChunkWriter {
        ChunkWriter::new(dir, "test-session", 44100, max_bytes).unwrap()
    }

    #[test]
    fn test_creates_outbox_dir() {
        let tmp = TempDir::new().unwrap();
        let outbox = tmp.path().join("nested").join("outbox");
        assert!(!outbox.exists());
        let _writer = ChunkWriter::new(&outbox, "s1", 44100, 10_000).unwrap();
        assert!(outbox.exists());
    }

    #[test]
    fn test_writes_valid_wav() {
        let tmp = TempDir::new().unwrap();
        let mut writer = make_writer(tmp.path(), 1_000_000);

        // Write 100 stereo frames (200 samples)
        let samples: Vec<i16> = (0..200).map(|i| (i % 1000) as i16).collect();
        writer.write_samples(&samples).unwrap();
        let (path, seq) = writer.finalize().unwrap().unwrap();
        assert_eq!(seq, 0);

        // Read back and verify
        let reader = WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 2);
        assert_eq!(spec.sample_rate, 44100);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, SampleFormat::Int);

        let read_samples: Vec<i16> = reader.into_samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(read_samples, samples);
    }

    #[test]
    fn test_file_naming_format() {
        let tmp = TempDir::new().unwrap();
        let mut writer = make_writer(tmp.path(), 1_000_000);
        let samples: Vec<i16> = vec![0; 100];
        writer.write_samples(&samples).unwrap();
        let (path, _) = writer.finalize().unwrap().unwrap();

        let filename = path.file_name().unwrap().to_str().unwrap();
        // Should match: test-session_chunk-0000_{timestamp}.wav
        assert!(filename.starts_with("test-session_chunk-0000_"));
        assert!(filename.ends_with(".wav"));
    }

    #[test]
    fn test_chunk_rotation() {
        let tmp = TempDir::new().unwrap();
        // Set max to WAV_HEADER + small amount so it rotates quickly
        // 44 (header) + 400 (200 samples * 2 bytes) = 444 bytes per chunk
        let max_bytes = WAV_HEADER_SIZE + 400;
        let mut writer = make_writer(tmp.path(), max_bytes);

        // Write enough samples to create multiple chunks
        // 600 samples = 1200 bytes of data, should produce ~3 chunks
        let samples: Vec<i16> = (0..600).map(|i| (i % 100) as i16).collect();
        let completed = writer.write_samples(&samples).unwrap();
        let last = writer.finalize().unwrap();

        let total_chunks = completed.len() + if last.is_some() { 1 } else { 0 };
        assert!(total_chunks >= 2, "Expected at least 2 chunks, got {total_chunks}");

        // Verify sequence numbers in filenames
        let mut files: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        files.sort();
        assert!(files[0].contains("chunk-0000"));
        assert!(files[1].contains("chunk-0001"));
    }

    #[test]
    fn test_sequence_increments() {
        let tmp = TempDir::new().unwrap();
        let mut writer = make_writer(tmp.path(), 1_000_000);
        assert_eq!(writer.chunk_count(), 0);

        let samples: Vec<i16> = vec![0; 100];
        writer.write_samples(&samples).unwrap();
        writer.finalize().unwrap();
        assert_eq!(writer.chunk_count(), 1);
    }
}
