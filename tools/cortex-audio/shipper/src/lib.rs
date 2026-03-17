pub mod backoff;
pub mod upload;
pub mod watcher;

use backoff::Backoff;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use upload::UploadError;
use watcher::{parse_chunk_filename, OutboxWatcher};

/// Configuration for the chunk shipper.
#[derive(Clone, Debug)]
pub struct ShipperConfig {
    pub server_url: String,
    pub api_key: String,
    pub outbox_dir: PathBuf,
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl ShipperConfig {
    pub fn validate(&self) -> Result<(), ShipperError> {
        if self.server_url.is_empty() {
            return Err(ShipperError::Config("server_url must not be empty".into()));
        }
        if self.initial_backoff_ms == 0 {
            return Err(ShipperError::Config(
                "initial_backoff_ms must be > 0".into(),
            ));
        }
        if self.max_backoff_ms < self.initial_backoff_ms {
            return Err(ShipperError::Config(
                "max_backoff_ms must be >= initial_backoff_ms".into(),
            ));
        }
        Ok(())
    }
}

/// Events emitted by the shipper.
#[derive(Debug, Clone)]
pub enum ShipperEvent {
    ChunkUploaded { path: PathBuf, sequence: u32 },
    ChunkFailed { path: PathBuf, error: String, retries: u32 },
    SessionEndSent { session_id: String },
}

#[derive(thiserror::Error, Debug)]
pub enum ShipperError {
    #[error("Config error: {0}")]
    Config(String),
    #[error("Watcher error: {0}")]
    Watcher(#[from] notify::Error),
    #[error("Upload error: {0}")]
    Upload(#[from] UploadError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Already stopped")]
    AlreadyStopped,
}

/// The chunk shipper — watches an outbox directory and uploads WAV chunks in order.
pub struct ChunkShipper {
    config: ShipperConfig,
    stop_tx: Option<mpsc::Sender<()>>,
}

impl ChunkShipper {
    pub fn new(config: ShipperConfig) -> Result<Self, ShipperError> {
        config.validate()?;
        Ok(Self {
            config,
            stop_tx: None,
        })
    }

    /// Start the shipper. Returns a receiver for events.
    pub async fn start(&mut self) -> Result<mpsc::Receiver<ShipperEvent>, ShipperError> {
        // Ensure outbox dir and failed subdir exist
        tokio::fs::create_dir_all(&self.config.outbox_dir).await?;
        tokio::fs::create_dir_all(self.config.outbox_dir.join("failed")).await?;

        let (event_tx, event_rx) = mpsc::channel::<ShipperEvent>(256);
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        self.stop_tx = Some(stop_tx);

        let mut outbox_watcher = OutboxWatcher::new(&self.config.outbox_dir)?;
        let config = self.config.clone();

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let bo = Backoff::new(config.initial_backoff_ms, config.max_backoff_ms);

            // Per-session ordered queue: session_id -> BTreeMap<sequence, path>
            let mut queues: HashMap<String, BTreeMap<u32, PathBuf>> = HashMap::new();
            // Next expected sequence per session
            let mut next_seq: HashMap<String, u32> = HashMap::new();

            loop {
                tokio::select! {
                    _ = stop_rx.recv() => {
                        info!("Shipper stopping");
                        break;
                    }
                    file = outbox_watcher.next_file() => {
                        let Some(path) = file else { break };

                        let Some((session_id, sequence)) = parse_chunk_filename(&path) else {
                            warn!("Could not parse chunk filename: {:?}", path);
                            continue;
                        };

                        info!(session_id, sequence, "Chunk detected");

                        // Insert into ordered queue
                        queues
                            .entry(session_id.clone())
                            .or_default()
                            .insert(sequence, path);

                        // Drain in-order chunks
                        let expected = next_seq.entry(session_id.clone()).or_insert(1);
                        while let Some(chunk_path) = queues
                            .get(&session_id)
                            .and_then(|q| q.get(expected).cloned())
                        {
                            let seq = *expected;
                            let ok = upload_with_retry(
                                &client,
                                &config,
                                &bo,
                                &session_id,
                                seq,
                                &chunk_path,
                                &event_tx,
                            )
                            .await;

                            if let Some(q) = queues.get_mut(&session_id) {
                                q.remove(&seq);
                            }

                            if ok {
                                *expected = seq + 1;
                            } else {
                                // Failed after max retries — skip to next
                                *expected = seq + 1;
                            }
                        }
                    }
                }
            }
        });

        Ok(event_rx)
    }

