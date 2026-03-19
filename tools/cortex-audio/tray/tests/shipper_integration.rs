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
    write_fake_wav(&outbox, "test-session_chunk-0000_1710700000.wav");

    // Wait for upload event
    let deadline = std::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, events.recv()).await {
        Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
            assert_eq!(sequence, 0);
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
    write_fake_wav(&outbox, &format!("{session_id}_chunk-0000_1710700000.wav"));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    write_fake_wav(&outbox, &format!("{session_id}_chunk-0001_1710700030.wav"));

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
    assert_eq!(uploaded, vec![0, 1], "Both chunks should be uploaded in order");

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
    write_fake_wav(&outbox, "pre-session_chunk-0000_1710700000.wav");

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Should detect and upload the pre-existing chunk
    let deadline = std::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, events.recv()).await {
        Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
            assert_eq!(sequence, 0);
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

    // Write chunk 0 BEFORE starting shipper
    write_fake_wav(&outbox, "dedup-session_chunk-0000_1710700000.wav");

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    // Wait for watcher to be ready, then write chunk 1
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    write_fake_wav(&outbox, "dedup-session_chunk-0001_1710700030.wav");

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

    assert_eq!(uploaded, vec![0, 1], "Both pre-existing and new chunks should be uploaded in order");

    // Verify no duplicates — wiremock expect(2) enforces exactly 2 calls
    // Also check sequences are unique
    let unique: HashSet<u32> = uploaded.iter().cloned().collect();
    assert_eq!(unique.len(), uploaded.len(), "No duplicate uploads");

    shipper.stop().await.unwrap();
}

// ---------------------------------------------------------------------------
// Helpers for multipart body inspection
// ---------------------------------------------------------------------------

fn extract_multipart_text_field(body: &[u8], field_name: &str) -> Option<String> {
    let body_str = String::from_utf8_lossy(body);
    let search = format!("name=\"{}\"", field_name);
    let pos = body_str.find(&search)?;
    let after_headers = body_str[pos..].find("\r\n\r\n")?;
    let value_start = pos + after_headers + 4;
    let value_end = body_str[value_start..].find("\r\n--")?;
    Some(body_str[value_start..value_start + value_end].to_string())
}

// ---------------------------------------------------------------------------
// Body assertion tests for integration context
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_body_contains_correct_session_id_and_sequence() {
    // Verify that when ChunkShipper uploads via watcher → upload pipeline,
    // the actual HTTP body contains the correct field values — not just that
    // the right number of calls were made.
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

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let session_id = "body-check-sess";
    write_fake_wav(&outbox, &format!("{session_id}_chunk-0000_1710700000.wav"));

    let deadline = std::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, events.recv()).await {
        Ok(Some(ShipperEvent::ChunkUploaded { sequence, .. })) => {
            assert_eq!(sequence, 0);
        }
        other => panic!("Expected ChunkUploaded, got {:?}", other),
    }

    // Now inspect the actual HTTP body
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body = &requests[0].body;

    let sid = extract_multipart_text_field(body, "session_id")
        .expect("multipart body must contain session_id");
    assert_eq!(sid, session_id, "session_id in body must match");

    let seq = extract_multipart_text_field(body, "sequence")
        .expect("multipart body must contain sequence");
    assert_eq!(seq, "0", "first chunk sequence must be 0");

    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn multi_chunk_upload_bodies_have_correct_sequences() {
    // Verify sequence values 0, 1, 2 in the actual multipart bodies
    // when ChunkShipper uploads multiple chunks through the full pipeline.
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

    let cfg = test_shipper_config(&server.uri(), outbox.clone());
    let mut shipper = ChunkShipper::new(cfg).unwrap();
    let mut events = shipper.start().await.unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let session_id = "multi-body-sess";
    for seq in 0..3u32 {
        write_fake_wav(
            &outbox,
            &format!("{}_chunk-{:04}_{}.wav", session_id, seq, 1710700000 + seq),
        );
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
    assert_eq!(uploaded, vec![0, 1, 2]);

    // Inspect all 3 request bodies
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3);

    for (i, req) in requests.iter().enumerate() {
        let body = &req.body;
        let sid = extract_multipart_text_field(body, "session_id")
            .unwrap_or_else(|| panic!("request {} must have session_id", i));
        assert_eq!(sid, session_id, "request {} session_id", i);

        let seq = extract_multipart_text_field(body, "sequence")
            .unwrap_or_else(|| panic!("request {} must have sequence", i));
        assert_eq!(
            seq,
            i.to_string(),
            "request {} sequence must be {}",
            i,
            i
        );
    }

    shipper.stop().await.unwrap();
}

#[tokio::test]
async fn session_end_body_contains_correct_session_id() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/session-end"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let cfg = test_shipper_config(&server.uri(), tmp.path().to_path_buf());

    let session_id = "end-body-check-sess";
    let shipper = ChunkShipper::new(cfg).unwrap();
    shipper.signal_session_end(session_id).await.unwrap();

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);

    let body_str = String::from_utf8_lossy(&requests[0].body);
    let parsed: serde_json::Value =
        serde_json::from_str(&body_str).expect("session-end body must be valid JSON");
    assert_eq!(
        parsed.get("session_id").and_then(|v| v.as_str()),
        Some(session_id),
        "session-end JSON must contain correct session_id"
    );
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
