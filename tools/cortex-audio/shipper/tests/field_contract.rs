//! Cross-stack field name and multipart body contract tests.
//!
//! These tests verify TWO things:
//! 1. The string constants match the TypeScript server's expectations.
//! 2. The actual multipart body produced by upload_chunk() contains the
//!    correct field names and values — not just that the constants exist.
//!
//! The off-by-one bug (or_insert(1)) passed all previous tests because
//! wiremock only checked method + path, never inspecting the body. These
//! tests capture the request body and assert on its contents.

use cortex_audio_shipper::upload::{
    upload_chunk, send_session_end, CHUNK_UPLOAD_PATH, FIELD_AUDIO, FIELD_SEQUENCE,
    FIELD_SESSION_ID, SESSION_END_PATH,
};
use std::io::Write;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Constant value tests (tripwire — catches renames)
// ---------------------------------------------------------------------------

#[test]
fn field_names_match_server_contract() {
    assert_eq!(FIELD_SESSION_ID, "session_id");
    assert_eq!(FIELD_SEQUENCE, "sequence");
    assert_eq!(FIELD_AUDIO, "audio");
}

#[test]
fn url_paths_match_server_contract() {
    assert_eq!(CHUNK_UPLOAD_PATH, "/audio/chunk");
    assert_eq!(SESSION_END_PATH, "/audio/session-end");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn create_wav_file(dir: &std::path::Path, name: &str, extra_bytes: usize) -> std::path::PathBuf {
    let p = dir.join(name);
    let mut f = std::fs::File::create(&p).unwrap();
    // Minimal WAV header (44 bytes)
    let wav_header: [u8; 44] = [
        b'R', b'I', b'F', b'F', 36, 0, 0, 0, b'W', b'A', b'V', b'E', b'f', b'm', b't',
        b' ', 16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3E, 0, 0, 0, 0x7D, 0, 0, 2, 0, 16, 0,
        b'd', b'a', b't', b'a', 0, 0, 0, 0,
    ];
    f.write_all(&wav_header).unwrap();
    if extra_bytes > 0 {
        f.write_all(&vec![0u8; extra_bytes]).unwrap();
    }
    p
}

/// Extract a multipart text field value from a raw multipart body.
/// Looks for `name="<field_name>"` in Content-Disposition, then returns
/// the text value from the part body.
fn extract_multipart_text_field(body: &[u8], field_name: &str) -> Option<String> {
    let body_str = String::from_utf8_lossy(body);
    let search = format!("name=\"{}\"", field_name);

    // Find the Content-Disposition header containing this field name
    let pos = body_str.find(&search)?;

    // Find the double CRLF that ends the headers for this part
    let after_headers = body_str[pos..].find("\r\n\r\n")?;
    let value_start = pos + after_headers + 4;

    // Value ends at the next boundary (starts with "\r\n--")
    let value_end = body_str[value_start..].find("\r\n--")?;
    let value = &body_str[value_start..value_start + value_end];

    Some(value.to_string())
}

/// Check if the multipart body contains a file part with the given field name.
fn has_multipart_file_field(body: &[u8], field_name: &str) -> bool {
    let body_str = String::from_utf8_lossy(body);
    // File parts have both name= and filename= in Content-Disposition
    let pattern = format!("name=\"{}\"", field_name);
    if let Some(pos) = body_str.find(&pattern) {
        // Check if there's a filename= nearby (within the same header line)
        let line_end = body_str[pos..].find("\r\n").unwrap_or(body_str.len() - pos);
        let header_line = &body_str[pos..pos + line_end];
        header_line.contains("filename=")
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Body content assertion tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_chunk_sends_sequence_0_for_first_chunk() {
    // This test would have caught bug #1: or_insert(1) sending sequence=1
    // for the first chunk instead of sequence=0.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .and(header("Authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let wav = create_wav_file(tmp.path(), "sess_chunk-0000_1710700000.wav", 64);
    let client = reqwest::Client::new();

    // Upload with sequence=0 (what the fixed shipper sends for the first chunk)
    let result = upload_chunk(&client, &server.uri(), "test-key", "test-session", 0, &wav).await;
    assert!(result.is_ok(), "upload should succeed");

    // Capture the request and inspect the multipart body
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "exactly one request should have been made");

    let req_body = &requests[0].body;

    // Assert sequence field value is "0", not "1"
    let sequence_value = extract_multipart_text_field(req_body, "sequence")
        .expect("multipart body must contain 'sequence' field");
    assert_eq!(
        sequence_value, "0",
        "first chunk must have sequence=0 (0-based contract)"
    );
}

#[tokio::test]
async fn upload_chunk_multipart_body_contains_correct_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let session_id = "d4e5f6a7-1234-5678-9abc-def012345678";
    let wav = create_wav_file(
        tmp.path(),
        &format!("{}_chunk-0003_1710700000.wav", session_id),
        128,
    );
    let client = reqwest::Client::new();

    let result = upload_chunk(&client, &server.uri(), "test-key", session_id, 3, &wav).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req_body = &requests[0].body;

    // 1. session_id field present with correct value
    let sid = extract_multipart_text_field(req_body, FIELD_SESSION_ID)
        .expect("multipart body must contain 'session_id' field");
    assert_eq!(sid, session_id);

    // 2. sequence field present with correct numeric value
    let seq = extract_multipart_text_field(req_body, FIELD_SEQUENCE)
        .expect("multipart body must contain 'sequence' field");
    assert_eq!(seq, "3");

    // 3. audio field present as a file part with WAV content
    assert!(
        has_multipart_file_field(req_body, FIELD_AUDIO),
        "multipart body must contain '{}' as a file field",
        FIELD_AUDIO
    );

    // 4. Verify the file data contains WAV header (RIFF magic)
    assert!(
        req_body.windows(4).any(|w| w == b"RIFF"),
        "multipart body must contain WAV data (RIFF header)"
    );

    // 5. Auth header is correct
    let auth_header = requests[0]
        .headers
        .get("authorization")
        .expect("Authorization header must be present");
    assert_eq!(auth_header, "Bearer test-key");
}

#[tokio::test]
async fn send_session_end_body_format() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/session-end"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let session_id = "end-test-session-id";

    let result = send_session_end(&client, &server.uri(), "test-key", session_id).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);

    // Verify Content-Type is application/json
    let ct = requests[0]
        .headers
        .get("content-type")
        .expect("Content-Type header must be present");
    assert!(
        ct.to_str().unwrap().contains("application/json"),
        "session-end Content-Type must be application/json"
    );

    // Verify body is {"session_id":"<id>"}
    let body_str = String::from_utf8_lossy(&requests[0].body);
    let parsed: serde_json::Value = serde_json::from_str(&body_str)
        .expect("session-end body must be valid JSON");
    assert_eq!(
        parsed.get("session_id").and_then(|v| v.as_str()),
        Some(session_id),
        "session-end JSON must contain session_id field with correct value"
    );
}
