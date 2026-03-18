//! Integration tests for shipper wiring in the tray app.
//!
//! These tests verify the shipper starts/stops correctly and can upload
//! chunks to a mock server via wiremock.

use shipper::{ChunkShipper, ShipperConfig, ShipperEvent};
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn test_shipper_config(server_url: &str, outbox_dir: PathBuf) -> ShipperConfig {
    ShipperConfig {
        server_url: server_url.to_string(),
        api_key: "test-key".to_string(),
        outbox_dir,
        max_retries: 2,
        initial_backoff_ms: 50,
        max_backoff_ms: 200,
    }
}

fn write_fake_wav(dir: &std::path::Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    let mut f = std::fs::File::create(&p).unwrap();
    // Minimal WAV header
    let header: [u8; 44] = [
        b'R', b'I', b'F', b'F', 36, 0, 0, 0, b'W', b'A', b'V', b'E', b'f', b'm', b't',
        b' ', 16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3E, 0, 0, 0, 0x7D, 0, 0, 2, 0, 16, 0,
        b'd', b'a', b't', b'a', 0, 0, 0, 0,
    ];
    f.write_all(&header).unwrap();
    p
}

#[tokio::test]
async fn shipper_starts_and_stops_with_empty_outbox() {
    let tmp = tempfile::tempdir().unwrap();
    let outbox = tmp.path().join("outbox");
    std::fs::create_dir_all(&outbox).unwrap();

    let server = MockServer::start().await;
    let cfg = test_shipper_config(&server.uri(), outbox);

    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let _events = shipper.start().await.unwrap();

    // Should be able to stop without panic
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn chunk_detected_and_uploaded_to_mock_server() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let outbox = tmp.path().join("outbox");
    std::fs::create_dir_all(&outbox).unwrap();

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Wait for watcher to be ready
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Write a chunk file
    write_fake_wav(&outbox, "test-session_chunk_0001.wav");

    // Wait for upload event
    let deadline = std::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, events.recv()).await {
        Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
            assert_eq!(sequence, 1);
        }
        other => panic!("Expected ChunkUploaded, got {:?}", other),
    }

    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn session_end_sent_to_mock_server() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/session-end"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let cfg = test_shipper_config(&server.uri(), tmp.path().to_path_buf());

    let shipper = ChunkShipper::new(cfg).unwrap();
    shipper
        .signal_session_end("test-session-123")
        .await
        .unwrap();

    // Wiremock will verify the mock was called exactly once
}

#[tokio::test]
async fn full_flow_capture_upload_session_end() {
    let server = MockServer::start().await;

    // Mock chunk upload endpoint
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .expect(2)
        .mount(&server)
        .await;

    // Mock session-end endpoint
    Mock::given(method("POST"))
        .and(path("/audio/session-end"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let outbox = tmp.path().join("outbox");
    std::fs::create_dir_all(&outbox).unwrap();

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Wait for watcher
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Simulate capture: write 2 chunks
    let session_id = "full-flow-sess";
    write_fake_wav(&outbox, &format!("{session_id}_chunk_0001.wav"));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    write_fake_wav(&outbox, &format!("{session_id}_chunk_0002.wav"));

    // Collect upload events
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
    assert_eq!(uploaded, vec![1, 2], "Both chunks should be uploaded in order");

    // Send session-end (simulating what tray does on stop)
    shipper.signal_session_end(session_id).await.unwrap();

    shipper.stop().await.unwrap();

    // Wiremock verifies all mocks were called the expected number of times
}

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

#[tokio::test]
async fn pre_existing_chunk_uploaded_on_startup() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let outbox = tmp.path().join("outbox");
    std::fs::create_dir_all(&outbox).unwrap();

    // Write chunk BEFORE starting shipper
    write_fake_wav(&outbox, "pre-session_chunk_0001.wav");

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Should detect and upload the pre-existing chunk
    let deadline = std::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, events.recv()).await {
        Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
            assert_eq!(sequence, 1);
        }
        other => panic!("Expected ChunkUploaded for pre-existing chunk, got {:?}", other),
    }

    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn pre_existing_and_new_chunks_both_uploaded_no_duplicates() {
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

    // Write chunk 1 BEFORE starting shipper
    write_fake_wav(&outbox, "dedup-session_chunk_0001.wav");

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Wait for watcher to be ready, then write chunk 2
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    write_fake_wav(&outbox, "dedup-session_chunk_0002.wav");

    // Collect upload events
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

    assert_eq!(uploaded, vec![1, 2], "Both pre-existing and new chunks should be uploaded in order");

    // Verify no duplicates — wiremock expect(2) enforces exactly 2 calls
    // Also check sequences are unique
    let unique: HashSet<u32> = uploaded.iter().cloned().collect();
    assert_eq!(unique.len(), uploaded.len(), "No duplicate uploads");

    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn shipper_config_built_from_tray_config() {
    // This tests the TrayConfig -> ShipperConfig conversion at the integration level.
    // TrayConfig is from the tray crate, we can't import it here directly since
    // it's a binary crate. But we can test the ShipperConfig validation.
    let cfg = ShipperConfig {
        server_url: "http://localhost:9000".to_string(),
        api_key: "key".to_string(),
        outbox_dir: PathBuf::from("/tmp/test"),
        max_retries: 3,
        initial_backoff_ms: 1000,
        max_backoff_ms: 30000,
    };
    assert!(cfg.validate().is_ok());
}
