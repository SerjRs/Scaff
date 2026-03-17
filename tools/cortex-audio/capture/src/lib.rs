pub mod chunker;
pub mod config;
pub mod mixer;
pub mod silence;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

pub use config::CaptureConfig;

/// Events emitted by the capture engine.
#[derive(Debug, Clone)]
pub enum CaptureEvent {
    /// A WAV chunk file has been written and closed.
    ChunkReady { path: PathBuf, sequence: u32 },
    /// The session has ended (due to silence timeout or explicit stop).
    SessionEnd { session_id: String, chunks: u32 },
    /// An error occurred during capture.
    Error(String),
}

/// Errors that can occur in the capture engine.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CaptureError {
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Audio device error: {0}")]
    DeviceError(String),

    #[error("I/O error: {0}")]
    IoError(String),

    #[error("Engine state error: {0}")]
    StateError(String),
}

/// The main audio capture engine.
///
/// Records mic and speaker audio, mixes into stereo WAV chunks,
/// and writes them to an outbox directory.
pub struct CaptureEngine {
    config: CaptureConfig,
    capturing: Arc<AtomicBool>,
    worker_handle: Option<thread::JoinHandle<()>>,
}

impl CaptureEngine {
    /// Create a new capture engine with the given configuration.
    pub fn new(config: CaptureConfig) -> Result<Self, CaptureError> {
        config.validate()?;

        Ok(Self {
            config,
            capturing: Arc::new(AtomicBool::new(false)),
            worker_handle: None,
        })
    }

    /// Start capturing audio. Returns a receiver for capture events.
    ///
    /// The capture runs on a background thread. Audio from the default mic
    /// and speaker (loopback) devices is mixed into stereo WAV chunks.
    pub fn start(
        &mut self,
        session_id: &str,
    ) -> Result<mpsc::Receiver<CaptureEvent>, CaptureError> {
        if self.capturing.load(Ordering::SeqCst) {
            return Err(CaptureError::StateError("Already capturing".into()));
        }

        let (tx, rx) = mpsc::channel();
        let config = self.config.clone();
        let capturing = self.capturing.clone();
        let session_id = session_id.to_string();

        capturing.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            capture_worker(config, session_id, capturing, tx);
        });

        self.worker_handle = Some(handle);
        Ok(rx)
    }

    /// Stop the current capture session.
    pub fn stop(&mut self) -> Result<(), CaptureError> {
        if !self.capturing.load(Ordering::SeqCst) {
            return Err(CaptureError::StateError("Not capturing".into()));
        }

        self.capturing.store(false, Ordering::SeqCst);

        if let Some(handle) = self.worker_handle.take() {
            handle
                .join()
                .map_err(|_| CaptureError::StateError("Worker thread panicked".into()))?;
        }

        Ok(())
    }

    /// Check whether the engine is currently capturing.
    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::SeqCst)
    }
}