    /// Signal a session has ended.
    pub async fn signal_session_end(&self, session_id: &str) -> Result<(), ShipperError> {
        let client = reqwest::Client::new();
        upload::send_session_end(&client, &self.config.server_url, &self.config.api_key, session_id)
            .await?;
        Ok(())
    }

    /// Stop the shipper.
    pub async fn stop(&mut self) -> Result<(), ShipperError> {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(()).await;
            Ok(())
        } else {
            Err(ShipperError::AlreadyStopped)
        }
    }
}

/// Upload a chunk with exponential backoff retries.
/// Returns `true` on success, `false` if max retries exceeded.
async fn upload_with_retry(
    client: &reqwest::Client,
    config: &ShipperConfig,
    bo: &Backoff,
    session_id: &str,
    sequence: u32,
    chunk_path: &PathBuf,
    event_tx: &mpsc::Sender<ShipperEvent>,
) -> bool {
    for attempt in 0..=config.max_retries {
        match upload::upload_chunk(
            client,
            &config.server_url,
            &config.api_key,
            session_id,
            sequence,
            chunk_path,
        )
        .await
        {
            Ok(()) => {
                info!(sequence, "Chunk uploaded successfully");
                // Delete file on success
                let _ = tokio::fs::remove_file(chunk_path).await;
                let _ = event_tx
                    .send(ShipperEvent::ChunkUploaded {
                        path: chunk_path.clone(),
                        sequence,
                    })
                    .await;
                return true;
            }
            Err(e) => {
                warn!(attempt, sequence, error = %e, "Upload attempt failed");
                if attempt < config.max_retries {
                    let delay = bo.delay_ms(attempt);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }

    // Max retries exceeded — move to failed/
    error!(sequence, "Max retries exceeded, moving to failed/");
    let failed_dir = config.outbox_dir.join("failed");
    let _ = tokio::fs::create_dir_all(&failed_dir).await;
    if let Some(fname) = chunk_path.file_name() {
        let dest = failed_dir.join(fname);
        let _ = tokio::fs::rename(chunk_path, &dest).await;
    }

    let _ = event_tx
        .send(ShipperEvent::ChunkFailed {
            path: chunk_path.clone(),
            error: format!("Max retries ({}) exceeded", config.max_retries),
            retries: config.max_retries,
        })
        .await;

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_validation_rejects_empty_url() {
        let cfg = ShipperConfig {
            server_url: "".into(),
            api_key: "key".into(),
            outbox_dir: PathBuf::from("/tmp"),
            max_retries: 3,
            initial_backoff_ms: 1000,
            max_backoff_ms: 60000,
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn config_validation_rejects_zero_backoff() {
        let cfg = ShipperConfig {
            server_url: "http://localhost".into(),
            api_key: "key".into(),
            outbox_dir: PathBuf::from("/tmp"),
            max_retries: 3,
            initial_backoff_ms: 0,
            max_backoff_ms: 60000,
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn config_validation_rejects_invalid_backoff_range() {
        let cfg = ShipperConfig {
            server_url: "http://localhost".into(),
            api_key: "key".into(),
            outbox_dir: PathBuf::from("/tmp"),
            max_retries: 3,
            initial_backoff_ms: 5000,
            max_backoff_ms: 1000,
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn config_validation_accepts_valid() {
        let cfg = ShipperConfig {
            server_url: "http://localhost".into(),
            api_key: "key".into(),
            outbox_dir: PathBuf::from("/tmp"),
            max_retries: 10,
            initial_backoff_ms: 1000,
            max_backoff_ms: 60000,
        };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn sequence_ordering_btreemap() {
        // Verify BTreeMap gives us ordered iteration
        let mut q: BTreeMap<u32, PathBuf> = BTreeMap::new();
        q.insert(3, "chunk3.wav".into());
        q.insert(1, "chunk1.wav".into());
        q.insert(2, "chunk2.wav".into());

        let keys: Vec<u32> = q.keys().cloned().collect();
        assert_eq!(keys, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn shipper_new_validates_config() {
        let cfg = ShipperConfig {
            server_url: "".into(),
            api_key: "key".into(),
            outbox_dir: PathBuf::from("/tmp"),
            max_retries: 3,
            initial_backoff_ms: 1000,
            max_backoff_ms: 60000,
        };
        assert!(ChunkShipper::new(cfg).is_err());
    }

    #[tokio::test]
    async fn full_upload_flow() {
        use std::io::Write;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/chunk"))
            .respond_with(ResponseTemplate::new(200))
            .expect(2)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path().join("outbox");
        std::fs::create_dir_all(&outbox).unwrap();

        let cfg = ShipperConfig {
            server_url: server.uri(),
            api_key: "test-key".into(),
            outbox_dir: outbox.clone(),
            max_retries: 2,
            initial_backoff_ms: 100,
            max_backoff_ms: 500,
        };

        let mut shipper = ChunkShipper::new(cfg).unwrap();
        let mut events = shipper.start().await.unwrap();

        // Wait for watcher to be ready
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Write chunk 1
        let p1 = outbox.join("test-sess_chunk_0001.wav");
        {
            let mut f = std::fs::File::create(&p1).unwrap();
            f.write_all(b"RIFF....WAVEfmt data").unwrap();
        }

        // Write chunk 2
        let p2 = outbox.join("test-sess_chunk_0002.wav");
        {
            let mut f = std::fs::File::create(&p2).unwrap();
            f.write_all(b"RIFF....WAVEfmt data").unwrap();
        }

        // Wait for both to be uploaded (stability + upload time)
        let mut uploaded = Vec::new();
        let deadline = std::time::Duration::from_secs(10);
        while uploaded.len() < 2 {
            match tokio::time::timeout(deadline, events.recv()).await {
                Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
                    uploaded.push(sequence);
                }
                _ => break,
            }
        }

        assert_eq!(uploaded, vec![1, 2], "Chunks should be uploaded in order");

        // Files should be deleted after successful upload
        assert!(!p1.exists());
        assert!(!p2.exists());

        shipper.stop().await.unwrap();
    }

    #[tokio::test]
    async fn retry_then_fail() {
        use std::io::Write;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        // Always return 500
        Mock::given(method("POST"))
            .and(path("/audio/chunk"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path().join("outbox");
        std::fs::create_dir_all(&outbox).unwrap();

        let cfg = ShipperConfig {
            server_url: server.uri(),
            api_key: "test-key".into(),
            outbox_dir: outbox.clone(),
            max_retries: 1, // Only 1 retry = 2 total attempts
            initial_backoff_ms: 50,
            max_backoff_ms: 100,
        };

        let mut shipper = ChunkShipper::new(cfg).unwrap();
        let mut events = shipper.start().await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let p1 = outbox.join("sess_chunk_0001.wav");
        {
            let mut f = std::fs::File::create(&p1).unwrap();
            f.write_all(b"RIFF....WAVEfmt data").unwrap();
        }

        let deadline = std::time::Duration::from_secs(10);
        match tokio::time::timeout(deadline, events.recv()).await {
            Ok(Some(ShipperEvent::ChunkFailed { retries, .. })) => {
                assert_eq!(retries, 1);
            }
            other => panic!("Expected ChunkFailed, got {:?}", other),
        }

        // File should be moved to failed/
        assert!(!p1.exists());
        assert!(outbox.join("failed").join("sess_chunk_0001.wav").exists());

        shipper.stop().await.unwrap();
    }

    #[tokio::test]
    async fn session_end_flow() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/session-end"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let cfg = ShipperConfig {
            server_url: server.uri(),
            api_key: "test-key".into(),
            outbox_dir: tmp.path().to_path_buf(),
            max_retries: 3,
            initial_backoff_ms: 1000,
            max_backoff_ms: 60000,
        };

        let shipper = ChunkShipper::new(cfg).unwrap();
        shipper.signal_session_end("sess-1").await.unwrap();
    }

    #[tokio::test]
    async fn multi_chunk_ordering() {
        use std::io::Write;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/chunk"))
            .respond_with(ResponseTemplate::new(200))
            .expect(3)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path().join("outbox");
        std::fs::create_dir_all(&outbox).unwrap();

        let cfg = ShipperConfig {
            server_url: server.uri(),
            api_key: "test-key".into(),
            outbox_dir: outbox.clone(),
            max_retries: 2,
            initial_backoff_ms: 50,
            max_backoff_ms: 200,
        };

        let mut shipper = ChunkShipper::new(cfg).unwrap();
        let mut events = shipper.start().await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Write chunks out of order: 3, 1, 2
        for seq in [3, 1, 2] {
            let p = outbox.join(format!("sess_chunk_{:04}.wav", seq));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"RIFF....WAVEfmt data").unwrap();
            // Small delay between writes so watcher picks them up
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let mut uploaded = Vec::new();
        let deadline = std::time::Duration::from_secs(15);
        while uploaded.len() < 3 {
            match tokio::time::timeout(deadline, events.recv()).await {
                Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
                    uploaded.push(sequence);
                }
                _ => break,
            }
        }

        assert_eq!(uploaded, vec![1, 2, 3], "Chunks must be uploaded in sequence order");
        shipper.stop().await.unwrap();
    }
}