/// Background worker that runs the actual capture loop.
fn capture_worker(
    config: CaptureConfig,
    session_id: String,
    capturing: Arc<AtomicBool>,
    tx: mpsc::Sender<CaptureEvent>,
) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();

    // Get default input (mic) device
    let input_device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = tx.send(CaptureEvent::Error("No input (mic) device found".into()));
            capturing.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Get default output (speaker) device for loopback
    let output_device = host.default_output_device();

    let stream_config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(config.sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    // Shared buffers for mic and speaker samples
    let mic_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let speaker_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    // Build input (mic) stream
    let mic_buf_clone = mic_buffer.clone();
    let input_stream = match input_device.build_input_stream(
        &stream_config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if let Ok(mut buf) = mic_buf_clone.lock() {
                buf.extend_from_slice(data);
            }
        },
        |err| eprintln!("Input stream error: {}", err),
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(CaptureEvent::Error(format!(
                "Failed to build input stream: {}",
                e
            )));
            capturing.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Build output loopback stream (optional — may not be available)
    let output_stream = output_device.and_then(|device| {
        let spk_buf_clone = speaker_buffer.clone();
        device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut buf) = spk_buf_clone.lock() {
                        buf.extend_from_slice(data);
                    }
                },
                |err| eprintln!("Output loopback error: {}", err),
                None,
            )
            .ok()
    });

    // Start streams
    if let Err(e) = input_stream.play() {
        let _ = tx.send(CaptureEvent::Error(format!(
            "Failed to start input stream: {}",
            e
        )));
        capturing.store(false, Ordering::SeqCst);
        return;
    }

    if let Some(ref stream) = output_stream {
        let _ = stream.play();
    }

    // Create chunker and silence detector
    let mut chunk_writer = match chunker::ChunkWriter::new(
        &config.outbox_dir,
        &session_id,
        config.sample_rate,
        config.max_chunk_size_bytes,
    ) {
        Ok(w) => w,
        Err(e) => {
            let _ = tx.send(CaptureEvent::Error(format!(
                "Failed to create chunk writer: {}",
                e
            )));
            capturing.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut silence_det =
        silence::SilenceDetector::new(config.silence_threshold_db, config.silence_timeout_secs);

    // Main processing loop — drain buffers every 50ms
    let mix_interval = std::time::Duration::from_millis(50);

    while capturing.load(Ordering::SeqCst) {
        thread::sleep(mix_interval);

        let mic_samples = std::mem::take(&mut *mic_buffer.lock().unwrap());
        let speaker_samples = std::mem::take(&mut *speaker_buffer.lock().unwrap());

        if mic_samples.is_empty() && speaker_samples.is_empty() {
            continue;
        }

        // Mix into stereo
        let stereo_f32 = mixer::interleave_stereo(&mic_samples, &speaker_samples);

        // Check silence on mixed signal
        if silence_det.process(&stereo_f32) {
            if let Ok(Some((path, seq))) = chunk_writer.finalize() {
                let _ = tx.send(CaptureEvent::ChunkReady {
                    path,
                    sequence: seq,
                });
            }
            let _ = tx.send(CaptureEvent::SessionEnd {
                session_id: session_id.clone(),
                chunks: chunk_writer.chunk_count(),
            });
            capturing.store(false, Ordering::SeqCst);
            break;
        }

        // Convert to i16 and write to chunk files
        let stereo_i16 = mixer::f32_to_i16(&stereo_f32);
        match chunk_writer.write_samples(&stereo_i16) {
            Ok(completed) => {
                for (path, seq) in completed {
                    let _ = tx.send(CaptureEvent::ChunkReady {
                        path,
                        sequence: seq,
                    });
                }
            }
            Err(e) => {
                let _ = tx.send(CaptureEvent::Error(format!("Write error: {}", e)));
                capturing.store(false, Ordering::SeqCst);
                break;
            }
        }
    }

    // Finalize remaining chunk on stop
    if let Ok(Some((path, seq))) = chunk_writer.finalize() {
        let _ = tx.send(CaptureEvent::ChunkReady {
            path,
            sequence: seq,
        });
    }

    let _ = tx.send(CaptureEvent::SessionEnd {
        session_id,
        chunks: chunk_writer.chunk_count(),
    });
    capturing.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_engine_creation_valid_config() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/test-outbox"));
        assert!(CaptureEngine::new(config).is_ok());
    }

    #[test]
    fn test_engine_creation_invalid_config() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/test-outbox"));
        config.sample_rate = 0;
        assert!(CaptureEngine::new(config).is_err());
    }

    #[test]
    fn test_is_capturing_initially_false() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/test-outbox"));
        let engine = CaptureEngine::new(config).unwrap();
        assert!(!engine.is_capturing());
    }

    #[test]
    fn test_stop_without_start_errors() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/test-outbox"));
        let mut engine = CaptureEngine::new(config).unwrap();
        assert!(engine.stop().is_err());
    }

    #[test]
    fn test_public_types_exported() {
        let _config = CaptureConfig::new(PathBuf::from("/tmp"));
        let _event = CaptureEvent::SessionEnd {
            session_id: "test".into(),
            chunks: 0,
        };
        let _err = CaptureError::InvalidConfig("test".into());
    }
}
